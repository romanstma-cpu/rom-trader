/**
 * Kalshi trading fees.
 *
 * These were missing entirely until 1.4.0, which mattered far more than any
 * setting: the engine buys at the ask and sells at the bid, so it is a taker
 * on both sides and pays the fee twice on every round trip.
 *
 * Kalshi's taker fee is
 *
 *     fee = round_up( M × 0.07 × C × P × (1 − P) )
 *
 * with P the price in dollars and M a per-series multiplier defaulting to 1.
 * The curve peaks at 50c, where it costs about 1.75c per contract per side —
 * roughly 3.5c to open and close a position. Against a 6c take-profit that is
 * more than half the winnings, and against a 4c stop it nearly doubles the
 * loss.
 *
 * THE MAKER SIDE IS NOT "CHEAPER". ON MOST SERIES IT IS FREE.
 *
 * This file used to say makers "pay far less", which understated it enough to
 * misdirect three days of research. The maker formula is
 *
 *     fee = round_up( M × 0.0175 × C × P × (1 − P) )
 *
 * and its multiplier M defaults to ZERO. A series charges makers only when it
 * is listed in the fee schedule's Non-Standard Fees table. The crypto ladders
 * this engine trades are not: KXBTCD, KXBTC, KXETHD and KXETH all report
 * `fee_type: "quadratic"`, which the API's own documentation defines as the
 * General Trading Fees Table with no maker section at all. Sports series such
 * as KXNBA report `quadratic_with_maker_fees` and do charge.
 *
 * There is also no settlement fee and no cancellation fee. So on KXBTCD a
 * resting bid that fills and is held to settlement costs, end to end, nothing.
 * That is not a smaller number than the 3.5c round trip — it is a different
 * kind of number, and it is why a strategy that never crosses the book has
 * room where a momentum strategy has none.
 *
 * Sources: fee schedule PDF effective 2026-07-07; `fee_type` semantics from
 * the Kalshi OpenAPI description; per-series values read from a live
 * GET /series/{ticker}.
 */

/** Kalshi's published per-contract ceiling, as a safety clamp. */
const MAX_PER_CONTRACT_USD = 0.035;
const RATE = 0.07;

/**
 * How far the fee is rounded up.
 *
 * Kalshi rounds so that fee + position cost lands on a boundary, and which
 * boundary depends on how the account clears: direct members round to a
 * centicent, accounts cleared through an FCM round to a whole cent. At one
 * contract the difference is nearly fivefold, so it is not a rounding detail —
 * it decides whether small orders are viable.
 *
 * "cent" is the default because it is the expensive one, and a fee model that
 * errs high can only ever make a strategy look worse than it is. Read
 * `taker_fees_dollars` off a real fill to find out which one this account
 * actually gets, and pass it explicitly once known.
 */
export type FeeRounding = "cent" | "centicent";

function roundUp(usd: number, rounding: FeeRounding): number {
  const step = rounding === "centicent" ? 10_000 : 100;
  return Math.ceil(usd * step - 1e-9) / step;
}

/**
 * Maker cost as a fraction of the taker rate, keyed by Kalshi's per-series
 * `fee_type`.
 *
 * Written as a fraction rather than as a rate because that is the language the
 * exchange uses — the combo tier is documented as "a 0.5 maker multiplier
 * instead of 0.25" — and because a zero is easier to trust when the thing it
 * is a fraction of is visible next to it.
 */
export const MAKER_FRACTION: Readonly<Record<string, number>> = {
  quadratic: 0,
  quadratic_with_maker_fees: 0.25,
  quadratic_with_combo_maker_fees: 0.5,
};

/** The series this engine trades. Named so the zero below is checkable. */
export const ZERO_MAKER_SERIES = ["KXBTCD", "KXBTC", "KXETHD", "KXETH"] as const;

/**
 * Effective maker rate for a series.
 *
 * An unrecognised `fee_type` — a new tier, a `flat` series — falls back to the
 * full taker rate rather than to zero. Guessing "free" about a fee is the one
 * error this file must never make.
 */
export function makerRate(feeType: string): number {
  const fraction = MAKER_FRACTION[feeType];
  return fraction === undefined ? RATE : RATE * fraction;
}

/**
 * Taker fee in dollars for one execution.
 *
 * Rounded up once for the whole order, which is how Kalshi charges it —
 * rounding per contract would overstate the cost of large orders.
 */
export function takerFeeUsd(
  contracts: number,
  priceCents: number,
  rounding: FeeRounding = "cent",
): number {
  if (contracts <= 0) return 0;
  const p = Math.min(1, Math.max(0, priceCents / 100));
  const raw = RATE * contracts * p * (1 - p);
  const capped = Math.min(raw, MAX_PER_CONTRACT_USD * contracts);
  return roundUp(capped, rounding);
}

/**
 * Maker fee in dollars for one execution.
 *
 * Zero on every series whose `fee_type` is plain `quadratic`, which is all of
 * the crypto ladders. Returns an exact 0 rather than a rounded-up fraction of
 * one, because `round_up(0)` is 0 and a resting order that fills should show
 * no cost at all in the ledger.
 */
export function makerFeeUsd(
  contracts: number,
  priceCents: number,
  feeType = "quadratic",
  rounding: FeeRounding = "cent",
): number {
  const rate = makerRate(feeType);
  if (contracts <= 0 || rate === 0) return 0;
  const p = Math.min(1, Math.max(0, priceCents / 100));
  const raw = rate * contracts * p * (1 - p);
  const capped = Math.min(raw, MAX_PER_CONTRACT_USD * contracts);
  return roundUp(capped, rounding);
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

/** One taker execution in cents per contract — what a maker entry still pays on the way out. */
export function takerFeeCentsPerContract(priceCents: number): number {
  const sample = 100;
  return (takerFeeUsd(sample, priceCents) * 100) / sample;
}

/** One maker execution in cents per contract. Zero on the crypto ladders. */
export function makerFeeCentsPerContract(priceCents: number, feeType = "quadratic"): number {
  const sample = 100;
  return (makerFeeUsd(sample, priceCents, feeType) * 100) / sample;
}

/**
 * The smallest order size at which rounding stops dominating, in contracts.
 *
 * At one contract on an 85c favourite the true taker fee is $0.0022 and a
 * cent-rounded account is charged $0.01 — four and a half times the rate. The
 * fix is not to trade less but to trade in one order instead of several, since
 * the round-up happens once per order. Returns 1 for a centicent account,
 * where the problem does not arise.
 */
export function minEfficientOrderSize(
  priceCents: number,
  rounding: FeeRounding = "cent",
  tolerance = 0.1,
): number {
  if (rounding === "centicent") return 1;
  const p = Math.min(1, Math.max(0, priceCents / 100));
  const perContract = RATE * p * (1 - p);
  if (perContract <= 0) return 1;
  // Overpayment is at most one rounding step spread across the order, so the
  // order must be large enough that the step is within tolerance of the rate.
  return Math.max(1, Math.ceil(0.01 / (perContract * tolerance)));
}

/**
 * What a take-profit is actually worth after costs, in cents per contract.
 *
 * Zero or less means the trade cannot make money however often it wins, which
 * is worth refusing rather than discovering across a few hundred fills.
 *
 * A maker entry (resting limit order) pays no fee to open on the crypto
 * ladders, so only the taker exit is charged against it.
 */
export function netEdgeCents(
  takeProfitCents: number,
  priceCents: number,
  makerEntry = false,
): number {
  const fee = makerEntry
    ? takerFeeCentsPerContract(priceCents)
    : roundTripFeeCentsPerContract(priceCents);
  return takeProfitCents - fee;
}

/**
 * The win rate needed to break even, given a take-profit and stop that have
 * both been adjusted for fees. Returns null when no win rate can do it.
 */
export function breakEvenWinRate(
  takeProfitCents: number,
  stopLossCents: number,
  priceCents: number,
  makerEntry = false,
): number | null {
  const fee = makerEntry
    ? takerFeeCentsPerContract(priceCents)
    : roundTripFeeCentsPerContract(priceCents);
  const win = takeProfitCents - fee;
  const loss = stopLossCents + fee;
  if (win <= 0) return null; // no number of wins can pay for the fees
  return loss / (win + loss);
}

/**
 * The settlement rate a rest-and-settle entry has to beat, in percent.
 *
 * A position bought passively and held to resolution has no exit leg and no
 * exit fee, so on a zero-maker series the bar is simply the price paid: buy at
 * 85c and you need the thing to happen 85% of the time. This function exists
 * so that fact is asserted by the code rather than assumed by the reader, and
 * so a series that does charge makers raises the bar visibly.
 */
export function settleBreakEvenPct(bidCents: number, feeType = "quadratic"): number {
  return bidCents + makerFeeCentsPerContract(bidCents, feeType);
}

/**
 * Expected cents per contract from resting at `bidCents` and holding, given a
 * settlement rate in percent. Negative means the price is honest and the
 * spread is not worth crossing for.
 */
export function restAndSettleEdgeCents(
  bidCents: number,
  settleRatePct: number,
  feeType = "quadratic",
): number {
  return settleRatePct - settleBreakEvenPct(bidCents, feeType);
}
