/**
 * What SHOULD this contract be worth?
 *
 * Everything ROM Trader has traded so far reads the contract's own price and
 * asks whether it is moving. Three days of measurement say that does not work:
 * the momentum edge is smaller than the fee, resting a bid is adversely
 * selected by 12 points, and the unconditional favourite band settles below
 * what it costs to buy. Every one of those strategies is a bet about the
 * CONTRACT. None of them ever looks at the thing the contract is about.
 *
 * A Kalshi crypto ladder resolves on the underlying. "Will BTC be above
 * 85,000 at 18:00" is not an opinion — given the spot price, the realized
 * volatility and the minutes remaining, it has a computable probability. If
 * that probability differs from the market's price by more than the fee, the
 * difference is an edge that needs no forecast of direction at all.
 *
 * The approach and the settlement detail below are adapted from Krypt Trader
 * (github.com/scripflipped/krypt-trader, MIT), another open-source Kalshi
 * client. Its own README is careful to say its strategies have no proven
 * fee-adjusted edge, and nothing here assumes otherwise — this module computes
 * a number, and `scripts/fairvalue.ts` measures whether that number beats the
 * market on ROM's own recorded settlements before it is allowed near an order.
 *
 * THE SETTLEMENT DETAIL IS THE PART THAT MATTERS.
 *
 * Kalshi does not settle these on the last price. It settles on the mean of
 * roughly sixty one-second index prints over the final minute. Modelling the
 * terminal spot instead overstates the variance near expiry — and near expiry
 * is exactly where a deep favourite is priced, which is exactly where the
 * arithmetic decides whether there is an edge. With thirty of the sixty prints
 * already observed, half the settlement value is ALREADY LOCKED and only the
 * remaining prints carry risk.
 */

import { takerFeeUsd, type FeeRounding } from "./fees";

/** Kalshi averages this many one-second prints to settle a crypto market. */
export const SETTLE_PRINTS = 60;

/**
 * Variance of the mean of 60 one-second prints, expressed in minutes of
 * ordinary diffusion.
 *
 * The average of n prints of a random walk has variance
 * σ²·Σi² / n² = σ²·n(n+1)(2n+1)/6 / n². At n = 60 one-second steps that works
 * out to ≈0.342 minutes, and using it makes the outside-the-window branch
 * continuous with the inside-the-window branch at exactly one minute left.
 */
export const SETTLE_AVG_EQUIV_MIN = ((60 * 61 * 121) / 6 / 60 ** 2) / 60;

/** Standard normal CDF via the error function. */
export function normCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

/**
 * Abramowitz & Stegun 7.1.26 — max absolute error 1.5e-7.
 *
 * Node has no Math.erf, and the alternative is a dependency for one function
 * whose error is four orders of magnitude below anything that changes a
 * decision here.
 */
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/**
 * Realized one-minute volatility: sample standard deviation of the last
 * `window` one-minute simple returns, as a fraction per √minute.
 *
 * Returns null rather than a number when there is not enough history or the
 * series is degenerate, so "not enough data yet" is a state the caller has to
 * handle rather than a quietly wrong small number.
 */
export function sigma1m(closes: number[], window = 30): number | null {
  const vals = closes.filter((v) => Number.isFinite(v) && v > 0);
  if (vals.length < window + 1) return null;
  const rets: number[] = [];
  for (let i = vals.length - window; i < vals.length; i++) {
    const prev = vals[i - 1];
    if (prev <= 0) return null;
    rets.push((vals[i] - prev) / prev);
  }
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  if (!(varr > 0)) return null;
  return Math.sqrt(varr);
}

export interface SettleModelInput {
  /** Current spot price of the underlying. */
  spot: number;
  /** The level the underlying must exceed for YES. */
  strike: number;
  /** Realized 1-minute volatility as a fraction, from sigma1m(). */
  sigma: number;
  /** Minutes until the market closes. */
  minsLeft: number;
  /** Sum of settlement prints already observed, when inside the final minute. */
  partialSum?: number;
  /** How many prints that sum covers. */
  partialCount?: number;
}

/**
 * P(the underlying settles above the strike), under Kalshi's real rule.
 *
 * Outside the final minute the price diffuses to the start of the settlement
 * window and then the window's own averaging variance is added. Inside it, the
 * prints already seen are treated as known and only the remaining ones are
 * uncertain — which collapses the variance fast and is why a model can be
 * confident about a contract the market still prices at 90c.
 *
 * Prints that elapsed before the feed was watching are approximated at the
 * current spot: a small bias toward spot with zero variance, which is worse
 * than observing them and much better than pretending the window has not
 * started.
 */
export function settlementUpProb(input: SettleModelInput): number | null {
  const { spot, strike, sigma, minsLeft } = input;
  if (!(spot > 0) || !(strike > 0) || !(sigma > 0)) return null;
  if (!Number.isFinite(minsLeft) || minsLeft < 0) return null;

  if (minsLeft > 1) {
    const tEff = minsLeft - 1 + SETTLE_AVG_EQUIV_MIN;
    const sd = sigma * Math.sqrt(tEff) * spot;
    if (!(sd > 0)) return null;
    return clamp01(normCdf((spot - strike) / sd));
  }

  const nFuture = Math.min(SETTLE_PRINTS, Math.max(1, Math.round(minsLeft * 60)));
  const elapsed = SETTLE_PRINTS - nFuture;
  const observed = Math.max(0, Math.min(Math.trunc(input.partialCount ?? 0), elapsed));
  let sum = observed > 0 ? (input.partialSum ?? 0) : 0;
  // A partial sum covering more prints than we credit gets scaled down rather
  // than trusted whole; over-counting observed value would understate the
  // remaining risk.
  const declared = Math.trunc(input.partialCount ?? 0);
  if (observed > 0 && declared > 0 && observed < declared) sum = sum * (observed / declared);

  const missing = elapsed - observed;
  const mean = (sum + (missing + nFuture) * spot) / SETTLE_PRINTS;
  const sigma1s = sigma / Math.sqrt(60);
  const variance =
    ((spot * sigma1s) ** 2 * ((nFuture * (nFuture + 1) * (2 * nFuture + 1)) / 6)) /
    SETTLE_PRINTS ** 2;
  if (!(variance > 0)) return null;
  return clamp01(normCdf((mean - strike) / Math.sqrt(variance)));
}

/**
 * The simpler terminal-spot model, kept for comparison.
 *
 * Exported so the study can show how much the settlement rule actually
 * changes the answer rather than asserting that it does.
 */
export function terminalUpProb(input: Omit<SettleModelInput, "partialSum" | "partialCount">): number | null {
  const { spot, strike, sigma, minsLeft } = input;
  if (!(spot > 0) || !(strike > 0) || !(sigma > 0)) return null;
  const t = Math.max(0.05, minsLeft);
  const sd = sigma * Math.sqrt(t) * spot;
  if (!(sd > 0)) return null;
  return clamp01(normCdf((spot - strike) / sd));
}

/**
 * Fee for ONE contract, in cents — the conservative case.
 *
 * Kalshi rounds the fee up per order, so a single lot at 97c pays a whole cent
 * where the continuous 0.07·p·(1−p) curve claims 0.2. That gap is widest at
 * exactly the deep-favourite prices a model-driven strategy wants to buy, so
 * using the smooth curve there would manufacture edge that does not exist.
 * Per-contract cost only falls as size grows; this is the floor to clear.
 */
export function oneLotFeeCents(priceCents: number, rounding: FeeRounding = "cent"): number {
  return takerFeeUsd(1, priceCents, rounding) * 100;
}

export interface EdgeInput {
  /** Model probability that YES settles. */
  upProb: number;
  /** Best YES ask in cents, when there is one. */
  yesAskCents?: number | null;
  /** Best NO ask in cents, when there is one. */
  noAskCents?: number | null;
  rounding?: FeeRounding;
}

export interface EdgeResult {
  /** Best fee-adjusted cents of edge available on either side. */
  netCents: number;
  side: "yes" | "no";
  askCents: number;
  feeCents: number;
}

/**
 * The best fee-adjusted edge the model sees on either side of the book.
 *
 * Buying YES is worth P(up)·100 less what it costs and less the fee; buying NO
 * is the mirror. Positive means the model believes a side is underpriced by
 * more than it costs to take it. Returns null when neither side is quotable —
 * an unquotable edge is not an edge.
 */
export function modelEdgeNetCents(input: EdgeInput): EdgeResult | null {
  const { upProb, yesAskCents, noAskCents, rounding = "cent" } = input;
  if (!Number.isFinite(upProb) || upProb < 0 || upProb > 1) return null;

  const candidates: EdgeResult[] = [];
  if (yesAskCents != null && yesAskCents > 0 && yesAskCents < 100) {
    const fee = oneLotFeeCents(yesAskCents, rounding);
    candidates.push({
      netCents: upProb * 100 - yesAskCents - fee,
      side: "yes",
      askCents: yesAskCents,
      feeCents: fee,
    });
  }
  if (noAskCents != null && noAskCents > 0 && noAskCents < 100) {
    const fee = oneLotFeeCents(noAskCents, rounding);
    candidates.push({
      netCents: (1 - upProb) * 100 - noAskCents - fee,
      side: "no",
      askCents: noAskCents,
      feeCents: fee,
    });
  }
  if (candidates.length === 0) return null;
  const best = candidates.reduce((a, b) => (b.netCents > a.netCents ? b : a));
  return { ...best, netCents: Math.round(best.netCents * 100) / 100 };
}

/**
 * Wilson lower bound on a hit rate, for gating on evidence rather than on the
 * point estimate.
 *
 * Three wins from three trades is a 100% hit rate and means nothing; the
 * Wilson bound reads it as 0.44 at 95%, which is the number a decision should
 * actually use. Every claim this app makes about its own accuracy should be
 * the bound, not the mean.
 */
export function wilsonLowerBound(wins: number, n: number, z = 1.645): number {
  if (n <= 0) return 0;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const rad = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - rad) / denom);
}

/**
 * Is the model still calibrated enough to act on?
 *
 * A fair-value model is only worth its arithmetic while the world still
 * behaves the way it assumes. Volatility regimes change, a feed goes stale,
 * an exchange changes a settlement rule — and the failure mode is not an
 * error, it is confident wrong numbers. So the recent record gates the next
 * trade: the Wilson lower bound on how often high-confidence calls actually
 * landed must clear a floor, and too small a sample refuses rather than
 * assumes.
 */
export function calibrationOk(
  wins: number,
  n: number,
  { minSamples = 20, floor = 0.8 }: { minSamples?: number; floor?: number } = {},
): { ok: boolean; bound: number; reason: string } {
  if (n < minSamples) {
    return { ok: false, bound: 0, reason: `only ${n} resolved calls, need ${minSamples}` };
  }
  const bound = wilsonLowerBound(wins, n);
  return bound >= floor
    ? { ok: true, bound, reason: `${wins}/${n}, lower bound ${(bound * 100).toFixed(0)}%` }
    : {
        ok: false,
        bound,
        reason: `lower bound ${(bound * 100).toFixed(0)}% below the ${(floor * 100).toFixed(0)}% floor (${wins}/${n})`,
      };
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
