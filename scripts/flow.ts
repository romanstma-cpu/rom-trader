/**
 * Does order flow know something the ask does not?
 *
 * Six studies have now read this book and every one of them lost. All six read
 * the same thing: what the market was ASKING. The calibration study settled
 * that line of attack — the book is mispriced by up to ten points in places and
 * still not by enough to cover the spread and the fee.
 *
 * The tape is the one input in this app that has never been looked at. Kalshi
 * publishes completed trades with `taker_outcome_side`, which names the
 * AGGRESSOR: who crossed the spread, and in which direction. Quotes are
 * opinions and cost nothing to post; a trade is somebody spending money, and
 * the classic microstructure result is that aggressive flow carries information
 * that the resting book has not yet absorbed. If that holds here, it is a
 * genuinely different input rather than a seventh way of reading the same
 * number.
 *
 * THE MEASUREMENT, AND THE CONFOUND IT HAS TO SURVIVE
 *
 * Order-flow imbalance is (bought - sold) / (bought + sold) over a trailing
 * window, counted in contracts, from the taker's side. The naive test — does
 * positive imbalance predict YES — is worthless on its own, because heavy
 * buying pushes the price up and the price already predicts YES. Of course
 * flow "predicts" the outcome; it is most of what MADE the price.
 *
 * So the quantity measured here is the RESIDUAL: realised settlement rate minus
 * the probability the book was already quoting. If flow carries information the
 * ask has not absorbed, that residual moves with imbalance. If the book has
 * already priced the flow by the time ROM can see it — which is what an
 * efficient venue and a fifteen-second poll would both predict — the residual
 * is flat and the whole idea dies here.
 *
 * The mean quote is printed against every imbalance bucket so the confound
 * stays visible rather than being asserted away.
 *
 *   npx esbuild scripts/flow.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/flow.js
 *   node --max-old-space-size=4096 scripts/flow.js [--horizon 10] [--window 10] [--min 20]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { KalshiMarket } from "../electron/engine/kalshi";
import type { RecordedScan } from "../electron/engine/recorder";
import { BACKFILL_FILE, type Settlement } from "../electron/engine/settlements";
import { oneLotFeeCents } from "../electron/engine/fairvalue";
import { clusterBootstrapCI, eventOf, groupByEvent } from "../electron/engine/skill";
import { MIN_EVENTS_TO_SIZE } from "../electron/engine/sizing";

const argNum = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};

/** How far from the target horizon a recorded quote may sit and still count. */
const TOLERANCE_MS = 5 * 60_000;

/**
 * Imbalance buckets. Deliberately wide in the middle: a market with roughly
 * balanced flow is the null case and splitting it finely only invites a
 * spurious reading of noise around zero.
 */
const OFI_BUCKETS: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  { label: "sold hard", lo: -1.001, hi: -0.6 },
  { label: "sold", lo: -0.6, hi: -0.2 },
  { label: "balanced", lo: -0.2, hi: 0.2 },
  { label: "bought", lo: 0.2, hi: 0.6 },
  { label: "bought hard", lo: 0.6, hi: 1.001 },
];

interface Quote {
  close: number;
  target: number;
  offBy: number;
  bid: number;
  ask: number;
  outcome: 0 | 1;
}

interface Row {
  ticker: string;
  event: string;
  series: string;
  bid: number;
  ask: number;
  mid: number;
  bought: number;
  sold: number;
  trades: number;
  ofi: number;
  outcome: 0 | 1;
}

function dir(): string {
  return path.join(process.env.APPDATA ?? ".", "ROM Trader");
}

function loadSettlements(): Map<string, 0 | 1> {
  const map = new Map<string, 0 | 1>();
  for (const name of ["settlements.jsonl", BACKFILL_FILE]) {
    const p = path.join(dir(), name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as Settlement;
        const r = (s.result ?? "").trim().toLowerCase();
        if (r === "yes") map.set(s.ticker, 1);
        else if (r === "no") map.set(s.ticker, 0);
      } catch {
        // torn line
      }
    }
  }
  return map;
}

/** One two-sided quote per settled market, nearest the horizon. */
async function collectQuotes(
  settled: Map<string, 0 | 1>,
  horizonMs: number,
): Promise<Map<string, Quote>> {
  const best = new Map<string, Quote>();
  const files = fs
    .readdirSync(dir())
    .filter((f) => f === "scans.jsonl" || /^scans-archive-.*\.jsonl$/.test(f))
    .map((f) => path.join(dir(), f));

  for (const file of files) {
    const rl = readline.createInterface({
      input: fs.createReadStream(file),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let scan: RecordedScan;
      try {
        scan = JSON.parse(line) as RecordedScan;
      } catch {
        continue;
      }
      if (!Array.isArray(scan.markets)) continue;
      for (const m of scan.markets as KalshiMarket[]) {
        const outcome = settled.get(m.ticker);
        if (outcome === undefined) continue;
        if (!m.close_ts || m.close_ts <= 0) continue;
        if (!(m.yes_bid > 0 && m.yes_ask > 0 && m.yes_ask < 100)) continue;
        const close = m.close_ts * 1000;
        const target = close - horizonMs;
        const offBy = Math.abs(scan.ts - target);
        if (offBy > TOLERANCE_MS) continue;
        const prev = best.get(m.ticker);
        if (prev && prev.offBy <= offBy) continue;
        best.set(m.ticker, {
          close,
          target,
          offBy,
          bid: m.yes_bid,
          ask: m.yes_ask,
          outcome,
        });
      }
    }
  }
  return best;
}

interface FlowTally {
  bought: number;
  sold: number;
  trades: number;
}

/**
 * Aggressive volume in the window ending at each market's decision moment.
 *
 * Streamed because the tape is fifty megabytes and only two counters per market
 * survive the pass. Block trades are excluded: they are matched off-book and
 * never crossed a spread, so they carry no aggression and would dilute the very
 * quantity being measured.
 */
async function collectFlow(
  quotes: Map<string, Quote>,
  windowMs: number,
): Promise<Map<string, FlowTally>> {
  const tally = new Map<string, FlowTally>();
  const p = path.join(dir(), "tape.jsonl");
  if (!fs.existsSync(p)) return tally;

  const seen = new Set<string>();
  const rl = readline.createInterface({
    input: fs.createReadStream(p),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let r: { i: string; k: string; t: number; p: number; c: number; s: number; b?: number };
    try {
      r = JSON.parse(line) as typeof r;
    } catch {
      continue;
    }
    const q = quotes.get(r.k);
    if (!q) continue;
    if (r.t > q.target || r.t < q.target - windowMs) continue;
    // Overlapping polls re-deliver the same second; the recorder appends and
    // dedupes on read, so this pass has to as well or busy markets get their
    // flow double-counted exactly where the signal is supposed to live.
    if (seen.has(r.i)) continue;
    seen.add(r.i);
    const t = tally.get(r.k) ?? { bought: 0, sold: 0, trades: 0 };
    if (r.s) t.sold += r.c;
    else t.bought += r.c;
    t.trades++;
    tally.set(r.k, t);
  }
  return tally;
}

const fee = (c: number): number => oneLotFeeCents(c, "cent");

function yesPnl(r: Row): number {
  return (r.outcome === 1 ? 100 : 0) - r.ask - fee(r.ask);
}
function noPnl(r: Row): number {
  const cost = 100 - r.bid;
  return (r.outcome === 0 ? 100 : 0) - cost - fee(cost);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function cents(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
}

function clusteredMean(rows: Row[], values: number[]): [number, number] {
  return clusterBootstrapCI(
    groupByEvent(rows, (r) => r.event),
    (idx) => {
      let s = 0;
      for (const i of idx) s += values[i];
      return s / idx.length;
    },
    3000,
  );
}

async function main(): Promise<void> {
  const horizon = argNum("horizon", 10);
  const window = argNum("window", 10);
  const minContracts = argNum("min", 20);

  const settled = loadSettlements();
  console.log(`\n=== Does order flow know something the ask does not? ===`);
  console.log(`  ${settled.size.toLocaleString()} settled markets on record`);
  console.log(
    `  decision ${horizon} min before close · flow measured over the ${window} min before that\n`,
  );

  process.stdout.write(`  streaming recorded sweeps for quotes… `);
  const quotes = await collectQuotes(settled, horizon * 60_000);
  console.log(`${quotes.size.toLocaleString()} markets quoted`);

  process.stdout.write(`  streaming the tape… `);
  const flow = await collectFlow(quotes, window * 60_000);
  console.log(`${flow.size.toLocaleString()} of them traded in the window`);

  const rows: Row[] = [];
  let tooThin = 0;
  for (const [ticker, q] of quotes) {
    const t = flow.get(ticker);
    if (!t) continue;
    const total = t.bought + t.sold;
    if (total < minContracts) {
      tooThin++;
      continue;
    }
    rows.push({
      ticker,
      event: eventOf(ticker),
      series: ticker.split("-")[0] ?? "?",
      bid: q.bid,
      ask: q.ask,
      mid: (q.bid + q.ask) / 2,
      bought: t.bought,
      sold: t.sold,
      trades: t.trades,
      ofi: (t.bought - t.sold) / total,
      outcome: q.outcome,
    });
  }

  const events = new Set(rows.map((r) => r.event)).size;
  console.log(`  ${tooThin.toLocaleString()} dropped for under ${minContracts} contracts traded`);
  console.log(
    `\n  USABLE: ${rows.length.toLocaleString()} markets · ` +
      `${events.toLocaleString()} independent events\n`,
  );

  if (rows.length === 0) {
    console.log(`  Nothing to measure. The tape and the scan record may not overlap yet.\n`);
    return;
  }
  if (events < 20) {
    console.log(
      `  WARNING: ${events} independent events is below the threshold this app\n` +
        `  uses to size anything. Read the table as a dry run of the arithmetic.\n`,
    );
  }

  // ---------------------------------------------- does flow predict the RESIDUAL
  console.log(`  RESIDUAL BY IMBALANCE — what the book had not already priced\n`);
  console.log(
    `  ${"flow".padEnd(12)} ${"n".padStart(5)} ${"ev".padStart(4)} ${"mid".padStart(6)} ` +
      `${"settled".padStart(8)} ${"residual".padStart(9)} ${"clustered 95% CI".padStart(20)}`,
  );
  console.log(
    `  ${"-".repeat(12)} ${"-".repeat(5)} ${"-".repeat(4)} ${"-".repeat(6)} ${"-".repeat(8)} ${"-".repeat(9)} ${"-".repeat(20)}`,
  );

  for (const b of OFI_BUCKETS) {
    const inB = rows.filter((r) => r.ofi >= b.lo && r.ofi < b.hi);
    if (inB.length === 0) continue;
    const resid = inB.map((r) => r.outcome - r.mid / 100);
    const meanResid = resid.reduce((a, c) => a + c, 0) / inB.length;
    const ci = clusteredMean(inB, resid);
    console.log(
      `  ${b.label.padEnd(12)} ${String(inB.length).padStart(5)} ` +
        `${String(new Set(inB.map((r) => r.event)).size).padStart(4)} ` +
        `${`${(inB.reduce((a, r) => a + r.mid, 0) / inB.length).toFixed(1)}c`.padStart(6)} ` +
        `${pct(inB.filter((r) => r.outcome === 1).length / inB.length).padStart(8)} ` +
        `${`${meanResid >= 0 ? "+" : ""}${(meanResid * 100).toFixed(1)}pp`.padStart(9)} ` +
        `${`[${(ci[0] * 100).toFixed(1)}, ${(ci[1] * 100).toFixed(1)}]`.padStart(20)}`,
    );
  }

  console.log(
    `\n    "residual" is realised minus what the book was quoting. Flow only\n` +
      `    carries new information if this column RISES with buying pressure.\n` +
      `    A flat column means the ask had already absorbed the flow — which is\n` +
      `    what an efficient book and a 15s poll would both predict.\n`,
  );

  // The crisp version of the same question, as one number.
  {
    const bought = rows.filter((r) => r.ofi >= 0.2);
    const sold = rows.filter((r) => r.ofi <= -0.2);
    if (bought.length > 0 && sold.length > 0) {
      const rb = bought.map((r) => r.outcome - r.mid / 100);
      const rs = sold.map((r) => r.outcome - r.mid / 100);
      const mb = rb.reduce((a, c) => a + c, 0) / rb.length;
      const ms = rs.reduce((a, c) => a + c, 0) / rs.length;
      const cb = clusteredMean(bought, rb);
      const cs = clusteredMean(sold, rs);
      console.log(`  THE SPREAD BETWEEN THE TAILS\n`);
      console.log(
        `    bought (OFI >= +0.2): residual ${`${(mb * 100).toFixed(1)}pp`.padStart(7)}  ` +
          `CI [${(cb[0] * 100).toFixed(1)}, ${(cb[1] * 100).toFixed(1)}]  n=${bought.length}`,
      );
      console.log(
        `    sold   (OFI <= -0.2): residual ${`${(ms * 100).toFixed(1)}pp`.padStart(7)}  ` +
          `CI [${(cs[0] * 100).toFixed(1)}, ${(cs[1] * 100).toFixed(1)}]  n=${sold.length}`,
      );
      console.log(
        `    difference: ${((mb - ms) * 100).toFixed(1)}pp — ` +
          `${cb[0] > cs[1] ? "the intervals DO NOT overlap" : "the intervals overlap, so this is not evidence"}\n`,
      );
    }
  }

  // ------------------------------------------------------------ is it money
  console.log(`  AFTER FEES — follow the flow, or fade it?\n`);
  console.log(
    `  ${"threshold".padEnd(11)} ${"trades".padStart(7)} ${"ev".padStart(4)} ` +
      `${"follow".padStart(8)} ${"clustered 95% CI".padStart(20)} ${"fade".padStart(8)}`,
  );
  console.log(
    `  ${"-".repeat(11)} ${"-".repeat(7)} ${"-".repeat(4)} ${"-".repeat(8)} ${"-".repeat(20)} ${"-".repeat(8)}`,
  );

  const winners: string[] = [];
  const suppressed: string[] = [];
  for (const th of [0.1, 0.2, 0.35, 0.5, 0.7]) {
    const acting = rows.filter((r) => Math.abs(r.ofi) >= th);
    if (acting.length === 0) continue;
    // Follow: buy the side the aggressors were taking. Fade: the opposite.
    const follow = acting.map((r) => (r.ofi > 0 ? yesPnl(r) : noPnl(r)));
    const fade = acting.map((r) => (r.ofi > 0 ? noPnl(r) : yesPnl(r)));
    const fm = follow.reduce((a, c) => a + c, 0) / acting.length;
    const fd = fade.reduce((a, c) => a + c, 0) / acting.length;
    const fci = clusteredMean(acting, follow);
    const dci = clusteredMean(acting, fade);
    console.log(
      `  ${`|OFI| >= ${th}`.padEnd(11)} ${String(acting.length).padStart(7)} ` +
        `${String(new Set(acting.map((r) => r.event)).size).padStart(4)} ` +
        `${cents(fm).padStart(8)} ${`[${cents(fci[0])}, ${cents(fci[1])}]`.padStart(20)} ` +
        `${cents(fd).padStart(8)}`,
    );
    // A candidate has to clear the SAME gate sizing.ts enforces before it may
    // reach an order. Reporting a band that clears zero on twelve events would
    // dangle something the rest of the app would refuse to trade, and this
    // sweep tries sixty combinations — five thresholds, two directions, six
    // parameter sets — so at 95% confidence roughly three false positives are
    // the expected yield of pure noise.
    const nEvents = new Set(acting.map((r) => r.event)).size;
    if (nEvents < MIN_EVENTS_TO_SIZE) {
      if (fci[0] > 0 || dci[0] > 0) {
        suppressed.push(
          `|OFI| >= ${th}: an interval cleared zero on only ${nEvents} events — below the ${MIN_EVENTS_TO_SIZE} this app requires`,
        );
      }
      continue;
    }
    if (fci[0] > 0) winners.push(`follow at |OFI| >= ${th} (${cents(fm)}c, CI low ${cents(fci[0])}c)`);
    if (dci[0] > 0) winners.push(`fade at |OFI| >= ${th} (${cents(fd)}c, CI low ${cents(dci[0])}c)`);
  }

  // --------------------------------------------------------------- by series
  const bySeries = new Map<string, Row[]>();
  for (const r of rows) {
    const arr = bySeries.get(r.series);
    if (arr) arr.push(r);
    else bySeries.set(r.series, [r]);
  }
  const big = [...bySeries.entries()].filter(([, v]) => v.length >= 10);
  if (big.length > 0) {
    console.log(`\n  BY SERIES (10+ markets, |OFI| >= 0.2)\n`);
    console.log(
      `  ${"series".padEnd(16)} ${"n".padStart(5)} ${"ev".padStart(4)} ${"residual".padStart(9)} ${"follow".padStart(8)}`,
    );
    console.log(`  ${"-".repeat(16)} ${"-".repeat(5)} ${"-".repeat(4)} ${"-".repeat(9)} ${"-".repeat(8)}`);
    for (const [s, all] of big) {
      const acting = all.filter((r) => Math.abs(r.ofi) >= 0.2);
      if (acting.length === 0) continue;
      const resid = acting.reduce((a, r) => a + (r.outcome - r.mid / 100), 0) / acting.length;
      const f = acting.reduce((a, r) => a + (r.ofi > 0 ? yesPnl(r) : noPnl(r)), 0) / acting.length;
      console.log(
        `  ${s.padEnd(16)} ${String(acting.length).padStart(5)} ` +
          `${String(new Set(acting.map((r) => r.event)).size).padStart(4)} ` +
          `${`${resid >= 0 ? "+" : ""}${(resid * 100).toFixed(1)}pp`.padStart(9)} ${cents(f).padStart(8)}`,
      );
    }
  }

  // ------------------------------------------------------------------ verdict
  console.log(`\n  ${"=".repeat(62)}`);
  for (const s of suppressed) console.log(`  SUPPRESSED  ${s}`);
  if (suppressed.length > 0) console.log("");
  if (winners.length === 0) {
    console.log(
      `  VERDICT: the tape adds nothing at this resolution.\n\n` +
        `  No threshold, followed or faded, has a clustered interval above zero\n` +
        `  on enough independent events to act on. Aggressive flow is visible in\n` +
        `  the price by the time a 15-second poll can see it, which is what an\n` +
        `  efficient book would do. That exhausts the free inputs this app\n` +
        `  records: quotes, settlements, spot and now the tape.`,
    );
  } else {
    console.log(`  CANDIDATES — clustered interval entirely above zero:\n`);
    for (const w of winners) console.log(`    ${w}`);
    console.log(
      `\n  Not a finding yet. Re-run at other horizons and windows\n` +
        `  (--horizon 5 / 20, --window 5 / 20) and on a held-out stretch of the\n` +
        `  tape. A signal that only survives one parameter set is a coincidence,\n` +
        `  and with five thresholds tried, one clearing zero is expected.`,
    );
  }
  console.log(`  ${"=".repeat(62)}\n`);
}

void main();
