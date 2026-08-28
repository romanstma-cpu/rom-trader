/**
 * A wider parameter search than the app ships, with walk-forward validation.
 *
 * The in-app sweep searches 144 candidates over one 60/40 split, and every one
 * of them loses on this recording. edge.ts says why: the barrier race a maker
 * runs is won about 54% of the time after both entry gates in a tight book,
 * and a 12c/12c maker trade needs 57.3% to cover the exit fee. The gap is the
 * fee, and the fee is a fixed number of cents — so it shrinks as a share of
 * the move as the barriers widen. Nothing in the shipped grid goes past a 15c
 * target or an 8c stop, so the region where that arithmetic turns is exactly
 * the region never searched.
 *
 * This searches it, and then refuses to believe any winner that cannot repeat
 * itself across four consecutive slices of time it was not fitted on.
 *
 *   npx esbuild scripts/optimize.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/optimize.js
 *   node scripts/optimize.js [--in <scans.jsonl>] [--folds 4]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runBacktest } from "../electron/engine/backtest";
import type { KalshiMarket } from "../electron/engine/kalshi";
import { segmentScans, type RecordedScan } from "../electron/engine/recorder";
import { DEFAULT_SETTINGS, type Settings } from "../electron/engine/store";

function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}

function loadScans(file: string): RecordedScan[] {
  const out: RecordedScan[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const s = JSON.parse(line) as RecordedScan;
      if (Array.isArray(s.markets) && s.markets.length > 0) out.push(s);
    } catch {
      // half-written final line
    }
  }
  return out;
}

/**
 * Research base: the safety brakes are off and the paper bankroll is large.
 *
 * A daily loss limit or a drawdown halt would stop a candidate mid-recording
 * and score it "stopped early" rather than scoring the rules being tested.
 * They are real features and they stay on in the app; they just cannot be
 * allowed to answer a question about entry quality.
 */
const BASE: Settings = {
  ...DEFAULT_SETTINGS,
  liveMode: false,
  dryRunCash: 10_000,
  maxConsecutiveLosses: 0,
  dailyLossLimitUsd: 0,
  maxDrawdownPct: 0,
  tradeSizeUsd: 10,
  maxPositions: 5,
  maxPositionsPerEvent: 1,
  momentumOnBid: true,
  requireTradeActivity: true,
  requireConsistentMove: true,
  minMinutesToClose: 30,
};

interface Candidate {
  label: string;
  settings: Settings;
  axes: Record<string, string | number | boolean>;
}

/**
 * The axes, declared rather than nested, so each one's marginal effect can be
 * read off afterwards.
 *
 * The marginal is the point. A grid this wide always has a top row, and the
 * top row of a wide grid is a lottery winner. "Every candidate with a 30c
 * target beat every candidate with a 12c target, averaged over 60 other
 * settings each" is a claim a single lucky cell cannot make.
 */
/**
 * Price bands, which is the axis the app has never varied.
 *
 * Kalshi charges 0.07 x P x (1 - P) per contract per side, a curve that peaks
 * at 50c and falls away at both ends: 1.75c a side in the middle, 1.02c at
 * 17c, 1.12c at 80c. The shipped 10-85c band spans the whole thing and spends
 * most of its trades in the most expensive part of it. edge.ts measured the
 * signal separately in each band, and it is the only cut of this data where
 * anything clears its own break-even line.
 */
const BANDS: Record<string, [number, number]> = {
  "10-85": [10, 85],
  "25-75": [25, 75],
  "55-80": [55, 80],
  "60-75": [60, 75],
};

const AXES = {
  band: Object.keys(BANDS),
  takeProfitCents: [12, 20, 30, 40],
  stopLossCents: [8, 12, 20, 30],
  maxSpreadCents: [1, 2],
  // Both sides passive. A maker entry pays no fee to open and a resting
  // take-profit fills at the target fee-free, so on this axis a winner costs
  // nothing at all and only a stop pays the taker rate. That moves the
  // break-even from 57% of decided races to about 42% — and the measured
  // maker win rate inside the 60-75c band is 58%. It is the one combination
  // the earlier searches never crossed with the price band, because they
  // pinned makerExits to false.
  makerExits: [false, true],
};

function candidates(): Candidate[] {
  const out: Candidate[] = [];
  for (const band of AXES.band) {
    for (const takeProfitCents of AXES.takeProfitCents) {
      for (const stopLossCents of AXES.stopLossCents) {
        for (const maxSpreadCents of AXES.maxSpreadCents) {
          for (const makerExits of AXES.makerExits) {
            const [minPriceCents, maxPriceCents] = BANDS[band];
            out.push({
              label:
                `${band}c tp${takeProfitCents} sl${stopLossCents} spr${maxSpreadCents}` +
                (makerExits ? " mkTP" : ""),
              axes: { band, takeProfitCents, stopLossCents, maxSpreadCents, makerExits },
              settings: {
                ...BASE,
                band: undefined,
                minPriceCents,
                maxPriceCents,
                takeProfitCents,
                stopLossCents,
                maxSpreadCents,
                makerExits,
                // Fixed at what the previous run's marginals preferred, so this
                // run varies the new axes against a settled background rather
                // than searching everything at once and finding noise.
                momentumThresholdCents: 3,
                makerEntries: true,
                minMinutesToClose: 30,
                makerTtlTicks: 6,
                minNetEdgeCents: DEFAULT_SETTINGS.minNetEdgeCents,
                regimeFilterEnabled: true,
              } as Settings,
            });
          }
        }
      }
    }
  }
  return out;
}

interface FoldScore {
  pnlUsd: number;
  trades: number;
  winRate: number | null;
}

/**
 * Consecutive equal slices of the recording, in time order.
 *
 * A single train/test split gives one number, and one number out of a search
 * this wide is a coin that came up heads. Four slices scored separately show
 * whether a candidate is consistently anything, and a winner that is positive
 * in one slice and negative in three is reported as what it is.
 */
function folds(scans: RecordedScan[], n: number): RecordedScan[][] {
  const size = Math.floor(scans.length / n);
  const out: RecordedScan[][] = [];
  for (let i = 0; i < n; i++) {
    out.push(scans.slice(i * size, i === n - 1 ? scans.length : (i + 1) * size));
  }
  return out;
}

function score(slice: RecordedScan[], c: Candidate): FoldScore {
  const r = runBacktest(slice, c.settings, c.label);
  return { pnlUsd: r.pnlUsd, trades: r.trades, winRate: r.winRate };
}

function money(n: number): string {
  return `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
}

function main(): void {
  const file = argStr("in", path.join(process.env.APPDATA ?? ".", "ROM Trader", "scans.jsonl"));
  const nFolds = Number(argStr("folds", "4"));
  const scans = loadScans(file);
  const segs = segmentScans(scans, 180_000, 10);
  const slices = folds(scans, nFolds);
  const cands = candidates();

  console.log(`\n=== Wide search: ${path.basename(file)} ===`);
  console.log(
    `  ${scans.length} scans, ${segs.length} contiguous segments, ` +
      `${cands.length} candidates x ${nFolds} folds = ${cands.length * nFolds} replays`,
  );
  console.log(
    `  fold sizes: ${slices.map((s) => s.length).join(", ")} scans\n`,
  );

  const rows: { c: Candidate; scores: FoldScore[]; total: number; positive: number; trades: number }[] =
    [];

  const started = Date.now();
  cands.forEach((c, i) => {
    const scores = slices.map((s) => score(s, c));
    const total = scores.reduce((a, b) => a + b.pnlUsd, 0);
    rows.push({
      c,
      scores,
      total: Math.round(total * 100) / 100,
      positive: scores.filter((s) => s.pnlUsd > 0).length,
      trades: scores.reduce((a, b) => a + b.trades, 0),
    });
    if ((i + 1) % 25 === 0) {
      const rate = (Date.now() - started) / (i + 1);
      const left = Math.round((rate * (cands.length - i - 1)) / 1000);
      console.log(`  ...${i + 1}/${cands.length} (${left}s left)`);
    }
  });

  // Ranked by how many separate stretches of time it made money in, then by
  // total. Ranking by total alone hands the top spot to whichever candidate
  // caught one big move, which is the thing this whole script exists to avoid.
  rows.sort((a, b) => b.positive - a.positive || b.total - a.total);

  console.log(`\n  Ranked by folds profitable, then total:\n`);
  const head =
    `  ${"candidate".padEnd(26)} ${"folds+".padStart(6)} ${"trades".padStart(7)} ` +
    `${"total".padStart(9)} ` +
    slices.map((_, i) => `f${i + 1}`.padStart(8)).join(" ");
  console.log(head);
  console.log(`  ${"-".repeat(26)} ${"-".repeat(6)} ${"-".repeat(7)} ${"-".repeat(9)} ${slices.map(() => "-".repeat(8)).join(" ")}`);
  for (const r of rows.slice(0, 20)) {
    console.log(
      `  ${r.c.label.padEnd(26)} ${`${r.positive}/${nFolds}`.padStart(6)} ${String(r.trades).padStart(7)} ` +
        `${money(r.total).padStart(9)} ` +
        r.scores.map((s) => money(s.pnlUsd).padStart(8)).join(" "),
    );
  }

  console.log(`\n  Worst 5, for scale:\n`);
  for (const r of rows.slice(-5)) {
    console.log(
      `  ${r.c.label.padEnd(26)} ${`${r.positive}/${nFolds}`.padStart(6)} ${String(r.trades).padStart(7)} ` +
        `${money(r.total).padStart(9)} ` +
        r.scores.map((s) => money(s.pnlUsd).padStart(8)).join(" "),
    );
  }

  const allFolds = rows.filter((r) => r.positive === nFolds && r.trades >= 20);
  console.log("");
  if (allFolds.length === 0) {
    console.log(
      `  No candidate made money in all ${nFolds} folds on at least 20 trades.\n` +
        `  On this recording there is no setting in this grid worth adopting.`,
    );
  } else {
    console.log(`  ${allFolds.length} candidate(s) profitable in every fold on 20+ trades:`);
    for (const r of allFolds) {
      console.log(`    ${r.c.label}  ${money(r.total)} over ${r.trades} trades`);
    }
    console.log(
      `\n  Searching ${cands.length} candidates means a few will clear any bar by luck.\n` +
        `  Treat this as a hypothesis to paper-trade, not a result.`,
    );
  }

  const median = [...rows].sort((a, b) => a.total - b.total)[Math.floor(rows.length / 2)];
  console.log(
    `\n  Median candidate: ${median.c.label} ${money(median.total)} over ${median.trades} trades.\n` +
      `  The median is the honest summary of a grid; the top row is the honest summary of luck.`,
  );

  // Marginals: for each axis value, the average over every candidate holding
  // that value, with all the other axes varying. A setting that helps here has
  // helped across dozens of different companions rather than in one cell.
  console.log(`\n  What each setting is worth on average, all else varying:\n`);
  console.log(
    `  ${"axis".padEnd(22)} ${"value".padStart(7)} ${"cands".padStart(6)} ${"trades".padStart(7)} ` +
      `${"avg total".padStart(10)} ${"avg/trade".padStart(10)} ${"folds+".padStart(7)}`,
  );
  console.log(
    `  ${"-".repeat(22)} ${"-".repeat(7)} ${"-".repeat(6)} ${"-".repeat(7)} ${"-".repeat(10)} ${"-".repeat(10)} ${"-".repeat(7)}`,
  );
  for (const axis of Object.keys(AXES) as (keyof typeof AXES)[]) {
    for (const value of AXES[axis]) {
      const group = rows.filter((r) => r.c.axes[axis] === value);
      const total = group.reduce((a, r) => a + r.total, 0);
      const trades = group.reduce((a, r) => a + r.trades, 0);
      const positive = group.reduce((a, r) => a + r.positive, 0);
      console.log(
        `  ${axis.padEnd(22)} ${String(value).padStart(7)} ${String(group.length).padStart(6)} ` +
          `${String(trades).padStart(7)} ${money(total / group.length).padStart(10)} ` +
          `${(trades === 0 ? "—" : money(total / trades)).padStart(10)} ` +
          `${`${positive}/${group.length * nFolds}`.padStart(7)}`,
      );
    }
    console.log("");
  }

  // The settings the user is actually running, priced against the grid.
  const current = rows.find(
    (r) =>
      r.c.axes.band === "10-85" &&
      r.c.axes.takeProfitCents === 12 &&
      r.c.axes.stopLossCents === 12 &&
      r.c.axes.maxSpreadCents === 2,
  );
  if (current) {
    const rank = rows.indexOf(current) + 1;
    console.log(
      `  Nearest grid point to the shipped defaults (${current.c.label}): ` +
        `${money(current.total)} over ${current.trades} trades, ranked ${rank} of ${rows.length}.\n`,
    );
  }
}

main();
