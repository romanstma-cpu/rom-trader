/**
 * Is the Kalshi book itself mispriced anywhere?
 *
 * Every study this app has run asked whether some IDEA beat the book. Five of
 * them have now been measured and killed. None of them asked the question
 * underneath: does the book have a systematic bias at all? If contracts quoted
 * at 90c settle 90% of the time in every band, there is nothing to find at
 * ROM's resolution and the honest answer to "make it profitable" is that it
 * cannot be — which is worth knowing before a sixth idea gets built.
 *
 * The bias worth looking for has a name. In almost every betting market ever
 * studied, longshots are overpriced and favourites underpriced: punters
 * overpay for the small chance of a big payout. If that holds here, the trade
 * needs no model — buy favourites, or sell longshots, and the edge is the bias
 * itself. If it does not hold, that is the end of the search.
 *
 * WHAT THIS TAKES CARE TO GET RIGHT
 *
 * One observation per market, at a fixed horizon before close. Using every
 * recorded quote would let a market that stayed liquid for six hours outvote
 * one that went quiet, and would count the same outcome hundreds of times.
 * Using the LAST quote before close biases toward the extremes, because a
 * market drifts toward 0 or 100 as it resolves. A fixed horizon gives a clean
 * cross-section that is comparable across markets.
 *
 * Intervals are event-clustered, for the reason `skill.ts` exists: a ladder of
 * strikes over one BTC hour is one trial. In a calibration study the effect is
 * severe, because the strikes of one event land in DIFFERENT price buckets —
 * one BTC move fills the 90c bucket with winners and the 10c bucket with
 * losers simultaneously, and nothing about that is independent evidence.
 *
 * Expected value is computed per row at the price actually quoted, net of the
 * one-lot fee, and never from the bucket's average. Averaging the price and
 * then pricing the average smooths away exactly the fee non-linearity that
 * decides whether a deep favourite is worth buying.
 *
 *   npx esbuild scripts/calibrate.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/calibrate.js
 *   node --max-old-space-size=4096 scripts/calibrate.js [--horizon 30] [--last]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { KalshiMarket } from "../electron/engine/kalshi";
import type { RecordedScan } from "../electron/engine/recorder";
import { BACKFILL_FILE, type Settlement } from "../electron/engine/settlements";
import { oneLotFeeCents } from "../electron/engine/fairvalue";
import { clusterBootstrapCI, eventOf, groupByEvent } from "../electron/engine/skill";

const argNum = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};
const argFlag = (name: string): boolean => process.argv.includes(`--${name}`);

/** How far from the target horizon an observation may sit and still count. */
const TOLERANCE_MS = 5 * 60_000;

/**
 * Price buckets, deliberately fine at both ends.
 *
 * The favourite-longshot bias lives in the tails, and a uniform 10c grid would
 * blur the 95-99c region — where the fee is largest relative to the payout —
 * into the same bucket as 90c.
 */
const BUCKETS: ReadonlyArray<{ lo: number; hi: number }> = [
  { lo: 1, hi: 5 },
  { lo: 5, hi: 10 },
  { lo: 10, hi: 20 },
  { lo: 20, hi: 30 },
  { lo: 30, hi: 40 },
  { lo: 40, hi: 50 },
  { lo: 50, hi: 60 },
  { lo: 60, hi: 70 },
  { lo: 70, hi: 80 },
  { lo: 80, hi: 90 },
  { lo: 90, hi: 95 },
  { lo: 95, hi: 100 },
];

interface Obs {
  ticker: string;
  event: string;
  series: string;
  bid: number;
  ask: number;
  mid: number;
  /** How far this observation sat from the requested horizon, ms. */
  offBy: number;
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
        // "scalar" and "void" are neither a win nor a loss; mapping them to
        // either would corrupt the very rate this study exists to measure.
        if (r === "yes") map.set(s.ticker, 1);
        else if (r === "no") map.set(s.ticker, 0);
      } catch {
        // torn line
      }
    }
  }
  return map;
}

/**
 * One quote per settled market, taken as close to the horizon as the recording
 * allows.
 *
 * Streamed rather than loaded, because the archive and the live log together
 * are around seventy megabytes of JSON and only one small object per market
 * survives the pass.
 */
async function collect(
  settled: Map<string, 0 | 1>,
  horizonMs: number,
  useLast: boolean,
): Promise<Obs[]> {
  const best = new Map<string, Obs>();
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
        // A one-sided book is not a price. The sweep filters these out
        // already, but the archive predates that guarantee.
        if (!(m.yes_bid > 0 && m.yes_ask > 0 && m.yes_ask < 100)) continue;

        const closeMs = m.close_ts * 1000;
        const target = useLast ? closeMs : closeMs - horizonMs;
        // The last quote BEFORE close, or the one nearest the horizon.
        if (useLast && scan.ts > closeMs) continue;
        const offBy = Math.abs(scan.ts - target);
        if (!useLast && offBy > TOLERANCE_MS) continue;

        const prev = best.get(m.ticker);
        if (prev && prev.offBy <= offBy) continue;
        best.set(m.ticker, {
          ticker: m.ticker,
          event: eventOf(m.ticker),
          series: m.ticker.split("-")[0] ?? "?",
          bid: m.yes_bid,
          ask: m.yes_ask,
          mid: (m.yes_bid + m.yes_ask) / 2,
          offBy,
          outcome,
        });
      }
    }
  }
  return [...best.values()];
}

const fee = (c: number): number => oneLotFeeCents(c, "cent");

/** Net cents from buying YES at the ask, one lot, fee included. */
function yesPnl(o: Obs): number {
  return (o.outcome === 1 ? 100 : 0) - o.ask - fee(o.ask);
}

/** Net cents from buying NO at its ask, one lot, fee included. */
function noPnl(o: Obs): number {
  const cost = 100 - o.bid;
  return (o.outcome === 0 ? 100 : 0) - cost - fee(cost);
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function cents(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
}

/** Cluster-bootstrapped mean of a per-row vector, grouped by event. */
function clusteredMean(rows: Obs[], values: number[]): [number, number] {
  const groups = groupByEvent(rows, (r) => r.event);
  return clusterBootstrapCI(
    groups,
    (idx) => {
      let s = 0;
      for (const i of idx) s += values[i];
      return s / idx.length;
    },
    3000,
  );
}

async function main(): Promise<void> {
  const horizon = argNum("horizon", 30);
  const useLast = argFlag("last");
  const settled = loadSettlements();

  console.log(`\n=== Is the Kalshi book mispriced anywhere? ===`);
  console.log(`  ${settled.size.toLocaleString()} settled markets on record`);
  console.log(
    `  quote taken ${useLast ? "at the LAST observation before close" : `${horizon} min before close (±5 min)`}\n`,
  );

  process.stdout.write(`  streaming recorded sweeps… `);
  const obs = await collect(settled, horizon * 60_000, useLast);
  console.log(`${obs.length.toLocaleString()} markets matched`);

  if (obs.length === 0) {
    console.log(`\n  No market had a two-sided quote at that horizon.\n`);
    return;
  }

  const events = new Set(obs.map((o) => o.event)).size;
  const yesRate = obs.filter((o) => o.outcome === 1).length / obs.length;
  console.log(`  ${events.toLocaleString()} independent events · ${pct(yesRate)} settled YES\n`);

  // ------------------------------------------------------- calibration table
  console.log(`  CALIBRATION — does a price mean what it says?\n`);
  console.log(
    `  ${"quoted".padEnd(9)} ${"n".padStart(5)} ${"ev".padStart(5)} ${"mid".padStart(6)} ` +
      `${"settled".padStart(8)} ${"gap".padStart(8)} ${"clustered 95% CI".padStart(20)}`,
  );
  console.log(`  ${"-".repeat(9)} ${"-".repeat(5)} ${"-".repeat(5)} ${"-".repeat(6)} ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(20)}`);

  const rowsFor = (lo: number, hi: number): Obs[] =>
    obs.filter((o) => o.mid >= lo && o.mid < hi);

  for (const b of BUCKETS) {
    const rows = rowsFor(b.lo, b.hi);
    if (rows.length === 0) continue;
    const outcomes = rows.map((r) => r.outcome as number);
    const meanMid = rows.reduce((s, r) => s + r.mid, 0) / rows.length;
    const realised = outcomes.reduce((a, c) => a + c, 0) / rows.length;
    const gapPp = (realised - meanMid / 100) * 100;
    const ci = clusteredMean(rows, outcomes);
    const nEvents = new Set(rows.map((r) => r.event)).size;
    console.log(
      `  ${`${b.lo}-${b.hi}c`.padEnd(9)} ${String(rows.length).padStart(5)} ` +
        `${String(nEvents).padStart(5)} ${`${meanMid.toFixed(1)}c`.padStart(6)} ` +
        `${pct(realised).padStart(8)} ${`${gapPp >= 0 ? "+" : ""}${gapPp.toFixed(1)}pp`.padStart(8)} ` +
        `${`[${pct(ci[0])}, ${pct(ci[1])}]`.padStart(20)}`,
    );
  }

  console.log(
    `\n    "gap" is realised minus quoted. Positive means the market settled YES\n` +
      `    more often than its price implied — YES was cheap in that band.\n` +
      `    A gap is only interesting if the clustered interval excludes the\n` +
      `    quoted price, and only tradeable if it survives the table below.\n`,
  );

  // --------------------------------------------------------------- is it money
  console.log(`  AFTER FEES — would buying that band have paid?\n`);
  console.log(
    `  ${"quoted".padEnd(9)} ${"n".padStart(5)} ${"buy YES".padStart(9)} ` +
      `${"clustered 95% CI".padStart(20)} ${"buy NO".padStart(9)} ${"clustered 95% CI".padStart(20)}`,
  );
  console.log(
    `  ${"-".repeat(9)} ${"-".repeat(5)} ${"-".repeat(9)} ${"-".repeat(20)} ${"-".repeat(9)} ${"-".repeat(20)}`,
  );

  const winners: string[] = [];
  for (const b of BUCKETS) {
    const rows = rowsFor(b.lo, b.hi);
    if (rows.length === 0) continue;
    const yv = rows.map(yesPnl);
    const nv = rows.map(noPnl);
    const ym = yv.reduce((a, c) => a + c, 0) / rows.length;
    const nm = nv.reduce((a, c) => a + c, 0) / rows.length;
    const yci = clusteredMean(rows, yv);
    const nci = clusteredMean(rows, nv);
    console.log(
      `  ${`${b.lo}-${b.hi}c`.padEnd(9)} ${String(rows.length).padStart(5)} ` +
        `${cents(ym).padStart(9)} ${`[${cents(yci[0])}, ${cents(yci[1])}]`.padStart(20)} ` +
        `${cents(nm).padStart(9)} ${`[${cents(nci[0])}, ${cents(nci[1])}]`.padStart(20)}`,
    );
    // A band only counts if the WHOLE clustered interval is above zero.
    if (yci[0] > 0) winners.push(`buy YES at ${b.lo}-${b.hi}c (${cents(ym)}c, CI low ${cents(yci[0])}c)`);
    if (nci[0] > 0) winners.push(`buy NO at ${b.lo}-${b.hi}c (${cents(nm)}c, CI low ${cents(nci[0])}c)`);
  }

  // ------------------------------------------------------------- by series
  console.log(`\n  BY SERIES (10+ markets)\n`);
  console.log(
    `  ${"series".padEnd(16)} ${"n".padStart(5)} ${"ev".padStart(5)} ${"YES rate".padStart(9)} ` +
      `${"buy YES".padStart(9)} ${"buy NO".padStart(9)}`,
  );
  console.log(`  ${"-".repeat(16)} ${"-".repeat(5)} ${"-".repeat(5)} ${"-".repeat(9)} ${"-".repeat(9)} ${"-".repeat(9)}`);
  const bySeries = new Map<string, Obs[]>();
  for (const o of obs) {
    const arr = bySeries.get(o.series);
    if (arr) arr.push(o);
    else bySeries.set(o.series, [o]);
  }
  const seriesRows = [...bySeries.entries()]
    .filter(([, rows]) => rows.length >= 10)
    .map(([s, rows]) => ({
      s,
      rows,
      y: rows.reduce((a, r) => a + yesPnl(r), 0) / rows.length,
      n: rows.reduce((a, r) => a + noPnl(r), 0) / rows.length,
    }))
    .sort((a, b) => Math.max(b.y, b.n) - Math.max(a.y, a.n));
  for (const r of seriesRows) {
    console.log(
      `  ${r.s.padEnd(16)} ${String(r.rows.length).padStart(5)} ` +
        `${String(new Set(r.rows.map((x) => x.event)).size).padStart(5)} ` +
        `${pct(r.rows.filter((x) => x.outcome === 1).length / r.rows.length).padStart(9)} ` +
        `${cents(r.y).padStart(9)} ${cents(r.n).padStart(9)}`,
    );
  }

  // ------------------------------------------------------------------ verdict
  console.log(`\n  ${"=".repeat(62)}`);
  if (winners.length === 0) {
    console.log(
      `  VERDICT: no band is profitable after fees.\n\n` +
        `  Not one price bucket, on either side, has a clustered interval that\n` +
        `  clears zero. The book prices these markets well enough that crossing\n` +
        `  the spread and paying the fee costs more than any bias is worth — at\n` +
        `  ROM's resolution there is nothing here to harvest, and a sixth\n` +
        `  strategy built on quotes alone would be a sixth way to pay the fee.`,
    );
  } else {
    console.log(`  CANDIDATE BANDS — clustered interval entirely above zero:\n`);
    for (const w of winners) console.log(`    ${w}`);
    console.log(
      `\n  Treat these as a hypothesis, not a finding. Re-run at a different\n` +
        `  horizon (--horizon 15, --horizon 60, --last) and on a held-out\n` +
        `  stretch of the archive: a band that only pays at one horizon is a\n` +
        `  coincidence with good manners.`,
    );
  }
  console.log(`  ${"=".repeat(62)}\n`);
}

void main();
