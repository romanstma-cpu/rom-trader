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
  return `tp${s.takeProfitCents} sl${s.stopLossCents} mom${s.momentumThresholdCents} spr${s.maxSpreadCents}`;
}

/**
 * The grid.
 *
 * Deliberately coarse. A fine grid over four axes finds a winner by chance:
 * with enough combinations something always looks good on any given stretch of
 * market, and the more candidates the search tries the less the winner means.
 */
function grid(base: Settings): Settings[] {
  const out: Settings[] = [];
  for (const takeProfitCents of [6, 9, 12, 15]) {
    for (const stopLossCents of [3, 5, 8]) {
      for (const momentumThresholdCents of [3, 5, 8]) {
        for (const maxSpreadCents of [1, 2]) {
          out.push({
            ...base,
            takeProfitCents,
            stopLossCents,
            momentumThresholdCents,
            maxSpreadCents,
            liveMode: false,
          });
        }
      }
    }
  }
  return out;
}

export function runSweep(scans: RecordedScan[], base: Settings): SweepReport {
  const notes: string[] = [];
  // Split by time, never at random: shuffling would let the test set contain
  // moments adjacent to training ones and leak the answer.
  const cut = Math.floor(scans.length * 0.6);
  const train = scans.slice(0, cut);
  const test = scans.slice(cut);

  const score = (s: Settings, name: string): SweepCandidate => {
    const tr = runBacktest(train, s, name);
    const te = runBacktest(test, s, name);
    return {
      label: name,
      settings: s,
      trainPnlUsd: tr.pnlUsd,
      trainTrades: tr.trades,
      testPnlUsd: te.pnlUsd,
      testTrades: te.trades,
      testWinRate: te.winRate,
      generalisationGapUsd: round2(te.pnlUsd - tr.pnlUsd),
    };
  };

  const baseline = score({ ...base, liveMode: false }, "Current settings");
  const candidates = grid(base).map((s) => score(s, label(s)));

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

  const feeAt50 = roundTripFeeCentsPerContract(50);
  notes.push(
    `Round-trip fee is about ${feeAt50.toFixed(1)}c per contract near 50c, so any ` +
      `take-profit at or under that cannot win however often it is right.`,
  );

  return {
    scansTrain: train.length,
    scansTest: test.length,
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
