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
    | "maxPositionsPerEvent"
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
    | "makerEntries"
    | "makerTtlTicks"
    | "minNetEdgeCents"
    | "regimeFilterEnabled"
    | "maxDrawdownPct"
    | "momentumOnBid"
    | "requireTradeActivity"
    | "makerExits"
    | "minMinutesToClose"
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
      maxPositionsPerEvent: 1,
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
      makerEntries: false,
      makerTtlTicks: 4,
      minNetEdgeCents: 3,
      regimeFilterEnabled: false,
      maxDrawdownPct: 15,
      momentumOnBid: true,
      requireTradeActivity: true,
      makerExits: false,
      minMinutesToClose: 45,
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
      maxPositionsPerEvent: 1,
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
      makerEntries: false,
      makerTtlTicks: 4,
      minNetEdgeCents: 2,
      regimeFilterEnabled: false,
      maxDrawdownPct: 20,
      momentumOnBid: true,
      requireTradeActivity: true,
      makerExits: false,
      minMinutesToClose: 30,
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
      maxPositionsPerEvent: 1,
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
      makerEntries: false,
      makerTtlTicks: 4,
      minNetEdgeCents: 2,
      regimeFilterEnabled: false,
      maxDrawdownPct: 25,
      momentumOnBid: true,
      requireTradeActivity: true,
      makerExits: false,
      minMinutesToClose: 15,
    },
  },
  {
    id: "patient",
    name: "Patient",
    tagline: "Rests at the bid. Pays no entry fee, waits for its price.",
    detail:
      "Enters with a resting limit order at the bid instead of crossing the spread — the one " +
      "change the simulations found that alters the sign of the cost, not just its size. No " +
      "taker fee on entry, no spread paid on entry; the price is that many orders expire " +
      "unfilled, and the fills that do arrive come when the price dips back. Skips markets " +
      "whose recent moves have been reversing rather than trending.",
    risk: "medium",
    params: {
      tradeSizeUsd: 8,
      maxPositions: 4,
      maxPositionsPerEvent: 1,
      momentumThresholdCents: 4,
      takeProfitCents: 12,
      stopLossCents: 12,
      tickSeconds: 15,
      // The spread is not paid on entry, so a wider book is tolerable here —
      // it only affects how far the take-profit is, not the cost of getting in.
      maxSpreadCents: 3,
      minPriceCents: 10,
      maxPriceCents: 85,
      dailyLossLimitUsd: 25,
      reentryCooldownSeconds: 120,
      maxConsecutiveLosses: 4,
      trailingStopCents: 0,
      makerEntries: true,
      // Six scans at 15s: ninety seconds for someone to sell into the bid
      // before the momentum that justified the order has gone stale.
      makerTtlTicks: 6,
      minNetEdgeCents: 3,
      regimeFilterEnabled: true,
      maxDrawdownPct: 15,
      momentumOnBid: true,
      requireTradeActivity: true,
      makerExits: false,
      minMinutesToClose: 30,
    },
  },
];

export function findStrategy(id: string): Strategy | undefined {
  return STRATEGIES.find((s) => s.id === id);
}
