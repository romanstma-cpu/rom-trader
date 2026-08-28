import type { EquityPoint, TradeRecord } from "./store";
import { clusterBootstrapCI, eventOf, groupByEvent } from "./skill";

/**
 * Performance measurement over a set of closed trades.
 *
 * Everything here is descriptive, not predictive: a profit factor of 1.4 over
 * one recording is a fact about that recording, not a property of the
 * strategy. The point of computing these at all is that "made $3 over the
 * weekend" hides whether that was forty coin flips or four clean trades, and
 * the difference decides whether the result means anything.
 *
 * Sharpe and Sortino are per-trade, deliberately not annualised. Annualising
 * assumes a trade frequency this engine does not promise, and multiplying a
 * noisy number by sqrt(252) manufactures confidence out of arithmetic.
 *
 * THE TRADE COUNT IS NOT THE SAMPLE SIZE
 *
 * This page used to report a win rate and a P&L with no interval and no honest
 * denominator, which let fifteen trades taken across three BTC ladders read as
 * fifteen independent results. They are not: sibling strikes of one event
 * resolve on one underlying move, so a ladder that goes the wrong way produces
 * a run of losses that is ONE outcome wearing several coats. The scripts in
 * this repo were rebuilt around that fact after it invalidated a fair-value
 * result; leaving the app itself reporting the flattering version would be
 * shipping the error that was just removed from the research.
 *
 * So `events` counts distinct event ladders, and both intervals come from an
 * event-clustered bootstrap. Where the trade count and the event count diverge
 * sharply, the interval widens to say so.
 */
export interface PerformanceMetrics {
  trades: number;
  /**
   * Distinct event ladders among those trades — the honest denominator.
   * Sibling strikes settle together, so they are one observation, not several.
   */
  events: number;
  wins: number;
  losses: number;
  winRate: number | null;
  /** Event-clustered 95% interval on the win rate. Null under two trades. */
  winRateCI: [number, number] | null;
  /** Event-clustered 95% interval on mean P&L per trade, in dollars. */
  expectancyCI: [number, number] | null;
  /** Sum of winning trades, in dollars. */
  grossWinUsd: number;
  /** Sum of losing trades as a positive number, in dollars. */
  grossLossUsd: number;
  /** Gross win over gross loss. Above 1 is profitable. Null until both sides exist. */
  profitFactor: number | null;
  avgWinUsd: number | null;
  /** Average losing trade, reported as a positive number. */
  avgLossUsd: number | null;
  /** Average win over average loss — how asymmetric the payoffs are. */
  payoffRatio: number | null;
  /** Mean P&L per closed trade. The sign of this is the whole question. */
  expectancyUsd: number | null;
  /** Mean over standard deviation of per-trade P&L. */
  sharpePerTrade: number | null;
  /** Like Sharpe, but only downside deviation counts as risk. */
  sortinoPerTrade: number | null;
  maxDrawdownUsd: number;
  /** Largest peak-to-trough fall relative to the peak. Null without equity data. */
  maxDrawdownPct: number | null;
  longestWinStreak: number;
  longestLossStreak: number;
}

export function computeMetrics(
  history: TradeRecord[],
  equity: EquityPoint[],
): PerformanceMetrics {
  const pnls = history.map((t) => t.pnlUsd);
  const winsArr = pnls.filter((p) => p > 0);
  const lossArr = pnls.filter((p) => p < 0);
  const grossWin = winsArr.reduce((a, b) => a + b, 0);
  const grossLoss = -lossArr.reduce((a, b) => a + b, 0);

  const avgWin = winsArr.length > 0 ? grossWin / winsArr.length : null;
  const avgLoss = lossArr.length > 0 ? grossLoss / lossArr.length : null;

  // Population standard deviation: this is the whole sample being described,
  // not an estimate drawn from a larger one.
  let sharpe: number | null = null;
  let sortino: number | null = null;
  if (pnls.length >= 2) {
    const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((a, b) => a + (b - mean) * (b - mean), 0) / pnls.length;
    const sd = Math.sqrt(variance);
    if (sd > 0) sharpe = mean / sd;
    // Downside deviation measured against zero: a flat trade is not risk.
    const downside = Math.sqrt(
      pnls.reduce((a, b) => a + Math.min(0, b) * Math.min(0, b), 0) / pnls.length,
    );
    if (downside > 0) sortino = mean / downside;
  }

  let peak = equity.length > 0 ? equity[0].equityUsd : 0;
  let maxDdUsd = 0;
  let maxDdPct = 0;
  for (const p of equity) {
    if (p.equityUsd > peak) peak = p.equityUsd;
    const dd = peak - p.equityUsd;
    if (dd > maxDdUsd) maxDdUsd = dd;
    if (peak > 0 && dd / peak > maxDdPct) maxDdPct = dd / peak;
  }

  let winStreak = 0;
  let lossStreak = 0;
  let bestWinStreak = 0;
  let bestLossStreak = 0;
  for (const p of pnls) {
    if (p > 0) {
      winStreak += 1;
      lossStreak = 0;
    } else if (p < 0) {
      lossStreak += 1;
      winStreak = 0;
    }
    // A dead-flat trade breaks neither streak; it is not evidence either way.
    if (winStreak > bestWinStreak) bestWinStreak = winStreak;
    if (lossStreak > bestLossStreak) bestLossStreak = lossStreak;
  }

  // Group by event ladder, not by ticker, so every rung of one BTC hour
  // collapses to a single unit of evidence.
  //
  // Deliberately `skill.eventOf` (split at the last dash) rather than
  // `TradingEngine.eventOf` (strip a `-T…`/`-B…` strike suffix). The two agree
  // on the crypto threshold ladders and disagree on series whose outcome
  // segment is not a strike — KXCRYPTOLEAD15M has up to five siblings per
  // event that the engine's rule reads as five separate events. For MEASUREMENT
  // the broader grouping is the correct one: those markets do resolve together,
  // whatever the risk limits currently believe. The engine's own definition is
  // a separate question, because widening it changes live behaviour.
  const groups = groupByEvent(history, (t) => eventOf(t.ticker));
  const decided = history.filter((t) => t.pnlUsd !== 0);
  let winRateCI: [number, number] | null = null;
  let expectancyCI: [number, number] | null = null;
  if (history.length >= 2) {
    expectancyCI = clusterBootstrapCI(
      groups,
      (idx) => {
        let s = 0;
        for (const i of idx) s += pnls[i];
        return round2(s / idx.length);
      },
      2000,
    );
  }
  if (decided.length >= 2) {
    // A flat trade is not evidence either way, so the win-rate interval is
    // built on decided trades only — matching how winRate itself is computed.
    const decidedGroups = groupByEvent(decided, (t) => eventOf(t.ticker));
    const won = decided.map((t) => (t.pnlUsd > 0 ? 1 : 0));
    winRateCI = clusterBootstrapCI(
      decidedGroups,
      (idx) => {
        let s = 0;
        for (const i of idx) s += won[i];
        return s / idx.length;
      },
      2000,
    );
  }

  return {
    trades: history.length,
    events: groups.length,
    wins: winsArr.length,
    losses: lossArr.length,
    winRate:
      winsArr.length + lossArr.length > 0
        ? winsArr.length / (winsArr.length + lossArr.length)
        : null,
    winRateCI,
    expectancyCI,
    grossWinUsd: round2(grossWin),
    grossLossUsd: round2(grossLoss),
    profitFactor: grossLoss > 0 && grossWin > 0 ? round2(grossWin / grossLoss) : null,
    avgWinUsd: avgWin === null ? null : round2(avgWin),
    avgLossUsd: avgLoss === null ? null : round2(avgLoss),
    payoffRatio: avgWin !== null && avgLoss !== null && avgLoss > 0 ? round2(avgWin / avgLoss) : null,
    expectancyUsd: pnls.length > 0 ? round2(pnls.reduce((a, b) => a + b, 0) / pnls.length) : null,
    sharpePerTrade: sharpe === null ? null : round3(sharpe),
    sortinoPerTrade: sortino === null ? null : round3(sortino),
    maxDrawdownUsd: round2(maxDdUsd),
    maxDrawdownPct: equity.length > 0 ? round3(maxDdPct * 100) : null,
    longestWinStreak: bestWinStreak,
    longestLossStreak: bestLossStreak,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
