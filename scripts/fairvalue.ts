/**
 * Does a fair-value model beat the Kalshi book?
 *
 * Every strategy this app has measured reads the contract's own price. All of
 * them lose: momentum by less than the fee, resting bids by twelve points of
 * adverse selection, the favourite band by more than it costs to buy. What
 * none of them ever did was look at BTC.
 *
 * A ladder strike resolves on the underlying, so given spot, realized
 * volatility and the minutes left there is a computable probability — and if
 * that probability beats the ask by more than the taker fee, the difference is
 * an edge that needs no view on direction. This asks whether it does, on ROM's
 * own recorded quotes and Kalshi's own recorded settlements.
 *
 * Spot is backfilled from Coinbase, which serves ~350 one-minute candles per
 * request, so this can be run against settlements that have ALREADY happened
 * rather than waiting for the recorder to accumulate. The sigma attached to
 * each minute is computed only from closes at or before it — using later
 * candles to price an earlier decision would be measuring hindsight, which is
 * the single easiest way to manufacture an edge that is not there.
 *
 *   npx esbuild scripts/fairvalue.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/fairvalue.js
 *   node scripts/fairvalue.js [--in <scans.jsonl>] [--minedge 2]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { KalshiMarket } from "../electron/engine/kalshi";
import type { RecordedScan } from "../electron/engine/recorder";
import type { Settlement } from "../electron/engine/settlements";
import { modelEdgeNetCents, settlementUpProb, wilsonLowerBound } from "../electron/engine/fairvalue";
import { TRACKED, assetForTicker, fetchCandles, type SpotPoint } from "../electron/engine/spot";

const argStr = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
};
const argNum = (name: string, fallback: number): number => {
  const v = Number(argStr(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
};

function loadScans(file: string): RecordedScan[] {
  const out: RecordedScan[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as RecordedScan;
      if (Array.isArray(s.markets) && s.markets.length) out.push(s);
    } catch {
      // torn final line
    }
  }
  return out;
}

function loadSettlements(file: string): Map<string, "yes" | "no"> {
  const map = new Map<string, "yes" | "no">();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as Settlement;
      const r = (s.result ?? "").trim().toLowerCase();
      if (r === "yes" || r === "no") map.set(s.ticker, r);
    } catch {
      // partial line
    }
  }
  return map;
}

/** KXBTCD-26AUG2621-T78899.99 -> strike 78899.99, when it is a threshold market. */
function strikeOf(ticker: string): number | null {
  const i = ticker.lastIndexOf("-");
  if (i <= 0) return null;
  const m = ticker.slice(i + 1).match(/^T([\d.]+)$/i);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/** Nearest recorded spot point at or before `ts`, per asset. */
function spotAt(series: SpotPoint[], ts: number): SpotPoint | null {
  let lo = 0;
  let hi = series.length - 1;
  let best: SpotPoint | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].ts <= ts) {
      best = series[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  // A quote priced against spot from twenty minutes ago is not a fair-value
  // test, it is a stale-data test.
  if (!best || ts - best.ts > 5 * 60_000) return null;
  return best;
}

interface Candidate {
  ts: number;
  ticker: string;
  asset: string;
  modelProb: number;
  side: "yes" | "no";
  askCents: number;
  netEdge: number;
  minsLeft: number;
  won: boolean;
}

async function main(): Promise<void> {
  const dir = path.join(process.env.APPDATA ?? ".", "ROM Trader");
  const scanFile = argStr("in", path.join(dir, "scans.jsonl"));
  const settleFile = argStr("settle", path.join(dir, "settlements.jsonl"));
  const minEdge = argNum("minedge", 2);
  const minProb = argNum("minprob", 0.9);

  const scans = loadScans(scanFile);
  const settled = loadSettlements(settleFile);
  if (scans.length === 0) {
    console.log(`No scans in ${scanFile}`);
    return;
  }

  console.log(`\n=== Does a fair-value model beat the book? ===`);
  console.log(
    `  ${path.basename(scanFile)} · ${scans.length.toLocaleString()} scans · ` +
      `${settled.size.toLocaleString()} recorded settlements\n`,
  );

  // Backfill spot for every tracked asset.
  process.stdout.write("  fetching spot candles… ");
  const byAsset = new Map<string, SpotPoint[]>();
  for (const t of TRACKED) {
    try {
      byAsset.set(t.asset, await fetchCandles(t.product, t.asset));
    } catch (e) {
      console.log(`\n  ${t.asset}: ${(e as Error).message}`);
    }
  }
  const covered = [...byAsset.entries()].map(([a, p]) => `${a}:${p.length}`).join(" ");
  console.log(`${covered}`);
  const spotStart = Math.min(...[...byAsset.values()].filter((p) => p.length).map((p) => p[0].ts));
  console.log(`  spot history reaches back to ${new Date(spotStart).toISOString().slice(0, 16)}\n`);

  // ------------------------------------------------------------- evaluate
  const candidates: Candidate[] = [];
  let considered = 0;
  let noStrike = 0;
  let noSpot = 0;
  let noSettlement = 0;

  for (const scan of scans) {
    if (scan.ts < spotStart) continue;
    for (const m of scan.markets as KalshiMarket[]) {
      const asset = assetForTicker(m.ticker);
      if (!asset) continue;
      const strike = strikeOf(m.ticker);
      if (strike === null) {
        noStrike++;
        continue;
      }
      const series = byAsset.get(asset);
      if (!series?.length) continue;
      const sp = spotAt(series, scan.ts);
      if (!sp || sp.sigma === null) {
        noSpot++;
        continue;
      }
      if (!m.close_ts) continue;
      const minsLeft = (m.close_ts * 1000 - scan.ts) / 60_000;
      if (minsLeft <= 0.5 || minsLeft > 60) continue;

      considered++;
      const p = settlementUpProb({ spot: sp.close, strike, sigma: sp.sigma, minsLeft });
      if (p === null) continue;

      const edge = modelEdgeNetCents({
        upProb: p,
        yesAskCents: m.yes_ask > 0 && m.yes_ask < 100 ? m.yes_ask : null,
        noAskCents: m.yes_bid > 0 && m.yes_bid < 100 ? 100 - m.yes_bid : null,
      });
      if (!edge || edge.netCents < minEdge) continue;

      const sideProb = edge.side === "yes" ? p : 1 - p;
      if (sideProb < minProb) continue;

      const outcome = settled.get(m.ticker);
      if (!outcome) {
        noSettlement++;
        continue;
      }
      candidates.push({
        ts: scan.ts,
        ticker: m.ticker,
        asset,
        modelProb: sideProb,
        side: edge.side,
        askCents: edge.askCents,
        netEdge: edge.netCents,
        minsLeft,
        won: (edge.side === "yes") === (outcome === "yes"),
      });
    }
  }

  console.log(`  ${considered.toLocaleString()} market-scans priced by the model`);
  console.log(
    `  filtered out: ${noStrike.toLocaleString()} without a parseable strike, ` +
      `${noSpot.toLocaleString()} without usable spot, ` +
      `${noSettlement.toLocaleString()} signals with no recorded outcome yet\n`,
  );

  if (candidates.length === 0) {
    console.log(
      `  NO SIGNALS cleared ${minEdge}c net edge at ${(minProb * 100).toFixed(0)}% model confidence\n` +
        `  with a recorded settlement. That is a result, not a failure: either the\n` +
        `  book is not mispriced by this much, or not enough of these markets have\n` +
        `  settled yet. Leave the recorder running and try again.\n`,
    );
    return;
  }

  // One signal per ticker — the same mispricing seen on forty consecutive
  // scans is one opportunity, not forty, and counting it forty times would
  // inflate both the sample and the confidence in it.
  const byTicker = new Map<string, Candidate>();
  for (const c of candidates) {
    const prev = byTicker.get(c.ticker);
    if (!prev || c.ts < prev.ts) byTicker.set(c.ticker, c);
  }
  const trades = [...byTicker.values()].sort((a, b) => a.ts - b.ts);

  const wins = trades.filter((t) => t.won).length;
  const rate = wins / trades.length;
  const bound = wilsonLowerBound(wins, trades.length);
  const pnl = trades.reduce(
    (s, t) => s + (t.won ? 100 - t.askCents : -t.askCents) - (t.netEdge >= 0 ? 1 : 1),
    0,
  );

  console.log(`  SIGNALS (first sighting per market, ${minEdge}c+ net edge, ${(minProb * 100).toFixed(0)}%+ model)\n`);
  console.log(`  distinct markets:  ${trades.length}`);
  console.log(`  model was right:   ${wins} (${(rate * 100).toFixed(1)}%)`);
  console.log(`  Wilson lower bound: ${(bound * 100).toFixed(1)}%  <- the number to judge on`);
  console.log(`  mean model prob:   ${((trades.reduce((s, t) => s + t.modelProb, 0) / trades.length) * 100).toFixed(1)}%`);
  console.log(`  mean ask paid:     ${(trades.reduce((s, t) => s + t.askCents, 0) / trades.length).toFixed(1)}c`);
  console.log(`  mean claimed edge: ${(trades.reduce((s, t) => s + t.netEdge, 0) / trades.length).toFixed(2)}c`);
  console.log(`  realised P&L:      ${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}c per contract, one lot each\n`);

  // Calibration is the honest test: if the model says 97% it should be right
  // about 97% of the time. A model that is right less often than it claims is
  // not a small problem, it is the whole problem.
  console.log(`  CALIBRATION — does the model's confidence mean anything?\n`);
  console.log(`  ${"model says".padEnd(14)} ${"n".padStart(5)} ${"actually won".padStart(14)} ${"gap".padStart(8)}`);
  console.log(`  ${"-".repeat(14)} ${"-".repeat(5)} ${"-".repeat(14)} ${"-".repeat(8)}`);
  for (const [lo, hi] of [[0.9, 0.95], [0.95, 0.98], [0.98, 0.995], [0.995, 1.001]]) {
    const bucket = trades.filter((t) => t.modelProb >= lo && t.modelProb < hi);
    if (bucket.length === 0) continue;
    const w = bucket.filter((t) => t.won).length;
    const actual = w / bucket.length;
    const claimed = bucket.reduce((s, t) => s + t.modelProb, 0) / bucket.length;
    console.log(
      `  ${`${(lo * 100).toFixed(1)}-${(hi * 100).toFixed(1)}%`.padEnd(14)} ${String(bucket.length).padStart(5)} ` +
        `${`${(actual * 100).toFixed(1)}%`.padStart(14)} ${`${((actual - claimed) * 100).toFixed(1)}pp`.padStart(8)}`,
    );
  }

  // Per asset, because one underlying carrying the whole result is the tell
  // for a fluke.
  console.log(`\n  BY UNDERLYING\n`);
  console.log(`  ${"asset".padEnd(7)} ${"n".padStart(5)} ${"won".padStart(7)} ${"P&L/ct".padStart(9)}`);
  console.log(`  ${"-".repeat(7)} ${"-".repeat(5)} ${"-".repeat(7)} ${"-".repeat(9)}`);
  for (const a of [...new Set(trades.map((t) => t.asset))]) {
    const rows = trades.filter((t) => t.asset === a);
    const w = rows.filter((t) => t.won).length;
    const p = rows.reduce((s, t) => s + (t.won ? 100 - t.askCents : -t.askCents) - 1, 0) / rows.length;
    console.log(
      `  ${a.padEnd(7)} ${String(rows.length).padStart(5)} ${`${((w / rows.length) * 100).toFixed(0)}%`.padStart(7)} ` +
        `${`${p >= 0 ? "+" : ""}${p.toFixed(1)}c`.padStart(9)}`,
    );
  }

  console.log(
    `\n  Judge this on the Wilson bound and the calibration gap, not the win rate.\n` +
      `  A model that claims 97% and delivers 80% is not a slightly worse model —\n` +
      `  it is priced for a certainty it does not have, and the losses come in the\n` +
      `  three percent it dismissed.\n`,
  );
}

void main();
