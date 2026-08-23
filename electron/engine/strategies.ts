import { Settings } from "./store";

export interface Strategy {
  id: string;
  name: string;
  tagline: string;
  detail: string;
  risk: "low" | "medium" | "high";
  /**
   * Only the engine knobs — keys, live mode and paper cash are never touched.
   * Trading hours are deliberately absent too: when someone is willing to let
   * the bot trade is a fact about them, not about the strategy.
   */
  params: Pick<
    Settings,
    | "tradeSizeUsd"
    | "maxPositions"
    | "momentumThresholdCents"
    | "takeProfitCents"
    | "stopLossCents"
    | "tickSeconds"
    | "maxSpreadCents"
    | "minPriceCents"
    | "maxPriceCents"
    | "dailyLossLimitUsd"
    | "reentryCooldownSeconds"
    | "maxConsecutiveLosses"
    | "trailingStopCents"
  >;
}

/**
 * Shipped presets. These are starting points chosen for how the momentum rule
 * behaves — not backtested edges. The copy in the UI says so plainly; nothing
 * here has a demonstrated forward edge and every preset defaults to dry-run.
 *
 * Every preset keeps take-profit strictly above stop-loss: at parity you need
 * to win well over half your trades just to cover the spread you pay on entry.
 */
export const STRATEGIES: Strategy[] = [
  {
    id: "steady",
    name: "Steady",
    tagline: "Small size, wide stops, few positions.",
    detail:
      "Waits for a clear 4c push, then targets 14c with 14c of room. Fewest trades of " +
      "the three, and the widest margin over the round-trip fee. Start here.",
    risk: "low",
    params: {
      tradeSizeUsd: 5,
      maxPositions: 3,
      momentumThresholdCents: 4,
      takeProfitCents: 14,
      stopLossCents: 14,
      tickSeconds: 20,
      maxSpreadCents: 2,
      minPriceCents: 10,
      maxPriceCents: 85,
      dailyLossLimitUsd: 25,
      reentryCooldownSeconds: 180,
      // Few trades, so a run of losses is a real signal rather than noise.
      maxConsecutiveLosses: 3,
      trailingStopCents: 0,
    },
  },
  {
    id: "balanced",
    name: "Balanced",
    tagline: "The default. Moderate size and turnover.",
    detail:
      "The stock configuration: a 3c momentum trigger, five concurrent positions, and a " +
      "12c target with 12c of room — wide enough that the round-trip fee and the spread " +
      "do not decide the outcome. A middle ground while you learn how the engine behaves.",
    risk: "medium",
    params: {
      tradeSizeUsd: 10,
      maxPositions: 5,
      momentumThresholdCents: 3,
      takeProfitCents: 12,
      stopLossCents: 12,
      tickSeconds: 15,
      maxSpreadCents: 2,
      minPriceCents: 5,
      maxPriceCents: 90,
      dailyLossLimitUsd: 50,
      reentryCooldownSeconds: 90,
      maxConsecutiveLosses: 4,
      trailingStopCents: 0,
    },
  },
  {
    id: "scalper",
    name: "Scalper",
    tagline: "Fast ticks, tight stops, more trades.",
    detail:
      "Polls every 8 seconds and enters on a 2c push, taking 8c and stopping at 8c. " +
      "Generates far more trades, which means fees and spread cost dominate — the most " +
      "likely of the three to bleed. Paper-trade this one first.",
    risk: "high",
    params: {
      tradeSizeUsd: 8,
      maxPositions: 8,
      momentumThresholdCents: 2,
      takeProfitCents: 8,
      stopLossCents: 8,
      tickSeconds: 8,
      maxSpreadCents: 1,
      minPriceCents: 15,
      maxPriceCents: 85,
      dailyLossLimitUsd: 40,
      reentryCooldownSeconds: 30,
      // Many small trades, so short losing runs are ordinary variance.
      maxConsecutiveLosses: 6,
      trailingStopCents: 0,
    },
  },
];

export function findStrategy(id: string): Strategy | undefined {
  return STRATEGIES.find((s) => s.id === id);
}
