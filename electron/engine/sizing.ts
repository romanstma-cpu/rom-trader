/**
 * How much to bet, once something is worth betting on.
 *
 * The engine currently sizes every trade the same and scales the whole book
 * down as drawdown deepens. The comment on `sizeFactor` explains why Kelly was
 * turned down: it needs a trusted edge estimate, and one computed from a
 * rolling handful of trades is noise wearing the costume of risk management.
 * That objection was right and is not being overturned here. It is being
 * ANSWERED — `skill.ts` produces an edge estimate with an event-clustered
 * interval around it, which is the missing precondition the comment named.
 *
 * So this module is Kelly with the safety catch welded on: it refuses to
 * return a size at all unless a measured skill report says the model has beaten
 * the book on a sample of genuinely independent events. Absent that, the
 * honest answer is still zero, and it returns zero with a reason.
 *
 * WHY OVERCONFIDENCE IS THE FAILURE MODE THAT MATTERS
 *
 * Kelly is violently asymmetric in the direction of a model that believes its
 * own press. Buying a 90c contract while believing 97%, when the truth is 90%,
 * is not a slightly-too-large bet — the formula reads an 70% edge on the
 * remaining ten cents and stakes accordingly, and the losses arrive in exactly
 * the tail the model dismissed. A model that is well calibrated but modest
 * loses money slowly. A model that is overconfident loses the account.
 *
 * Hence shrinkage. The probability that reaches the formula is not the model's
 * own number; it is the model pulled back toward the book by a factor taken
 * from measured performance. When the model is unproven the factor is zero, the
 * shrunken probability IS the market price, the computed edge is nil and the
 * size is nil. The gate and the shrinkage agree by construction rather than by
 * a caller remembering to check both.
 *
 * Structure and the liquidity haircut are adapted from
 * OctagonAI/kalshi-trading-bot-cli (MIT); the calibration gate, the fee-inside-
 * the-price treatment and the shrinkage are this app's.
 */
import { oneLotFeeCents } from "./fairvalue";
import type { FeeRounding } from "./fees";
import type { SkillReport } from "./skill";

/** Independent events below which no sample is worth sizing against. */
export const MIN_EVENTS_TO_SIZE = 20;

/** Fraction of full Kelly. Half is the conventional compromise and it is still aggressive. */
export const DEFAULT_KELLY_FRACTION = 0.5;

/** Never stake more than this share of available bankroll on one market. */
export const DEFAULT_MAX_POSITION_PCT = 0.05;

/** Below this net edge the signal is inside model error and is not traded. */
export const DEFAULT_MIN_EDGE_CENTS = 2;

/** Wider than this and the quote is not a price, it is an invitation. */
export const DEFAULT_MAX_SPREAD_CENTS = 4;

/** Thinner than this and the exit does not exist. */
export const DEFAULT_MIN_VOLUME = 500;

/** What a wide-but-passable market does to the size. */
export const LIQUIDITY_HAIRCUT = 0.5;

/**
 * How much of the model's disagreement with the book to actually believe.
 *
 * Derived from the measured skill score rather than chosen. Skill is
 * `1 - brierModel/brierMarket`, so 0.10 means the model's squared error is a
 * tenth lower than the book's — a real but modest advantage that does not
 * justify taking the model's word over the price. The cap at 0.5 says that
 * even a demonstrably superior model only gets to move half the distance,
 * because every skill estimate here is itself measured with error.
 *
 * The clustered lower bound is used, not the point estimate. Sizing off the
 * middle of a confidence interval is how a merely-plausible edge becomes a
 * position.
 */
export function shrinkFactor(report: SkillReport): number {
  if (report.events < MIN_EVENTS_TO_SIZE) return 0;
  if (report.skillCI[0] <= 0) return 0;
  return Math.max(0, Math.min(0.5, report.skillCI[0]));
}

/**
 * The model's probability pulled toward the book.
 *
 * At factor 0 this returns the market's own number, which is the correct
 * behaviour for an unproven model: it makes the edge vanish rather than
 * requiring the caller to remember a separate check.
 */
export function shrinkProb(modelProb: number, marketProb: number, factor: number): number {
  return marketProb + factor * (modelProb - marketProb);
}

/**
 * Kelly fraction for a binary contract bought at `costFraction` of a dollar.
 *
 * f* = (p - c) / (1 - c), where c is what the contract costs INCLUDING fee and
 * p is the probability it settles in the money. Folding the fee into the cost
 * rather than subtracting it afterward matters at the deep-favourite prices
 * this model wants to trade: at 95c the fee is a whole cent on a five-cent
 * payoff, which is a fifth of the upside, and a formula that treats it as an
 * afterthought will size as though it were not there.
 */
export function kellyFraction(prob: number, costFraction: number): number {
  if (costFraction <= 0 || costFraction >= 1) return 0;
  if (prob <= costFraction) return 0;
  return (prob - costFraction) / (1 - costFraction);
}

export interface SizeInput {
  /** What the model thinks, 0..1, for the side being bought. */
  modelProb: number;
  /** What the book implies for that same side, 0..1. */
  marketProb: number;
  /** Cost of one contract of the side being bought, 1..99 cents. */
  priceCents: number;
  /** Spendable cash in cents — already net of open exposure. */
  bankrollCents: number;
  /** The measured scorecard for the model producing this signal. */
  report: SkillReport;
  spreadCents?: number;
  volume?: number;
  kellyFractionMultiplier?: number;
  maxPositionPct?: number;
  minEdgeCents?: number;
  maxSpreadCents?: number;
  minVolume?: number;
  rounding?: FeeRounding;
}

export interface SizeResult {
  contracts: number;
  /** Cash committed, cents, fee included. */
  costCents: number;
  /** The probability actually used, after shrinkage. */
  usedProb: number;
  shrink: number;
  /** Net cents of edge per contract after fee, at the shrunken probability. */
  netEdgeCents: number;
  rawKelly: number;
  appliedKelly: number;
  liquidityAdjusted: boolean;
  /** Populated whenever contracts is 0 — always says which gate closed. */
  reason: string;
}

/**
 * Contracts to buy, or zero and the reason why.
 *
 * The gates run in a deliberate order — cheapest and most fundamental first,
 * so the reported reason is the most informative one rather than whichever
 * check happened to be written last. An unproven model should be told it is
 * unproven, not that the spread was wide.
 */
export function sizePosition(input: SizeInput): SizeResult {
  const {
    modelProb,
    marketProb,
    priceCents,
    bankrollCents,
    report,
    spreadCents,
    volume,
    kellyFractionMultiplier = DEFAULT_KELLY_FRACTION,
    maxPositionPct = DEFAULT_MAX_POSITION_PCT,
    minEdgeCents = DEFAULT_MIN_EDGE_CENTS,
    maxSpreadCents = DEFAULT_MAX_SPREAD_CENTS,
    minVolume = DEFAULT_MIN_VOLUME,
    rounding = "cent",
  } = input;

  const shrink = shrinkFactor(report);
  const usedProb = shrinkProb(modelProb, marketProb, shrink);
  const feeCents = oneLotFeeCents(priceCents, rounding);
  const costCentsPer = priceCents + feeCents;
  const netEdgeCents = usedProb * 100 - costCentsPer;

  const nothing = (reason: string): SizeResult => ({
    contracts: 0,
    costCents: 0,
    usedProb,
    shrink,
    netEdgeCents,
    rawKelly: 0,
    appliedKelly: 0,
    liquidityAdjusted: false,
    reason,
  });

  if (report.events < MIN_EVENTS_TO_SIZE) {
    return nothing(
      `Model unproven: ${report.events} independent events, need ${MIN_EVENTS_TO_SIZE}. ` +
        `Kelly's answer on an unmeasured edge is zero.`,
    );
  }
  if (report.skillCI[0] <= 0) {
    return nothing(
      `Model has not beaten the book: clustered skill interval ` +
        `[${(report.skillCI[0] * 100).toFixed(1)}%, ${(report.skillCI[1] * 100).toFixed(1)}%] includes zero.`,
    );
  }
  if (priceCents <= 0 || priceCents >= 100) {
    return nothing(`Price ${priceCents}c is outside the tradeable range.`);
  }
  if (bankrollCents <= 0) {
    return nothing(`No available bankroll.`);
  }
  if (netEdgeCents < minEdgeCents) {
    return nothing(
      `Net edge ${netEdgeCents.toFixed(2)}c below the ${minEdgeCents}c floor ` +
        `(shrunk ${(modelProb * 100).toFixed(1)}% to ${(usedProb * 100).toFixed(1)}%, fee ${feeCents}c).`,
    );
  }
  if (spreadCents != null && spreadCents > maxSpreadCents) {
    return nothing(`Spread ${spreadCents}c exceeds the ${maxSpreadCents}c limit.`);
  }
  if (volume != null && volume < minVolume) {
    return nothing(`Volume ${volume} below the ${minVolume} floor — no exit.`);
  }

  const rawKelly = kellyFraction(usedProb, costCentsPer / 100);
  let applied = rawKelly * kellyFractionMultiplier;

  // A market that clears the hard gates but is still thin gets sized as though
  // it were half as attractive. The alternative is a binary cliff where a
  // one-cent change in the spread doubles the position.
  const thin =
    (spreadCents != null && spreadCents > Math.max(1, maxSpreadCents - 2)) ||
    (volume != null && volume < minVolume * 4);
  if (thin) applied *= LIQUIDITY_HAIRCUT;

  const capCents = Math.floor(maxPositionPct * bankrollCents);
  const stakeCents = Math.min(Math.floor(applied * bankrollCents), capCents);
  const contracts = Math.floor(stakeCents / costCentsPer);

  if (contracts <= 0) {
    return {
      contracts: 0,
      costCents: 0,
      usedProb,
      shrink,
      netEdgeCents,
      rawKelly,
      appliedKelly: applied,
      liquidityAdjusted: thin,
      reason:
        `Position rounds to zero contracts — ${(applied * 100).toFixed(2)}% of ` +
        `$${(bankrollCents / 100).toFixed(2)} will not buy one lot at ${costCentsPer}c.`,
    };
  }

  return {
    contracts,
    costCents: contracts * costCentsPer,
    usedProb,
    shrink,
    netEdgeCents,
    rawKelly,
    appliedKelly: applied,
    liquidityAdjusted: thin,
    reason: `${contracts} contracts at ${costCentsPer}c (fee included), ${netEdgeCents.toFixed(2)}c edge each.`,
  };
}
