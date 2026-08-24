import { TradingEngine, memoryStore } from "./engine";
import type { KalshiMarket } from "./kalshi";
import { computeMetrics, type PerformanceMetrics } from "./metrics";
import { segmentScans, type RecordedScan } from "./recorder";
import { STRATEGIES } from "./strategies";
import { DEFAULT_SETTINGS, type Settings, type TradeRecord } from "./store";

/**
 * Replays recorded market data through the real engine.
 *
 * The engine is driven directly rather than reimplemented: a backtest built on
 * a copy of the rules drifts from the live bot and then confidently reports
 * results for software nobody is running. The private tick internals are
 * reached deliberately — see the cast below.
 */

export interface BacktestResult {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pnlUsd: number;
  /** Largest peak-to-trough fall in running equity, as a positive number. */
  maxDrawdownUsd: number;
  bestUsd: number;
  worstUsd: number;
  /** Ended early because a brake tripped. */
  halted: boolean;
  haltedReason: string | null;
  equity: { ts: number; equityUsd: number }[];
  exitReasons: Record<string, number>;
  /** Profit factor, expectancy, per-trade Sharpe/Sortino and the rest. */
  metrics: PerformanceMetrics;
  /** True when this configuration entered with resting maker orders. */
  maker: boolean;
  /** Resting orders placed / filled / expired — the numbers maker mode lives by. */
  ordersPlaced: number;
  ordersFilled: number;
  ordersExpired: number;
}

/** The engine members a replay needs, which are private for live use. */
interface Drivable {
  status: string;
  processPendingOrders: (m: KalshiMarket[]) => void;
  updatePositions: (m: KalshiMarket[]) => void;
  scanForEntries: (m: KalshiMarket[], t: number) => void;
  enforceDailyLossLimit: () => void;
  enforceLosingStreak: () => void;
  enforceMaxDrawdown: () => void;
  equity: () => number;
}

export function runBacktest(
  scans: RecordedScan[],
  settings: Settings,
  label: string,
): BacktestResult {
  // One shared ledger across every segment, the way history.json persists
  // across engine restarts in the app — so the daily-loss brake still sees
  // the whole day. Each segment gets a fresh engine, the way a restart
  // clears positions, cash and price history.
  const store = memoryStore();
  const equity: { ts: number; equityUsd: number }[] = [];
  let haltedReason: string | null = null;
  let ordersPlaced = 0;
  let ordersFilled = 0;
  let ordersExpired = 0;

  for (const seg of segmentScans(scans)) {
    // liveMode is forced off: a replay must never be able to place an order,
    // whatever the settings being tested happen to say.
    const engine = new TradingEngine(
      { ...settings, liveMode: false },
      { apiKeyId: "", apiPrivateKeyPem: "" },
      store,
    );
    const drivable = engine as unknown as Drivable;
    drivable.status = "running";

    for (const scan of seg) {
      if (drivable.status !== "running") break; // a brake stopped it
      // Mirrors the order in tick(); a step left out here passes in replays
      // and then behaves differently in the running app.
      drivable.processPendingOrders(scan.markets);
      drivable.updatePositions(scan.markets);
      drivable.scanForEntries(scan.markets, scan.ts);
      drivable.enforceDailyLossLimit();
      drivable.enforceLosingStreak();
      drivable.enforceMaxDrawdown();
      equity.push({ ts: scan.ts, equityUsd: round2(drivable.equity()) });
    }

    // Close whatever is still open, so two runs are compared on realised
    // results rather than on how kindly the recording happened to end.
    engine.flatten("recording ended");

    const logs = engine.getLogs();
    ordersPlaced += logs.filter((l) => l.msg.startsWith("REST ")).length;
    ordersFilled += logs.filter((l) => l.msg.startsWith("FILL ")).length;
    ordersExpired += logs.filter((l) => l.msg.startsWith("EXPIRE ")).length;

    haltedReason = engine.getState().haltedReason;
    // A brake that fired would, live, leave the engine stopped until someone
    // came back to it — later segments do not get to pretend otherwise.
    if (haltedReason !== null) break;
  }

  return {
    ...summarise(label, store.loadHistory(), equity, haltedReason),
    maker: settings.makerEntries,
    ordersPlaced,
    ordersFilled,
    ordersExpired,
  };
}

function summarise(
  label: string,
  history: TradeRecord[],
  equity: { ts: number; equityUsd: number }[],
  haltedReason: string | null,
): Omit<BacktestResult, "maker" | "ordersPlaced" | "ordersFilled" | "ordersExpired"> {
  const wins = history.filter((t) => t.pnlUsd > 0).length;
  const losses = history.filter((t) => t.pnlUsd < 0).length;
  const pnl = history.reduce((s, t) => s + t.pnlUsd, 0);

  let peak = equity.length > 0 ? equity[0].equityUsd : 0;
  let maxDrawdown = 0;
  for (const p of equity) {
    if (p.equityUsd > peak) peak = p.equityUsd;
    const dd = peak - p.equityUsd;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const exitReasons: Record<string, number> = {};
  for (const t of history) exitReasons[t.reason] = (exitReasons[t.reason] ?? 0) + 1;

  return {
    label,
    trades: history.length,
    wins,
    losses,
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    pnlUsd: round2(pnl),
    maxDrawdownUsd: round2(maxDrawdown),
    bestUsd: round2(history.reduce((m, t) => Math.max(m, t.pnlUsd), 0)),
    worstUsd: round2(history.reduce((m, t) => Math.min(m, t.pnlUsd), 0)),
    halted: haltedReason !== null,
    haltedReason,
    equity,
    exitReasons,
    metrics: computeMetrics(history, equity),
  };
}

/**
 * Runs the current settings alongside every shipped preset over the same data.
 *
 * A single number means little; the same recording run through four configs
 * is the comparison that turns "these presets are reasoned guesses" into
 * something measured.
 */
export function compareStrategies(scans: RecordedScan[], current: Settings): BacktestResult[] {
  const results = [runBacktest(scans, current, "Your settings")];
  for (const s of STRATEGIES) {
    results.push(
      runBacktest(scans, { ...DEFAULT_SETTINGS, ...s.params, dryRunCash: current.dryRunCash }, s.name),
    );
  }
  return results;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
