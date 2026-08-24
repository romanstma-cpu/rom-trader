import { runBacktest } from "./backtest";
import { roundTripFeeCentsPerContract } from "./fees";
import type { RecordedScan } from "./recorder";
import { type Settings } from "./store";

/**
 * Parameter search with an out-of-sample check.
 *
 * The obvious way to "improve" a trading bot is to try every setting against
 * recorded data and keep whichever scored highest. That reliably produces a
 * configuration tuned to the noise in one recording, which then performs worse
 * live than the defaults it replaced.
 *
 * So every candidate is fitted on the first part of the recording and scored
 * on the last part, which it never saw. A candidate that wins in training and
 * loses in testing is reported as exactly that rather than quietly dropped —
 * the gap between the two is the most useful number here, because a large one
 * means the search is finding noise and no result should be trusted.
 */

export interface SweepCandidate {
  label: string;
  settings: Settings;
  /** Result over the data the search was allowed to look at. */
  trainPnlUsd: number;
  trainTrades: number;
  /** Result over data held back entirely. */
  testPnlUsd: number;
  testTrades: number;
  testWinRate: number | null;
  /** Positive when it did better on unseen data than on training data. */
  generalisationGapUsd: number;
}

export interface SweepReport {
  scansTrain: number;
  scansTest: number;
  candidates: SweepCandidate[];
  baseline: SweepCandidate | null;
  /** Best by out-of-sample result, not by training result. */
  bestOutOfSample: SweepCandidate | null;
  /** True when even the best candidate lost money on unseen data. */
  nothingWorked: boolean;
  notes: string[];
}

function label(s: Settings): string {
  return (
    `tp${s.takeProfitCents} sl${s.stopLossCents} mom${s.momentumThresholdCents} ` +
    `spr${s.maxSpreadCents}${s.makerEntries ? " maker" : ""}`
  );
}

/**
 * The grid.
 *
 * Deliberately coarse. A fine grid over five axes finds a winner by chance:
 * with enough combinations something always looks good on any given stretch of
 * market, and the more candidates the search tries the less the winner means.
 *
 * The maker/taker axis earns its place because it is not a tuning knob — it
 * changes which costs exist at all, which the simulations showed matters more
 * than every threshold combined.
 */
function grid(base: Settings): Settings[] {
  const out: Settings[] = [];
  for (const takeProfitCents of [6, 9, 12, 15]) {
    for (const stopLossCents of [3, 5, 8]) {
      for (const momentumThresholdCents of [3, 5, 8]) {
        for (const maxSpreadCents of [1, 2]) {
          for (const makerEntries of [false, true]) {
            out.push({
              ...base,
              takeProfitCents,
              stopLossCents,
              momentumThresholdCents,
              maxSpreadCents,
              makerEntries,
              liveMode: false,
            });
          }
        }
      }
    }
  }
  return out;
}

/** One configuration queued for scoring, baseline first. */
export interface SweepJob {
  settings: Settings;
  label: string;
}

export interface SweepWork {
  train: RecordedScan[];
  test: RecordedScan[];
  jobs: SweepJob[];
  notes: string[];
}

/** How many scans a sweep is willing to chew through. */
const MAX_SWEEP_SCANS = 6000;

export function prepareSweep(scans: RecordedScan[], base: Settings): SweepWork {
  const notes: string[] = [];
  let used = scans;
  if (scans.length > MAX_SWEEP_SCANS) {
    // A week-long recording would take minutes per candidate. The most recent
    // stretch is also the most like the market the settings will face next.
    used = scans.slice(-MAX_SWEEP_SCANS);
    notes.push(
      `The recording has ${scans.length.toLocaleString()} scans; the sweep used the most ` +
        `recent ${MAX_SWEEP_SCANS.toLocaleString()}.`,
    );
  }
  // Split by time, never at random: shuffling would let the test set contain
  // moments adjacent to training ones and leak the answer.
  const cut = Math.floor(used.length * 0.6);
  return {
    train: used.slice(0, cut),
    test: used.slice(cut),
    jobs: [
      { settings: { ...base, liveMode: false }, label: "Current settings" },
      ...grid(base).map((s) => ({ settings: s, label: label(s) })),
    ],
    notes,
  };
}

export function scoreCandidate(work: SweepWork, job: SweepJob): SweepCandidate {
  const tr = runBacktest(work.train, job.settings, job.label);
  const te = runBacktest(work.test, job.settings, job.label);
  return {
    label: job.label,
    settings: job.settings,
    trainPnlUsd: tr.pnlUsd,
    trainTrades: tr.trades,
    testPnlUsd: te.pnlUsd,
    testTrades: te.trades,
    testWinRate: te.winRate,
    generalisationGapUsd: round2(te.pnlUsd - tr.pnlUsd),
  };
}

export function runSweep(scans: RecordedScan[], base: Settings): SweepReport {
  const work = prepareSweep(scans, base);
  const [first, ...rest] = work.jobs;
  const baseline = scoreCandidate(work, first);
  const candidates = rest.map((j) => scoreCandidate(work, j));
  return finishSweep(work, baseline, candidates);
}

/**
 * The same sweep, sliced so it can run on Electron's main process without
 * freezing the app: one candidate per event-loop turn, with progress reported
 * as it goes. Nearly three hundred replays back to back would otherwise block
 * every IPC call and paint for the better part of a minute.
 */
export async function runSweepAsync(
  scans: RecordedScan[],
  base: Settings,
  onProgress?: (done: number, total: number) => void,
): Promise<SweepReport> {
  const work = prepareSweep(scans, base);
  const results: SweepCandidate[] = [];
  for (let i = 0; i < work.jobs.length; i++) {
    results.push(scoreCandidate(work, work.jobs[i]));
    onProgress?.(i + 1, work.jobs.length);
    await new Promise((r) => setImmediate(r));
  }
  const [baseline, ...candidates] = results;
  return finishSweep(work, baseline, candidates);
}

function finishSweep(
  work: SweepWork,
  baseline: SweepCandidate,
  candidates: SweepCandidate[],
): SweepReport {
  const notes = [...work.notes];

  // Ranked by the held-out result. Ranking by training result is what makes a
  // sweep produce confident nonsense.
  const ranked = [...candidates].sort((a, b) => b.testPnlUsd - a.testPnlUsd);
  const best = ranked.length > 0 ? ranked[0] : null;

  const traded = candidates.filter((c) => c.testTrades > 0);
  if (traded.length === 0) {
    notes.push(
      "No candidate opened a trade on the held-out data. The recording is too short " +
        "or too quiet to tell these settings apart.",
    );
  }
  if (best && best.testPnlUsd <= 0) {
    notes.push(
      "Every candidate lost money on data it had not seen. That is the honest result: " +
        "on this recording, no setting in the grid had an edge.",
    );
  }
  if (best && best.trainPnlUsd > 0 && best.testPnlUsd < 0) {
    notes.push(
      "The best training result lost money out of sample — the classic signature of " +
        "fitting noise. Do not adopt it.",
    );
  }
  if (best && best.testPnlUsd > 0 && best.testTrades < 10) {
    // The first real sweep hit exactly this: five all-positive maker rows on
    // three trades each. Searching 144 candidates guarantees a few land on
    // whichever market happened to move during the test window.
    notes.push(
      `The winner's result rests on ${best.testTrades} trade${best.testTrades === 1 ? "" : "s"}. ` +
        `With ${candidates.length} candidates searched, a handful of lucky trades is the expected ` +
        `way for one to look good — treat it as noise until it repeats on more data.`,
    );
  }

  const feeAt50 = roundTripFeeCentsPerContract(50);
  notes.push(
    `Round-trip fee is about ${feeAt50.toFixed(1)}c per contract near 50c, so any ` +
      `take-profit at or under that cannot win however often it is right.`,
  );

  return {
    scansTrain: work.train.length,
    scansTest: work.test.length,
    candidates: ranked,
    baseline,
    bestOutOfSample: best,
    nothingWorked: !best || best.testPnlUsd <= 0,
    notes,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
