import { TradingEngine, memoryStore } from "./engine";
import type { KalshiMarket } from "./kalshi";
import type { RecordedScan } from "./recorder";
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
}

/** The engine members a replay needs, which are private for live use. */
interface Drivable {
  status: string;
  updatePositions: (m: KalshiMarket[]) => void;
  scanForEntries: (m: KalshiMarket[], t: number) => void;
  enforceDailyLossLimit: () => void;
  enforceLosingStreak: () => void;
  equity: () => number;
}

export function runBacktest(
  scans: RecordedScan[],
  settings: Settings,
  label: string,
): BacktestResult {
  const store = memoryStore();
  // liveMode is forced off: a replay must never be able to place an order,
  // whatever the settings being tested happen to say.
  const engine = new TradingEngine(
    { ...settings, liveMode: false },
    { apiKeyId: "", apiPrivateKeyPem: "" },
    store,
  );
  const drivable = engine as unknown as Drivable;
  drivable.status = "running";

  const equity: { ts: number; equityUsd: number }[] = [];

  for (const scan of scans) {
    if (drivable.status !== "running") break; // a brake stopped it
    drivable.updatePositions(scan.markets);
    drivable.scanForEntries(scan.markets, scan.ts);
    drivable.enforceDailyLossLimit();
    drivable.enforceLosingStreak();
    equity.push({ ts: scan.ts, equityUsd: round2(drivable.equity()) });
  }

  // Close whatever is still open, so two runs are compared on realised
  // results rather than on how kindly the recording happened to end.
  engine.flatten();

  const state = engine.getState();
  const history = store.loadHistory();
  return summarise(label, history, equity, state.haltedReason);
}

function summarise(
  label: string,
  history: TradeRecord[],
  equity: { ts: number; equityUsd: number }[],
  haltedReason: string | null,
): BacktestResult {
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
