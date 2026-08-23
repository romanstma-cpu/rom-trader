import { Settings } from "./store";

export interface Strategy {
  id: string;
  name: string;
  tagline: string;
  detail: string;
  risk: "low" | "medium" | "high";
  /** Only the engine knobs — keys, live mode and paper cash are never touched. */
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
  >;
}

/**
 * Shipped presets. These are starting points chosen for how the momentum rule
 * behaves — not backtested edges. The copy in the UI says so plainly; nothing
 * here has a demonstrated forward edge and every preset defaults to dry-run.
 */
export const STRATEGIES: Strategy[] = [
  {
    id: "steady",
    name: "Steady",
    tagline: "Small size, wide stops, few positions.",
    detail:
      "Waits for a clear 4c push before entering and gives each trade room to breathe. " +
      "Fewest trades of the three, so a single bad fill matters less. Start here.",
    risk: "low",
    params: {
      tradeSizeUsd: 5,
      maxPositions: 3,
      momentumThresholdCents: 4,
      takeProfitCents: 7,
      stopLossCents: 5,
      tickSeconds: 20,
      maxSpreadCents: 2,
      minPriceCents: 10,
      maxPriceCents: 85,
      dailyLossLimitUsd: 25,
    },
  },
  {
    id: "balanced",
    name: "Balanced",
    tagline: "The default. Moderate size and turnover.",
    detail:
      "The stock configuration: a 3c momentum trigger, five concurrent positions and a " +
      "6c/4c profit-to-stop ratio. A reasonable middle ground while you learn how the " +
      "engine behaves on live prices.",
    risk: "medium",
    params: {
      tradeSizeUsd: 10,
      maxPositions: 5,
      momentumThresholdCents: 3,
      takeProfitCents: 6,
      stopLossCents: 4,
      tickSeconds: 15,
      maxSpreadCents: 2,
      minPriceCents: 5,
      maxPriceCents: 90,
      dailyLossLimitUsd: 50,
    },
  },
  {
    id: "scalper",
    name: "Scalper",
    tagline: "Fast ticks, tight stops, more trades.",
    detail:
      "Polls every 8 seconds and takes 2c moves, exiting quickly in both directions. " +
      "Generates far more trades, which means fees and spread cost dominate — the most " +
      "likely of the three to bleed. Paper-trade this one first.",
    risk: "high",
    params: {
      tradeSizeUsd: 8,
      maxPositions: 8,
      momentumThresholdCents: 2,
      takeProfitCents: 3,
      stopLossCents: 3,
      tickSeconds: 8,
      maxSpreadCents: 1,
      minPriceCents: 15,
      maxPriceCents: 85,
      dailyLossLimitUsd: 40,
    },
  },
];

export function findStrategy(id: string): Strategy | undefined {
  return STRATEGIES.find((s) => s.id === id);
}
