/**
 * Does the resting book know where the price is going?
 *
 * Seven strategies have been measured and buried. Quotes, settlements, spot and
 * the tape are all exhausted. Depth is the last thing Kalshi publishes for free
 * that this app had never stored: not what a trade costs, but how much is
 * standing behind it.
 *
 * The hypothesis is the oldest one in microstructure. A book leaning heavily to
 * the bid is buyers queuing to be filled, and a queue is information the touch
 * price does not show. It is also a genuinely different claim from the flow
 * study, which asked about trades that already happened: this asks about orders
 * that have NOT happened and whose owners can cancel them for free. That
 * asymmetry is exactly why it might be information and exactly why it might be
 * theatre — a spoofed bid costs nothing and looks identical.
 *
 * TWO TESTS, DELIBERATELY SEPARATE
 *
 * The TICK test asks whether imbalance predicts the next minute's mid. It needs
 * only quotes and depth, so it produces a readable answer within an hour of the
 * recorder starting, and it is DIAGNOSTIC ONLY — a signal worth one cent cannot
 * be traded through a spread and a fee. Its job is to say whether there is any
 * signal at all before a day is spent waiting for the real one.
 *
 * The SETTLEMENT test is the money question: does imbalance predict the
 * residual, meaning the realised outcome minus what the book was already
 * quoting? Raw prediction is worthless here for the same reason it was in the
 * flow study — a heavy bid pushes the price up and the price already predicts
 * the outcome. Only the part the quote had NOT absorbed can be an edge.
 *
 * If the tick test is flat, the settlement test will be flat too and the wait is
 * pointless. If the tick test is strong and the settlement test is flat, the
 * signal exists and is smaller than the cost of acting on it — which has been
 * the finding every other time.
 *
 *   npx esbuild scripts/book.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/book.js
 *   node --max-old-space-size=4096 scripts/book.js [--ahead 60] [--horizon 10] [--within 3]
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
import { bookImbalance, type DepthPoint, type Level } from "../electron/engine/depth";

const argNum = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};

/** How far a quote may sit from the moment being priced. */
const QUOTE_TOLERANCE_MS = 45_000;

/** How far a depth snapshot may sit from the decision moment. */
const DEPTH_TOLERANCE_MS = 60_000;

const BUCKETS: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  { label: "asks stacked", lo: -1.001, hi: -0.5 },
  { label: "ask lean", lo: -0.5, hi: -0.15 },
  { label: "balanced", lo: -0.15, hi: 0.15 },
  { label: "bid lean", lo: 0.15, hi: 0.5 },
  { label: "bids stacked", lo: 0.5, hi: 1.001 },
];

function dir(): string {
  return path.join(process.env.APPDATA ?? ".", "ROM Trader");
}

const fee = (c: number): number => oneLotFeeCents(c, "cent");
const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const cents = (x: number): string => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

/**
 * Reads the depth log from the REAL data directory.
 *
 * Not `depth.loadDepth()`, which resolves through `dataDir()` — under the
 * electron stub these scripts run against, that points at a temp directory and
 * returns nothing at all, silently. The same trap ate a run of the backfill
 * script: an empty result from a file that plainly exists reads as "no data
 * yet" rather than "wrong directory".
 */
function loadDepthFile(): DepthPoint[] {
  const out: DepthPoint[] = [];
  for (const name of ["depth.1.jsonl", "depth.jsonl"]) {
    const p = path.join(dir(), name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { t: number; k: string; b: Level[]; a: Level[] };
        if (!r.k || !Number.isFinite(r.t)) continue;
        out.push({ ts: r.t, ticker: r.k, bids: r.b ?? [], asks: r.a ?? [] });
      } catch {
        // torn final line from a killed process
      }
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
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

interface Quote {
  ts: number;
  bid: number;
  ask: number;
  mid: number;
  closeMs: number;
}

/**
 * Every two-sided quote inside the window depth covers, per ticker, in time
 * order.
 *
 * Bounded by the depth recording's own span so the archive is not parsed for
 * days that no book was stored for — the depth file is the scarce side and
 * everything else is joined to it.
 */
async function collectQuotes(from: number, to: number): Promise<Map<string, Quote[]>> {
  const out = new Map<string, Quote[]>();
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
      if (scan.ts < from || scan.ts > to) continue;
      if (!Array.isArray(scan.markets)) continue;
      for (const m of scan.markets as KalshiMarket[]) {
        if (!(m.yes_bid > 0 && m.yes_ask > 0 && m.yes_ask < 100)) continue;
        const arr = out.get(m.ticker) ?? [];
        arr.push({
          ts: scan.ts,
          bid: m.yes_bid,
          ask: m.yes_ask,
          mid: (m.yes_bid + m.yes_ask) / 2,
          closeMs: (m.close_ts ?? 0) * 1000,
        });
        out.set(m.ticker, arr);
      }
    }
  }
  for (const arr of out.values()) arr.sort((a, b) => a.ts - b.ts);
  return out;
}

/** The quote nearest `ts`, or null when the recording has no coverage there. */
function quoteAt(series: Quote[], ts: number, tolerance = QUOTE_TOLERANCE_MS): Quote | null {
  if (series.length === 0) return null;
  let lo = 0;
  let hi = series.length - 1;
  let best: Quote | null = null;
  let bestGap = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const gap = Math.abs(series[mid].ts - ts);
    if (gap < bestGap) {
      bestGap = gap;
      best = series[mid];
    }
    if (series[mid].ts < ts) lo = mid + 1;
    else hi = mid - 1;
  }
  return best !== null && bestGap <= tolerance ? best : null;
}

function bucketFor(v: number): string | null {
  for (const b of BUCKETS) if (v >= b.lo && v < b.hi) return b.label;
  return null;
}

function clustered<T extends { event: string }>(rows: T[], values: number[]): [number, number] {
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

interface TickRow {
  event: string;
  imbalance: number;
  /** Mid move over the next `ahead` seconds, in cents. */
  move: number;
}

interface SettleRow {
  event: string;
  imbalance: number;
  bid: number;
  ask: number;
  mid: number;
  outcome: 0 | 1;
  residual: number;
}

function printBuckets<T extends { event: string; imbalance: number }>(
  rows: T[],
  values: number[],
  unit: (x: number) => string,
  heading: string,
): void {
  console.log(`\n  ${heading}\n`);
  console.log(
    `  ${"book".padEnd(14)} ${"n".padStart(6)} ${"ev".padStart(5)} ${"mean".padStart(9)} ${"clustered 95% CI".padStart(22)}`,
  );
  console.log(`  ${"-".repeat(14)} ${"-".repeat(6)} ${"-".repeat(5)} ${"-".repeat(9)} ${"-".repeat(22)}`);
  for (const b of BUCKETS) {
    const idx: number[] = [];
    rows.forEach((r, i) => {
      if (bucketFor(r.imbalance) === b.label) idx.push(i);
    });
    if (idx.length === 0) continue;
    const sub = idx.map((i) => rows[i]);
    const vals = idx.map((i) => values[i]);
    const mean = vals.reduce((a, c) => a + c, 0) / vals.length;
    const ci = clustered(sub, vals);
    console.log(
      `  ${b.label.padEnd(14)} ${String(idx.length).padStart(6)} ` +
        `${String(new Set(sub.map((r) => r.event)).size).padStart(5)} ` +
        `${unit(mean).padStart(9)} ${`[${unit(ci[0])}, ${unit(ci[1])}]`.padStart(22)}`,
    );
  }
}

async function main(): Promise<void> {
  const ahead = argNum("ahead", 60);
  const horizon = argNum("horizon", 10);
  const within = argNum("within", 3);

  const depth: DepthPoint[] = loadDepthFile();
  console.log(`\n=== Does the resting book know where the price is going? ===`);
  if (depth.length === 0) {
    console.log(
      `\n  No depth recorded yet. Start ROM Trader with passive recording on and\n` +
        `  give it an hour — the book cannot be backfilled, so there is nothing\n` +
        `  to measure until it accumulates.\n`,
    );
    return;
  }

  const from = depth[0].ts;
  const to = depth[depth.length - 1].ts;
  const hours = (to - from) / 3_600_000;
  console.log(
    `  ${depth.length.toLocaleString()} book snapshots · ` +
      `${new Set(depth.map((d) => d.ticker)).size.toLocaleString()} markets · ` +
      `${hours.toFixed(1)}h of recording`,
  );
  console.log(`  imbalance measured within ${within}c of each side's own touch\n`);

  process.stdout.write(`  streaming quotes over that window… `);
  const quotes = await collectQuotes(from - 60_000, to + ahead * 1000 + 60_000);
  console.log(`${quotes.size.toLocaleString()} markets quoted`);

  const settled = loadSettlements();

  // ------------------------------------------------------------- tick test
  const tick: TickRow[] = [];
  for (const d of depth) {
    const imbalance = bookImbalance(
      { bids: d.bids.map(([p, s]) => ({ priceCents: p, size: s })), asks: d.asks.map(([p, s]) => ({ priceCents: p, size: s })) },
      within,
    );
    if (imbalance === null) continue;
    const series = quotes.get(d.ticker);
    if (!series) continue;
    const now = quoteAt(series, d.ts);
    const later = quoteAt(series, d.ts + ahead * 1000);
    if (!now || !later || later.ts <= now.ts) continue;
    tick.push({ event: eventOf(d.ticker), imbalance, move: later.mid - now.mid });
  }

  console.log(`\n  ${"=".repeat(64)}`);
  console.log(`  TEST 1 — TICK (diagnostic only, not tradeable)`);
  console.log(`  ${"=".repeat(64)}`);
  if (tick.length === 0) {
    console.log(
      `\n    No snapshot had a quote both at its moment and ${ahead}s later.\n` +
        `    Depth and quotes are recorded on separate timers; give it longer.\n`,
    );
  } else {
    const events = new Set(tick.map((r) => r.event)).size;
    console.log(`\n    ${tick.length.toLocaleString()} snapshots · ${events.toLocaleString()} independent events`);
    printBuckets(
      tick,
      tick.map((r) => r.move),
      (x) => `${cents(x)}c`,
      `mid move over the next ${ahead}s`,
    );
    const bid = tick.filter((r) => r.imbalance >= 0.15);
    const ask = tick.filter((r) => r.imbalance <= -0.15);
    if (bid.length > 0 && ask.length > 0) {
      const mb = bid.reduce((a, r) => a + r.move, 0) / bid.length;
      const ma = ask.reduce((a, r) => a + r.move, 0) / ask.length;
      const cb = clustered(bid, bid.map((r) => r.move));
      const ca = clustered(ask, ask.map((r) => r.move));
      console.log(
        `\n    bid-heavy books moved ${cents(mb)}c, ask-heavy ${cents(ma)}c — ` +
          `a spread of ${(mb - ma).toFixed(2)}c`,
      );
      console.log(
        `    ${cb[0] > ca[1] ? "the intervals DO NOT overlap: there is a signal here" : "the intervals overlap, so this is not evidence"}`,
      );
      console.log(
        `\n    Even a real signal here is not money: crossing costs the spread\n` +
          `    plus a fee, so a move under about 3c is unreachable. This test only\n` +
          `    says whether test 2 is worth waiting for.`,
      );
    }
  }

  // -------------------------------------------------------- settlement test
  const rows: SettleRow[] = [];
  for (const d of depth) {
    const outcome = settled.get(d.ticker);
    if (outcome === undefined) continue;
    const series = quotes.get(d.ticker);
    if (!series?.length) continue;
    const closeMs = series[0].closeMs;
    if (!closeMs) continue;
    // One decision per market, at a fixed horizon — the same discipline the
    // calibration study uses, for the same reason: a market that stayed liquid
    // for hours must not outvote one that went quiet.
    const target = closeMs - horizon * 60_000;
    if (Math.abs(d.ts - target) > DEPTH_TOLERANCE_MS) continue;
    const q = quoteAt(series, d.ts);
    if (!q) continue;
    const imbalance = bookImbalance(
      { bids: d.bids.map(([p, s]) => ({ priceCents: p, size: s })), asks: d.asks.map(([p, s]) => ({ priceCents: p, size: s })) },
      within,
    );
    if (imbalance === null) continue;
    rows.push({
      event: eventOf(d.ticker),
      imbalance,
      bid: q.bid,
      ask: q.ask,
      mid: q.mid,
      outcome,
      residual: outcome - q.mid / 100,
    });
  }
  // One row per event-market: keep the snapshot closest to the horizon.
  const seen = new Set<string>();
  const unique = rows.filter((r) => {
    const k = `${r.event}:${r.mid}:${r.outcome}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  console.log(`\n  ${"=".repeat(64)}`);
  console.log(`  TEST 2 — SETTLEMENT (the money question)`);
  console.log(`  ${"=".repeat(64)}`);
  const events = new Set(unique.map((r) => r.event)).size;
  console.log(
    `\n    ${unique.length.toLocaleString()} markets · ${events.toLocaleString()} independent events`,
  );

  if (events < MIN_EVENTS_TO_SIZE) {
    console.log(
      `\n    Below the ${MIN_EVENTS_TO_SIZE}-event floor this app requires before sizing\n` +
        `    anything, so no verdict is offered. Depth only started recording\n` +
        `    ${hours.toFixed(1)}h ago and a market has to CLOSE after that to contribute an\n` +
        `    outcome. Leave the recorder running and re-run tomorrow.\n`,
    );
    return;
  }

  printBuckets(
    unique,
    unique.map((r) => r.residual),
    (x) => `${(x * 100).toFixed(1)}pp`,
    `residual — realised outcome minus what the book was quoting`,
  );

  console.log(
    `\n    The residual must RISE with bid pressure for depth to carry anything\n` +
      `    the quote had not already absorbed. A flat column means the touch had\n` +
      `    priced the queue, which is what an efficient book would do.\n`,
  );

  console.log(`  AFTER FEES — follow the book, or fade it?\n`);
  console.log(
    `  ${"threshold".padEnd(13)} ${"n".padStart(6)} ${"ev".padStart(5)} ${"follow".padStart(8)} ${"clustered 95% CI".padStart(22)}`,
  );
  console.log(`  ${"-".repeat(13)} ${"-".repeat(6)} ${"-".repeat(5)} ${"-".repeat(8)} ${"-".repeat(22)}`);

  const winners: string[] = [];
  const suppressed: string[] = [];
  for (const th of [0.15, 0.3, 0.5, 0.7]) {
    const acting = unique.filter((r) => Math.abs(r.imbalance) >= th);
    if (acting.length === 0) continue;
    const follow = acting.map((r) => {
      // Bid-heavy book -> buy YES at the ask; ask-heavy -> buy NO at its ask.
      if (r.imbalance > 0) return (r.outcome === 1 ? 100 : 0) - r.ask - fee(r.ask);
      const cost = 100 - r.bid;
      return (r.outcome === 0 ? 100 : 0) - cost - fee(cost);
    });
    const mean = follow.reduce((a, c) => a + c, 0) / acting.length;
    const ci = clustered(acting, follow);
    const nEv = new Set(acting.map((r) => r.event)).size;
    console.log(
      `  ${`|imb| >= ${th}`.padEnd(13)} ${String(acting.length).padStart(6)} ${String(nEv).padStart(5)} ` +
        `${cents(mean).padStart(8)} ${`[${cents(ci[0])}, ${cents(ci[1])}]`.padStart(22)}`,
    );
    // Same floor the sizer enforces: never dangle what the app would refuse.
    if (nEv < MIN_EVENTS_TO_SIZE) {
      if (ci[0] > 0) suppressed.push(`|imb| >= ${th}: cleared zero on only ${nEv} events`);
      continue;
    }
    if (ci[0] > 0) winners.push(`follow at |imb| >= ${th} (${cents(mean)}c, CI low ${cents(ci[0])}c)`);
  }

  console.log(`\n  ${"=".repeat(64)}`);
  for (const s of suppressed) console.log(`  SUPPRESSED  ${s}`);
  if (winners.length === 0) {
    console.log(
      `  VERDICT: the resting book adds nothing after fees.\n\n` +
        `  That closes the last free input Kalshi publishes. Quotes, settlements,\n` +
        `  spot, the tape and now depth have all been measured against event-\n` +
        `  clustered intervals and dumb baselines, and none of them pays.`,
    );
  } else {
    console.log(`  CANDIDATES — clustered interval entirely above zero:\n`);
    for (const w of winners) console.log(`    ${w}`);
    console.log(
      `\n  Not a finding yet. Re-run at other horizons and depths (--horizon 5 / 20,\n` +
        `  --within 1 / 5) and on a held-out stretch. Four thresholds were tried;\n` +
        `  one clearing zero is what noise produces.`,
    );
  }
  console.log(`  ${"=".repeat(64)}\n`);
}

void main();
