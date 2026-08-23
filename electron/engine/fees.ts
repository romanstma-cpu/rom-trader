/**
 * Kalshi trading fees.
 *
 * These were missing entirely until 1.4.0, which mattered far more than any
 * setting: the engine buys at the ask and sells at the bid, so it is a taker
 * on both sides and pays the fee twice on every round trip.
 *
 * Kalshi's taker fee is
 *
 *     fee = ceil_to_cent( 0.07 × contracts × P × (1 − P) )
 *
 * with P the price in dollars. The curve peaks at 50c, where it costs about
 * 1.75c per contract per side — roughly 3.5c to open and close a position.
 * Against a 6c take-profit that is more than half the winnings, and against a
 * 4c stop it nearly doubles the loss.
 *
 * Makers (resting limit orders) pay far less, but this engine does not place
 * resting orders, so the taker rate is the honest one to model.
 *
 * Source: https://kalshi.com/docs/kalshi-fee-schedule.pdf
 */

/** Kalshi's published per-contract ceiling, as a safety clamp. */
const MAX_PER_CONTRACT_USD = 0.035;
const RATE = 0.07;

function ceilToCent(usd: number): number {
  return Math.ceil(usd * 100 - 1e-9) / 100;
}

/**
 * Taker fee in dollars for one execution.
 *
 * Rounded up once for the whole order, which is how Kalshi charges it —
 * rounding per contract would overstate the cost of large orders.
 */
export function takerFeeUsd(contracts: number, priceCents: number): number {
  if (contracts <= 0) return 0;
  const p = Math.min(1, Math.max(0, priceCents / 100));
  const raw = RATE * contracts * p * (1 - p);
  const capped = Math.min(raw, MAX_PER_CONTRACT_USD * contracts);
  return ceilToCent(capped);
}

/** What a full open-and-close costs, in dollars. */
export function roundTripFeeUsd(contracts: number, entryCents: number, exitCents: number): number {
  return takerFeeUsd(contracts, entryCents) + takerFeeUsd(contracts, exitCents);
}

/**
 * Round-trip fee expressed in cents per contract, for comparing against a
 * take-profit or stop that is also written in cents.
 *
 * Assumes the exit happens near the entry price, which is true for the small
 * moves this engine trades.
 */
export function roundTripFeeCentsPerContract(priceCents: number): number {
  // One contract would round a fraction of a cent up to a whole one, so
  // measure over a realistic order and divide back down.
  const sample = 100;
  return (roundTripFeeUsd(sample, priceCents, priceCents) * 100) / sample;
}

/**
 * What a take-profit is actually worth after costs, in cents per contract.
 *
 * Zero or less means the trade cannot make money however often it wins, which
 * is worth refusing rather than discovering across a few hundred fills.
 */
export function netEdgeCents(takeProfitCents: number, priceCents: number): number {
  return takeProfitCents - roundTripFeeCentsPerContract(priceCents);
}

/**
 * The win rate needed to break even, given a take-profit and stop that have
 * both been adjusted for fees. Returns null when no win rate can do it.
 */
export function breakEvenWinRate(
  takeProfitCents: number,
  stopLossCents: number,
  priceCents: number,
): number | null {
  const fee = roundTripFeeCentsPerContract(priceCents);
  const win = takeProfitCents - fee;
  const loss = stopLossCents + fee;
  if (win <= 0) return null; // no number of wins can pay for the fees
  return loss / (win + loss);
}
