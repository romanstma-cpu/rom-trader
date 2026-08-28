/**
 * Does a fair-value model beat the Kalshi book?
 *
 * The first version of this study answered yes, and the answer was worthless.
 * It reported twenty-one wins from twenty-one signals and a Wilson lower bound
 * of 88.6%, on a sample where 95% of signals had been thrown away for lacking a
 * recorded outcome and where the surviving twenty-one came from a handful of
 * BTC hours. Three findings were tangled together and only one of them was
 * about the model:
 *
 *   1. Wilson assumes independent trials. A ladder of strikes over one BTC
 *      hour is ONE trial wearing a dozen coats — they settle together on the
 *      same path. The interval was narrowed by a sqrt(N) that was never earned.
 *
 *   2. 61% of the markets in this app's settlement record resolve NO. Any
 *      strategy that leans NO harvests that structural tilt and looks like a
 *      forecaster. Comparing a win rate to 50% compares it to a baseline
 *      nobody offers.
 *
 *   3. A 95% exclusion rate is not a filter, it is a different population.
 *
 * This version fixes all three. Intervals come from an event-clustered
 * bootstrap, so the denominator is events. Every number is reported beside the
 * same number computed with the model switched off — always-YES and always-NO
 * over the identical rows — and the difference is the only part that is about
 * the model. The exclusion rate is printed before any result, because a
 * flattering number computed on 5% of the data is not a smaller version of the
 * truth.
 *
 * Spot is backfilled from Coinbase (~350 one-minute candles per request), so
 * this runs against settlements that have already happened. The sigma attached
 * to each minute uses only closes at or before it; pricing an earlier decision
 * with later candles measures hindsight, which is the easiest way to invent an
 * edge that is not there.
 *
 *   npx esbuild scripts/fairvalue.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/fairvalue.js
 *   node scripts/fairvalue.js [--in <scans.jsonl>] [--minedge 2] [--minprob 0.9]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { KalshiMarket } from "../electron/engine/kalshi";
import type { RecordedScan } from "../electron/engine/recorder";
import { BACKFILL_FILE, type Settlement } from "../electron/engine/settlements";
import { modelEdgeNetCents, oneLotFeeCents, settlementUpProb } from "../electron/engine/fairvalue";
import {
  eventOf,
  skillReport,
  strategyTag,
  tagPerformance,
  type SkillReport,
  type SkillRow,
} from "../electron/engine/skill";
import { TRACKED, assetForTicker, fetchCandleHistory, type SpotPoint } from "../electron/engine/spot";

const argStr = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
};
const argNum = (name: string, fallback: number): number => {
  const v = Number(argStr(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
};

const fee = (priceCents: number): number => oneLotFeeCents(priceCents, "cent");

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

function loadSettlements(files: string[]): Map<string, "yes" | "no"> {
  const map = new Map<string, "yes" | "no">();
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as Settlement;
        const r = (s.result ?? "").trim().toLowerCase();
        // "scalar" and "void" appear in the record and are neither a win nor a
        // loss. Mapping them to either would quietly corrupt every rate below.
        if (r === "yes" || r === "no") map.set(s.ticker, r);
      } catch {
        // partial line
      }
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

/** Nearest recorded spot point at or before `ts`. */
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

interface Row extends SkillRow {
  ts: number;
  asset: string;
  claimedEdge: number;
  minsLeft: number;
  tag: string;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
function cents(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}c`;
}

/** One market-scan's worth of arithmetic, or null when it cannot be priced. */
function evaluate(
  m: KalshiMarket,
  scanTs: number,
  asset: string,
  sp: SpotPoint,
  outcome: "yes" | "no",
): Row | null {
  const strike = strikeOf(m.ticker);
  if (strike === null || sp.sigma === null || !m.close_ts) return null;
  const minsLeft = (m.close_ts * 1000 - scanTs) / 60_000;
  if (minsLeft <= 0.5 || minsLeft > 60) return null;

  const p = settlementUpProb({ spot: sp.close, strike, sigma: sp.sigma, minsLeft });
  if (p === null) return null;

  const yesAsk = m.yes_ask > 0 && m.yes_ask < 100 ? m.yes_ask : null;
  const noAsk = m.yes_bid > 0 && m.yes_bid < 100 ? 100 - m.yes_bid : null;
  if (yesAsk === null || noAsk === null) return null;

  const edge = modelEdgeNetCents({ upProb: p, yesAskCents: yesAsk, noAskCents: noAsk });
  if (!edge) return null;

  const side = edge.side;
  const cost = side === "yes" ? yesAsk : noAsk;
  const won = (side === "yes") === (outcome === "yes");
  const pnlCents = (won ? 100 : 0) - cost - fee(cost);

  // The book's own forecast is the mid, not the side we happen to be lifting —
  // scoring the market on the ask we chose to cross would credit the model for
  // the spread it paid.
  const marketProb = (m.yes_bid + m.yes_ask) / 200;

  return {
    ticker: m.ticker,
    event: eventOf(m.ticker),
    modelProb: p,
    marketProb,
    priceCents: cost,
    yesAskCents: yesAsk,
    noAskCents: noAsk,
    outcome: outcome === "yes" ? 1 : 0,
    side,
    pnlCents,
    ts: scanTs,
    asset,
    claimedEdge: edge.netCents,
    minsLeft,
    tag: strategyTag({ asset, side, edgeCents: edge.netCents, minsLeft }),
  };
}

/** One row per market — the same mispricing seen on forty scans is one chance. */
function firstSighting(rows: Row[]): Row[] {
  const byTicker = new Map<string, Row>();
  for (const r of rows) {
    const prev = byTicker.get(r.ticker);
    if (!prev || r.ts < prev.ts) byTicker.set(r.ticker, r);
  }
  return [...byTicker.values()].sort((a, b) => a.ts - b.ts);
}

function printReport(title: string, rep: SkillReport): void {
  console.log(`\n  ${title}`);
  console.log(`  ${"=".repeat(title.length)}\n`);
  if (rep.n === 0) {
    console.log(`    no rows\n`);
    return;
  }
  console.log(`    rows                ${rep.n.toLocaleString()}`);
  console.log(
    `    independent events  ${rep.events.toLocaleString()}` +
      `   <- the honest denominator`,
  );
  console.log(
    `    hit rate            ${pct(rep.hitRate)}  ` +
      `clustered 95% CI [${pct(rep.hitRateCI[0])}, ${pct(rep.hitRateCI[1])}]`,
  );
  console.log(
    `                            ` +
      `naive  95% CI [${pct(rep.hitRateNaiveCI[0])}, ${pct(rep.hitRateNaiveCI[1])}]  <- the wrong one`,
  );
  console.log(`    Brier model         ${rep.brierModel.toFixed(4)}`);
  console.log(`    Brier book          ${rep.brierMarket.toFixed(4)}`);
  console.log(
    `    skill vs book       ${pct(rep.skill)}  ` +
      `clustered 95% CI [${pct(rep.skillCI[0])}, ${pct(rep.skillCI[1])}]`,
  );
  console.log(`    P&L per contract    ${cents(rep.pnlPerContract)}\n`);

  console.log(`    the same rows with the model switched off:`);
  for (const b of rep.baselines) {
    const delta = rep.pnlPerContract - b.pnlPerContract;
    console.log(
      `      ${b.label.padEnd(12)} hit ${pct(b.hitRate).padStart(6)}  ` +
        `${cents(b.pnlPerContract).padStart(8)}   model beats it by ${cents(delta)}`,
    );
  }

  if (rep.bands.length > 0) {
    console.log(`\n    within each entry-price band (controls for buying favourites):`);
    console.log(
      `      ${"band".padEnd(9)} ${"n".padStart(6)} ${"model".padStart(9)} ` +
        `${"best dumb".padStart(10)} ${"delta".padStart(9)}`,
    );
    for (const b of rep.bands) {
      console.log(
        `      ${b.band.padEnd(9)} ${String(b.n).padStart(6)} ${cents(b.modelPnl).padStart(9)} ` +
          `${cents(b.baselinePnl).padStart(10)} ${cents(b.deltaCents).padStart(9)}`,
      );
    }
  }
  console.log(`\n    VERDICT: ${rep.verdict}\n`);
}

async function main(): Promise<void> {
  const dir = path.join(process.env.APPDATA ?? ".", "ROM Trader");
  const settleFiles = [path.join(dir, "settlements.jsonl"), path.join(dir, BACKFILL_FILE)];
  const minEdge = argNum("minedge", 2);
  const minProb = argNum("minprob", 0.9);
  const days = argNum("days", 6);

  // Default to every recorded sweep, archives included. The archive holds the
  // markets that have actually settled, which is the entire population worth
  // measuring; reading only the live file is how the last run ended up with
  // eight events.
  const explicit = argStr("in", "");
  const scanFiles = explicit
    ? [explicit]
    : fs
        .readdirSync(dir)
        .filter((f) => f === "scans.jsonl" || /^scans-archive-.*\.jsonl$/.test(f))
        .map((f) => path.join(dir, f));

  const scans: RecordedScan[] = [];
  for (const f of scanFiles) {
    if (fs.existsSync(f)) scans.push(...loadScans(f));
  }
  scans.sort((a, b) => a.ts - b.ts);
  const settled = loadSettlements(settleFiles);
  if (scans.length === 0) {
    console.log(`No scans found in ${dir}`);
    return;
  }

  console.log(`\n=== Does a fair-value model beat the book? ===`);
  console.log(
    `  ${scanFiles.map((f) => path.basename(f)).join(" + ")}\n` +
      `  ${scans.length.toLocaleString()} scans · ` +
      `${settled.size.toLocaleString()} recorded settlements\n`,
  );

  const sinceMs = Math.max(scans[0].ts - 60 * 60_000, Date.now() - days * 86_400_000);
  process.stdout.write(`  fetching ${days}d of spot candles (paged)… `);
  const byAsset = new Map<string, SpotPoint[]>();
  for (const t of TRACKED) {
    try {
      byAsset.set(t.asset, await fetchCandleHistory(t.product, t.asset, sinceMs));
    } catch (e) {
      console.log(`\n  ${t.asset}: ${(e as Error).message}`);
    }
  }
  console.log([...byAsset.entries()].map(([a, p]) => `${a}:${p.length}`).join(" "));
  const withData = [...byAsset.values()].filter((p) => p.length);
  if (withData.length === 0) {
    console.log(`  No spot history could be fetched — nothing can be priced.\n`);
    return;
  }
  const spotStart = Math.min(...withData.map((p) => p[0].ts));
  console.log(`  spot history reaches back to ${new Date(spotStart).toISOString().slice(0, 16)}\n`);

  // ----------------------------------------------------------------- evaluate
  const priced: Row[] = [];
  // Distinct MARKETS, not market-scans. The usable side of this ratio is
  // deduped to one row per ticker, so counting every sweep on the missing side
  // would compare a per-scan number against a per-market one and report an
  // exclusion rate inflated by however often each market happened to be
  // scanned — which is exactly the quantity the ratio is supposed to be
  // independent of.
  const missing = new Set<string>();

  for (const scan of scans) {
    if (scan.ts < spotStart) continue;
    for (const m of scan.markets as KalshiMarket[]) {
      const asset = assetForTicker(m.ticker);
      if (!asset) continue;
      const series = byAsset.get(asset);
      if (!series?.length) continue;
      const sp = spotAt(series, scan.ts);
      if (!sp) continue;
      const outcome = settled.get(m.ticker);
      if (!outcome) {
        // Count only markets the model could actually have priced, so the
        // exclusion rate is about missing outcomes rather than missing spot.
        if (strikeOf(m.ticker) !== null && sp.sigma !== null) missing.add(m.ticker);
        continue;
      }
      const row = evaluate(m, scan.ts, asset, sp, outcome);
      if (row) priced.push(row);
    }
  }

  const universe = firstSighting(priced);
  const pricedNoOutcome = missing.size;
  const totalPriceable = universe.length + pricedNoOutcome;
  const exclusion = totalPriceable > 0 ? pricedNoOutcome / totalPriceable : 1;

  console.log(`  ---------------------------------------------------------------`);
  console.log(`  SAMPLE HEALTH — read this before any result below`);
  console.log(`  ---------------------------------------------------------------`);
  console.log(`    distinct markets the model could price  ${totalPriceable.toLocaleString()}`);
  console.log(
    `    of those, no recorded outcome yet       ${pricedNoOutcome.toLocaleString()} (${pct(exclusion)})`,
  );
  console.log(`    usable (one row per market)             ${universe.length.toLocaleString()}`);
  if (exclusion > 0.5) {
    console.log(
      `\n    WARNING: more than half the population is missing. Markets that\n` +
        `    settle quickly, or that stayed liquid enough to keep being scanned,\n` +
        `    are over-represented in what survives. Treat everything below as a\n` +
        `    dry run of the arithmetic, not as an answer.`,
    );
  }
  console.log(`  ---------------------------------------------------------------`);

  if (universe.length === 0) {
    console.log(`\n  Nothing to measure yet. Leave the recorder running.\n`);
    return;
  }

  // The control arm. Every market the model could price, traded on whichever
  // side the model preferred, with no edge filter and no confidence filter.
  // If this arm looks profitable the sample is bent, because a book this
  // liquid does not hand out free money on every strike.
  printReport("CONTROL — every priceable market, model picks the side", skillReport(universe, fee));

  const signals = universe.filter((r) => r.claimedEdge >= minEdge)
    .filter((r) => (r.side === "yes" ? r.modelProb : 1 - r.modelProb) >= minProb);

  printReport(
    `SIGNALS — ${minEdge}c+ claimed net edge at ${(minProb * 100).toFixed(0)}%+ model confidence`,
    skillReport(signals, fee),
  );

  // ------------------------------------------------------------- by tag
  if (signals.length > 0) {
    const tags = tagPerformance(signals).filter((t) => t.n >= 3);
    if (tags.length > 0) {
      console.log(`  BY STRATEGY SLICE (worst first, 3+ rows)\n`);
      console.log(
        `    ${"tag".padEnd(26)} ${"n".padStart(5)} ${"events".padStart(7)} ` +
          `${"hit".padStart(7)} ${"P&L/ct".padStart(9)}`,
      );
      console.log(`    ${"-".repeat(26)} ${"-".repeat(5)} ${"-".repeat(7)} ${"-".repeat(7)} ${"-".repeat(9)}`);
      for (const t of tags) {
        console.log(
          `    ${t.tag.padEnd(26)} ${String(t.n).padStart(5)} ${String(t.events).padStart(7)} ` +
            `${pct(t.hitRate).padStart(7)} ${cents(t.pnlPerContract).padStart(9)}`,
        );
      }
      console.log(
        `\n    One number for a strategy hides the case where half its slices pay\n` +
          `    and half bleed. A blended near-break-even is exactly the shape that\n` +
          `    takes, and it looks identical to a strategy that does not work.\n`,
      );
    }
  }

  console.log(
    `  HOW TO READ THIS\n\n` +
      `    The only line that is about the model is the DELTA against the dumb\n` +
      `    baselines, and the only interval worth quoting is the clustered one.\n` +
      `    A ladder of strikes over one BTC hour settles as a single event; the\n` +
      `    naive interval prints beside it to show how much confidence gets\n` +
      `    manufactured by pretending otherwise.\n\n` +
      `    Skill is 1 - brierModel/brierBook. Positive means the model carries\n` +
      `    information the price does not. Zero means it is an expensive way to\n` +
      `    reproduce the ask.\n`,
  );
}

void main();
