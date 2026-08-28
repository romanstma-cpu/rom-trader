import * as crypto from "node:crypto";
import type { Credentials } from "./credentials";
import { KalshiApiError, KalshiClient, KalshiMarket } from "./kalshi";
// Aliased on import so the static below reads as delegation rather than
// recursion, and so nothing inside this file can reach for the bare name.
import { eventOf as eventLadderOf } from "./skill";
import {
  netEdgeCents,
  roundTripFeeCentsPerContract,
  takerFeeCentsPerContract,
  takerFeeUsd,
} from "./fees";
import {
  DEFAULT_RISK_STATE,
  EquityPoint,
  RiskState,
  Settings,
  TradeRecord,
  appendEquity,
  appendHistory,
  loadHistory,
  loadRiskState,
  saveRiskState,
} from "./store";

export interface Position {
  ticker: string;
  title: string;
  side: "yes";
  entryCents: number;
  contracts: number;
  currentBidCents: number;
  peakMidCents: number;
  unrealizedUsd: number;
  /** Taker fee already paid to open, carried so the exit can net it out. */
  entryFeeUsd: number;
  /** Price of the resting take-profit sell, when maker exits are on. */
  tpRestingCents: number | null;
  /** Kalshi's id for that resting sell in live mode. */
  tpOrderId: string | null;
  openedAt: number;
  /** A live closing sell is in flight; nothing else may send a second one. */
  exiting?: boolean;
  /**
   * Deduplication key for this position's closing sell, minted once and reused
   * by every attempt. A sell whose answer was lost may still have executed, so
   * a retry has to be the *same* order to Kalshi rather than another one —
   * without it, re-sending is how one exit becomes an accidental short.
   */
  exitClientOrderId?: string | null;
  /** Closing sells attempted so far; capped by MAX_EXIT_ATTEMPTS. */
  exitAttempts?: number;
}

/** One tracked observation of a market: what the scanner remembers per scan. */
export interface MarketSample {
  mid: number;
  bid: number;
  /** Cumulative contracts traded, straight from the API. */
  volume: number;
}

/**
 * A resting maker order that has not filled yet.
 *
 * Its cash is already debited — Kalshi reserves balance for resting orders,
 * and paper mode mirrors that so the two report the same number. The money
 * comes back if the order expires unfilled.
 */
export interface PendingOrder {
  ticker: string;
  title: string;
  side: "yes";
  limitCents: number;
  contracts: number;
  /** Cash reserved at placement; refunded on expiry or cancellation. */
  costUsd: number;
  placedAt: number;
  /** Scans left before the order is cancelled unfilled. */
  ticksLeft: number;
  /** Kalshi's order id in live mode; null on paper. */
  orderId: string | null;
}

/** One market the scanner looked at on the most recent tick. */
export interface Signal {
  ticker: string;
  title: string;
  midCents: number;
  bidCents: number;
  askCents: number;
  spreadCents: number;
  changeCents: number | null; // null until enough samples exist
  eligible: boolean;
  reason: string;
  ts: number;
}

export interface ScannerStats {
  marketsScanned: number;
  tracked: number;
  eligible: number;
  skippedSpread: number;
  skippedPrice: number;
  skippedWarmup: number;
  skippedCooldown: number;
  /** Refused because the event ladder is already held or locked by a sibling's loss. */
  skippedEvent: number;
  /** Refused because the move was one jump rather than a consistent climb. */
  skippedJumpy: number;
  /** Blocked because the clock is outside the configured trading window. */
  skippedClock: number;
  /** Blocked because the take-profit cannot clear the fees by enough. */
  skippedFees: number;
  /** Blocked because recent moves have been mean-reverting, not trending. */
  skippedRegime: number;
  /** Blocked because the quotes moved but no contracts traded. */
  skippedQuiet: number;
  /** Blocked because the market closes too soon — the endgame is not momentum. */
  skippedClosing: number;
  scanMs: number;
}

export interface EngineState {
  status: "stopped" | "running" | "error";
  dryRun: boolean;
  authConfigured: boolean;
  cashUsd: number;
  equityUsd: number;
  sessionPnlUsd: number;
  allTimePnlUsd: number;
  todayPnlUsd: number;
  wins: number;
  losses: number;
  winRate: number | null;
  positions: Position[];
  pendingOrders: PendingOrder[];
  maxPositions: number;
  lastTickAt: number | null;
  lastError: string | null;
  haltedReason: string | null;
  scanner: ScannerStats | null;
  /** Set when scans keep finding nothing, naming the filter doing the blocking. */
  idleHint: string | null;
  startedAt: number | null;
}

export interface LogLine {
  ts: number;
  level: "info" | "trade" | "warn" | "error";
  msg: string;
}

/**
 * Something worth interrupting the user for.
 *
 * Separate from the log, which records everything: a bot that runs in the
 * background is only useful if the handful of things that actually matter can
 * reach someone who is looking at a different window.
 */
export interface EngineEvent {
  kind: "opened" | "closed" | "halted";
  title: string;
  body: string;
  tone: "good" | "bad" | "info";
}

/**
 * Where results are kept.
 *
 * Injected so a backtest can run the engine's real rules against an in-memory
 * ledger instead of the user's trade history. Reimplementing the rules for
 * replay would produce a backtest that slowly stops describing the live bot,
 * which is worse than having none.
 */
export interface EngineStore {
  loadHistory(): TradeRecord[];
  appendHistory(t: TradeRecord): void;
  appendEquity(p: EquityPoint): void;
  loadRiskState(): RiskState;
  saveRiskState(s: RiskState): void;
}

const LIVE_STORE: EngineStore = {
  loadHistory,
  appendHistory,
  appendEquity,
  loadRiskState,
  saveRiskState,
};

/** A ledger that exists only for the duration of a replay. */
export function memoryStore(): EngineStore {
  const history: TradeRecord[] = [];
  const equity: EquityPoint[] = [];
  let risk: RiskState = { ...DEFAULT_RISK_STATE };
  return {
    loadHistory: () => history,
    appendHistory: (t) => void history.push(t),
    appendEquity: (p) => void equity.push(p),
    loadRiskState: () => risk,
    saveRiskState: (s) => {
      risk = s;
    },
  };
}

type Listener = {
  onState: (s: EngineState) => void;
  onLog: (l: LogLine) => void;
  /** Optional: not every subscriber wants to be told about notable events. */
  onEvent?: (e: EngineEvent) => void;
};

/**
 * Simple momentum engine:
 * polls the most active Kalshi markets, tracks the YES mid-price, and
 * paper-buys YES when the mid rises by the configured threshold over the
 * lookback window. Exits on take-profit, stop-loss, or momentum reversal.
 * Live mode places real orders only when explicitly enabled with API keys.
 */
export class TradingEngine {
  private settings: Settings;
  private store: EngineStore;
  /** Set by main; left unset in tests and replays so nothing touches disk. */
  private record: ((m: KalshiMarket[]) => void) | null = null;
  private client: KalshiClient;
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private listeners: Listener[] = [];
  private logs: LogLine[] = [];

  private status: EngineState["status"] = "stopped";
  private lastError: string | null = null;
  private haltedReason: string | null = null;
  private lastTickAt: number | null = null;
  private startedAt: number | null = null;
  private cashUsd = 0;
  private sessionRealizedUsd = 0;
  private positions: Position[] = [];
  private pendingOrders: PendingOrder[] = [];
  /** Session-high equity, for the drawdown brake and drawdown-scaled sizing. */
  private peakEquityUsd = 0;

  /**
   * Recent observations per ticker.
   *
   * The bid and cumulative volume ride along with the mid because the mid
   * alone lies: it moves half of any one-sided quote change, so a seller
   * pulling an ask reads as buying pressure when nothing traded at all. Real
   * recordings showed books with 7c median spreads doing exactly this.
   */
  private priceHistory = new Map<string, MarketSample[]>();
  private cooldownUntil = new Map<string, number>(); // ticker -> ms timestamp
  /**
   * Event ladder -> when its lockout lifts, and which market earned it.
   *
   * The losing ticker is carried because the signal has to be able to say
   * whether the stop happened here or next door, and it can no longer infer
   * that from the ticker. Under the old strike-suffix rule a market that was
   * its own event kept its whole ticker as the event key, so `eventOf(t) === t`
   * meant "no siblings"; under the last-dash rule every real Kalshi ticker
   * loses its outcome segment, so that test is true only for the dashless
   * tickers that exist in tests. Left alone it would have quietly relabelled
   * every ordinary lockout as a sibling's fault.
   */
  private eventLockoutUntil = new Map<string, { until: number; lostTicker: string }>();
  /**
   * The scan clock: the current tick's own timestamp, set at the top of
   * tick() live and by the replay driver for every recorded scan. Everything
   * time-shaped inside the scan path — cooldowns, lockouts, trade timestamps
   * — reads this through now(), never Date.now() directly. The close gate
   * already learned this the hard way in 1.9.3; the cooldowns had the same
   * bug in the other direction, quietly never expiring inside a replay
   * because an hour of wall clock never passes during one.
   */
  private clockMs = 0;
  private signals: Signal[] = [];
  private scanner: ScannerStats | null = null;
  private emptyScans = 0;

  private static readonly LOOKBACK = 3; // samples back for momentum
  private static readonly MAX_HISTORY = 20;
  private static readonly MAX_SIGNALS = 60;
  /**
   * Closing sells tried before the engine stops and hands the position back to
   * the user. Each attempt reuses one client_order_id, so re-sending cannot
   * double-sell; the cap exists because a market that keeps refusing the sell
   * is a situation retrying will not fix.
   */
  private static readonly MAX_EXIT_ATTEMPTS = 3;
  /**
   * Scans a market must be watched before the regime filter will judge it —
   * lag1Autocorrelation needs eight changes, so nine prices. With the filter
   * on, younger markets are refused rather than waved through: both live
   * loss clusters were fills in markets the engine had known for a minute.
   */
  private static readonly MIN_REGIME_SAMPLES = 9;

  /**
   * How long a ticker stays untouchable after losing in it.
   *
   * A stop-out is the market disproving the signal right there, and the
   * ordinary cooldown let the same dying momentum re-trigger minutes later:
   * across the first day of live soaking, eight re-entries into tickers that
   * had already lost went one for eight, −$11.36 — a fifth of every dollar
   * lost. An hour is effectively the rest of these markets' lives, so the
   * rule is one disproof per market. Winning exits keep the short configured
   * cooldown — re-entering strength is a different claim — and setting the
   * cooldown to zero still disables both, churn being the user's right.
   */
  private static readonly LOSS_LOCKOUT_MS = 60 * 60_000;

  /**
   * The event ladder a market belongs to: KXBTCD-26AUG2420-T78699.99 and
   * KXBTCD-26AUG2420-T78799.99 are both KXBTCD-26AUG2420. Siblings settle on
   * one outcome, so they move together — a fact the ledger, the cooldowns and
   * the losing-streak brake all need.
   *
   * Until 1.13.2 this stripped a `-T…`/`-B…` strike suffix and nothing else,
   * which quietly under-grouped every series whose outcome segment is not a
   * strike. Measured over the settlement record, that left nine series where
   * siblings shared an event and the engine saw one event per market:
   * KXCRYPTOLEAD15M (five mutually exclusive "which coin leads" outcomes),
   * KXDJI, KXAPRPOTUSD and KXYTVIEWSW (strike ladders whose lines are bare
   * numbers — `53190.00`, `39.1`, `14.5M`), the football series (home / away /
   * tie) and KXCBDECISIONKOREA. On those, `maxPositionsPerEvent` and the
   * ladder lockout never fired at all, so the engine could stack the exact
   * correlated cascade the 1.10.0 cap was added to stop — and the recorded
   * scans are full of them: 886 of 3,950 in the live log, 1,088 of 5,607 in
   * the archive, held up to nine siblings deep.
   *
   * So it now shares `skill.eventOf`, which splits at the last dash. One
   * definition for the risk limits and for every study that reports how many
   * independent events a result rests on; two definitions is how they came to
   * disagree in the first place. Broadening only ever refuses entries, never
   * creates one. Tickers with no dash remain their own event.
   */
  static eventOf(ticker: string): string {
    return eventLadderOf(ticker);
  }

  /**
   * Whether a price series rose on most of its steps, not just in total.
   *
   * Entries are long-YES on a positive net move, so only upward consistency
   * is asked for: strictly more than half of the steps must rise. Flat
   * steps count against, deliberately — one gapped tick followed by two
   * flat scans is a jump the market is sitting on, not a climb, and the
   * jump-then-revert shape is what the instant-stop autopsy was full of.
   * With the standard four-point window this means two of three steps up.
   */
  static consistentClimb(prices: number[]): boolean {
    const steps = prices.length - 1;
    if (steps < 1) return false;
    let ups = 0;
    for (let i = 1; i < prices.length; i++) {
      if (prices[i] > prices[i - 1]) ups++;
    }
    return ups * 2 > steps;
  }

  /**
   * The most of the trade budget a single stop-out may cost.
   *
   * Sizing by cost alone made dollar risk explode on cheap strikes: $10 at
   * 15c bought 66 contracts, so the same 12c stop that costs $2.40 at 50c
   * cost $7.92 — the first live soak's worst trade, nearly half its losses
   * in one fill. At 0.25 the cap reproduces the historic sizing at mid
   * prices exactly (20 contracts at 50c with a 12c stop) and only shrinks
   * the tails: cheap strikes, and wide stops, now risk the same dollars as
   * everything else.
   */
  private static readonly MAX_STOP_FRACTION = 0.25;

  /** Contracts affordable at this price AND within the stop-risk budget. */
  private sizeContracts(priceCents: number, factor: number): number {
    const budget = this.settings.tradeSizeUsd * factor;
    const byCost = Math.floor((budget * 100) / Math.max(1, priceCents));
    const byRisk = Math.floor(
      (budget * TradingEngine.MAX_STOP_FRACTION * 100) /
        Math.max(1, this.settings.stopLossCents),
    );
    return Math.min(byCost, byRisk);
  }

  /** Live orders still in flight, so a quit can wait for them to land. */
  private liveOps = new Set<Promise<unknown>>();

  /**
   * Registers a live-order promise so drainLiveOrders can wait on it.
   *
   * The caller keeps its own .catch chain; what is tracked is the whole
   * chain, error handling included, so draining waits for the log line too.
   */
  private trackLiveOp(p: Promise<unknown>): void {
    const wrapped = p.catch(() => {
      // tracking must never surface an error the chain already handled
    });
    this.liveOps.add(wrapped);
    void wrapped.finally(() => this.liveOps.delete(wrapped));
  }

  /**
   * Waits briefly for in-flight live orders to reach Kalshi.
   *
   * stop() fires its closing sells without waiting, which is right for a
   * running session and wrong at quit: tearing the process down cancels
   * whatever had not left the machine yet, and a closing sell that never
   * arrives leaves a real position open with nobody watching it. Bounded, so
   * a dead network cannot hold the quit hostage.
   */
  async drainLiveOrders(timeoutMs = 4000): Promise<void> {
    if (this.liveOps.size === 0) return;
    await Promise.race([
      Promise.allSettled([...this.liveOps]),
      new Promise((r) => setTimeout(r, timeoutMs)),
    ]);
  }

  // Credentials are passed in rather than read from settings: they live in an
  // encrypted vault the engine has no business touching, and injecting them
  // keeps this class runnable headless in tests.
  constructor(
    settings: Settings,
    credentials: Credentials = { apiKeyId: "", apiPrivateKeyPem: "" },
    store: EngineStore = LIVE_STORE,
  ) {
    this.settings = settings;
    this.store = store;
    this.client = new KalshiClient(credentials.apiKeyId, credentials.apiPrivateKeyPem);
    this.cashUsd = settings.dryRunCash;
    this.peakEquityUsd = settings.dryRunCash;
  }

  subscribe(l: Listener): void {
    this.listeners.push(l);
  }

  /**
   * Where to send each live market sweep for later replay.
   *
   * Injected rather than imported so the engine keeps no opinion about disk,
   * and so a backtest driving this same class cannot record its own replay
   * back over the source data.
   */
  setRecorder(fn: ((m: KalshiMarket[]) => void) | null): void {
    this.record = fn;
  }

  /** Swaps the signing key in place; omit to leave the current one alone. */
  updateCredentials(c: Credentials): void {
    this.client = new KalshiClient(c.apiKeyId, c.apiPrivateKeyPem);
    // Keys decide isLive, which decides which ledger the brakes read. A halt
    // earned on paper must not follow the user into live trading.
    if (this.haltedReason !== null && this.blockedByBrakes() === null) {
      this.haltedReason = null;
    }
    this.emitState();
  }

  updateSettings(s: Settings): void {
    const tickChanged = s.tickSeconds !== this.settings.tickSeconds;
    this.settings = s;
    if (this.status === "stopped") this.cashUsd = s.dryRunCash;
    // Raising a limit is the user answering the halt, so the banner should go
    // with it. Leaving it up after the cause is gone reads as "nothing I do
    // works" — which is exactly what it was told to look like before 1.7.1.
    if (this.haltedReason !== null && this.blockedByBrakes() === null) {
      this.haltedReason = null;
    }
    // A new poll interval has to replace the running timer or it never takes effect.
    if (tickChanged && this.status === "running" && this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => void this.tick(), s.tickSeconds * 1000);
      this.log("info", `Scan interval changed to ${s.tickSeconds}s`);
    }
    this.emitState();
  }

  get isLive(): boolean {
    return this.settings.liveMode && this.client.hasAuth;
  }

  getSignals(): Signal[] {
    return this.signals;
  }

  /**
   * Trades belonging to the mode the engine is in right now.
   *
   * Paper and live are separate accounts of separate money, so they must not
   * share a risk budget or a scoreboard. Before 1.7.1 they did: a losing
   * practice run counted against the live daily loss limit and the live losing
   * streak, so switching on live trading could find the brakes already pulled
   * by trades that never touched the exchange — and the dashboard reported a
   * blended record for an account that only held one of them.
   */
  private ownHistory(): TradeRecord[] {
    const paper = !this.isLive;
    return this.store.loadHistory().filter((t) => t.dryRun === paper);
  }

  /**
   * Trades the brakes are allowed to count: this mode's, since the user last
   * acknowledged a halt.
   */
  private brakeHistory(): TradeRecord[] {
    const since = this.store.loadRiskState().acknowledgedAt;
    return since > 0 ? this.ownHistory().filter((t) => t.closedAt > since) : this.ownHistory();
  }

  private todayPnl(history: TradeRecord[]): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return history
      .filter((t) => t.closedAt >= start.getTime())
      .reduce((sum, t) => sum + t.pnlUsd, 0);
  }

  getState(): EngineState {
    const history = this.ownHistory();
    const allTime = history.reduce((sum, t) => sum + t.pnlUsd, 0);
    const wins = history.filter((t) => t.pnlUsd > 0).length;
    const losses = history.filter((t) => t.pnlUsd < 0).length;
    const unrealized = this.positions.reduce((s, p) => s + p.unrealizedUsd, 0);
    return {
      status: this.status,
      dryRun: !this.isLive,
      authConfigured: this.client.hasAuth,
      cashUsd: round2(this.cashUsd),
      equityUsd: round2(this.equity()),
      sessionPnlUsd: round2(this.sessionRealizedUsd + unrealized),
      allTimePnlUsd: round2(allTime),
      todayPnlUsd: round2(this.todayPnl(history)),
      wins,
      losses,
      winRate: wins + losses > 0 ? wins / (wins + losses) : null,
      positions: this.positions,
      pendingOrders: this.pendingOrders,
      maxPositions: this.settings.maxPositions,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      haltedReason: this.haltedReason,
      scanner: this.scanner,
      idleHint: this.idleHint(),
      startedAt: this.startedAt,
    };
  }

  getLogs(): LogLine[] {
    return this.logs;
  }

  private equity(): number {
    // Reserved order cash counts: it comes back if the order expires, and
    // leaving it out would make every resting order look like an instant loss
    // large enough to trip the drawdown brake.
    return (
      this.cashUsd +
      this.positions.reduce((s, p) => s + (p.currentBidCents * p.contracts) / 100, 0) +
      this.pendingOrders.reduce((s, o) => s + o.costUsd, 0)
    );
  }

  /**
   * Why starting right now would halt on the first scan, or null.
   *
   * Checked before starting rather than after: the brakes read history that
   * already exists, so a halted engine used to clear its banner on Start and
   * re-halt milliseconds later. From the outside that looked like the button
   * doing nothing at all, which is how a safety feature turns into a bug
   * report. Now the refusal happens up front and names the way out.
   *
   * The drawdown brake is absent on purpose: it measures from a session peak
   * that starting resets, so it genuinely does clear on its own.
   */
  blockedByBrakes(): string | null {
    const mode = this.isLive ? "live" : "paper";
    const limit = this.settings.dailyLossLimitUsd;
    if (limit > 0) {
      const today = this.todayPnl(this.brakeHistory());
      if (today <= -limit) {
        return (
          `Still ${money(today)} down in ${mode} today against a ${money(limit)} daily loss ` +
          `limit, so the engine would stop again on its first scan. Press Resume to carry on ` +
          `with a fresh allowance, or change the limit in Settings.`
        );
      }
    }

    const streakLimit = this.settings.maxConsecutiveLosses;
    if (streakLimit > 0) {
      let streak = 0;
      for (const t of [...this.brakeHistory()].reverse()) {
        if (t.pnlUsd >= 0) break;
        streak += 1;
        if (streak >= streakLimit) break;
      }
      if (streak >= streakLimit) {
        return (
          `The last ${streak} ${mode} trades all lost, which is the limit you set, so the ` +
          `engine would stop again on its first scan. Press Resume to carry on, or change the ` +
          `limit in Settings.`
        );
      }
    }
    return null;
  }

  /**
   * Acknowledges a halt so trading can continue.
   *
   * Deliberately not the same as switching the brake off. The limit stays
   * exactly where it was; what moves is the line it measures from, so the
   * allowance runs again from this moment rather than from a loss already
   * taken. That keeps the protection intact for whatever happens next.
   */
  clearHalt(): void {
    this.store.saveRiskState({ acknowledgedAt: Date.now() });
    this.haltedReason = null;
    this.log(
      "info",
      "Halt acknowledged — the brakes now measure from here, with their limits unchanged.",
    );
    this.emitState();
  }

  start(): void {
    if (this.status === "running") return;
    // Refuse rather than start-then-instantly-stop; see blockedByBrakes().
    const blocked = this.blockedByBrakes();
    if (blocked) {
      this.haltedReason = blocked;
      this.log("warn", blocked);
      // An event, not just a banner: from the tray there is no banner, and a
      // Start click that silently does nothing reads as a dead button.
      this.emitEvent({
        kind: "halted",
        tone: "bad",
        title: "ROM Trader did not start",
        body: blocked,
      });
      this.emitState();
      return;
    }
    this.status = "running";
    this.lastError = null;
    this.haltedReason = null;
    this.sessionRealizedUsd = 0;
    this.cashUsd = this.settings.dryRunCash;
    this.peakEquityUsd = this.settings.dryRunCash;
    this.startedAt = Date.now();
    this.priceHistory.clear();
    this.cooldownUntil.clear();
    this.eventLockoutUntil.clear();
    this.pendingOrders = [];
    this.signals = [];
    this.emptyScans = 0;
    this.log(
      "info",
      `Engine started (${this.isLive ? "LIVE" : "DRY-RUN"} mode, ` +
        `$${this.settings.tradeSizeUsd}/trade, max ${this.settings.maxPositions} positions)`,
    );
    this.emitState();
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.settings.tickSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    // cancel resting orders first, then close all open positions at current bid
    for (const o of [...this.pendingOrders]) this.cancelPending(o, "engine stopped");
    for (const p of [...this.positions]) this.closePosition(p, "engine stopped");
    this.status = "stopped";
    this.startedAt = null;
    this.log("info", "Engine stopped");
    this.emitState();
  }

  /**
   * Closes every open position at the current bid but leaves the engine
   * running. The reason lands in trade history, so a replay closing out at
   * the end of a recording can say that instead of blaming a user.
   */
  flatten(reason = "flattened by user"): number {
    const orders = this.pendingOrders.length;
    for (const o of [...this.pendingOrders]) this.cancelPending(o, reason);
    const n = this.positions.length;
    if (n === 0 && orders === 0) return 0;
    for (const p of [...this.positions]) this.closePosition(p, reason);
    this.log(
      "warn",
      `Flattened ${n} position${n === 1 ? "" : "s"}` +
        (orders > 0 ? ` and cancelled ${orders} resting order${orders === 1 ? "" : "s"}` : "") +
        ` on request`,
    );
    this.emitState();
    return n;
  }

  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const began = Date.now();
    this.setClock(began);
    try {
      const markets = await this.client.getActiveMarkets(40);
      this.lastTickAt = Date.now();
      this.lastError = null;
      // Recorded before any decision is made, so a replay sees exactly what
      // this tick saw. Only for live sweeps — a replay must not record itself.
      this.record?.(markets);
      // The sweep is the top of the volume table; what the engine holds may
      // not be on it any more. Deliberately absent from backtests: a recorded
      // sweep is the entire knowable world there, so replays and the playtest
      // harness mirror the five steps below, not this one.
      const managed = await this.refreshMissingMarkets(markets);
      // Live-only, like the refresh above: paper take-profit fills come from
      // the conservative rule inside updatePositions, which replays mirror.
      await this.pollLiveTakeProfits();
      this.processPendingOrders(managed);
      this.updatePositions(managed);
      this.scanForEntries(managed, began);
      this.enforceDailyLossLimit();
      this.enforceLosingStreak();
      this.enforceMaxDrawdown();
      this.store.appendEquity({ ts: Date.now(), equityUsd: round2(this.equity()) });
      this.emitState();
    } catch (e) {
      this.lastError = (e as Error).message;
      this.log("error", `Tick failed: ${this.lastError}`);
      this.emitState();
    } finally {
      this.ticking = false;
    }
  }

  /**
   * A losing day compounds fastest when nobody is watching, so the engine stops
   * itself rather than waiting to be caught.
   */
  private enforceDailyLossLimit(): void {
    const limit = this.settings.dailyLossLimitUsd;
    if (limit <= 0 || this.status !== "running") return;
    const today = this.todayPnl(this.brakeHistory());
    if (today > -limit) return;
    this.haltedReason =
      `Daily loss limit hit (${money(today)} ${this.isLive ? "live" : "paper"} today, ` +
      `limit ${money(-limit)}). Engine stopped itself. Press Resume to carry on with a fresh ` +
      `allowance, or change the limit in Settings.`;
    this.log("warn", this.haltedReason);
    this.emitEvent({
      kind: "halted",
      tone: "bad",
      title: "ROM Trader stopped itself",
      body: `Daily loss limit hit — ${money(today)} today.`,
    });
    this.stop();
  }

  /**
   * Whether the clock allows opening anything right now.
   *
   * Only gates entries: a position opened before the window closed still gets
   * managed to its exit, because abandoning one at a bell is worse than
   * holding it a few minutes longer. An end hour at or before the start wraps
   * past midnight, so 21 to 6 means overnight.
   */
  withinTradingHours(now = new Date()): boolean {
    if (!this.settings.tradingHoursEnabled) return true;
    const { tradingStartHour: start, tradingEndHour: end } = this.settings;
    if (start === end) return true; // a zero-width window would mean "never"
    const hour = now.getHours();
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
  }

  /**
   * A conservative default spread limit against real Kalshi books rejects
   * nearly everything, which looks identical to a broken bot. After a few
   * barren scans, say which filter is doing it and which setting relaxes it.
   */
  private idleHint(): string | null {
    const s = this.scanner;
    if (!s || this.emptyScans < 3 || s.marketsScanned === 0) return null;

    // The clock beats every other explanation: nothing else matters while the
    // window is shut, and "spread too wide" would be actively misleading.
    if (s.skippedClock > 0) {
      return (
        `Outside your trading hours (${this.settings.tradingStartHour}:00–` +
        `${this.settings.tradingEndHour}:00), so nothing is being bought. ` +
        `Prices are still being tracked, so it can act as soon as the window opens.`
      );
    }

    const underTrigger = Math.max(
      0,
      s.marketsScanned -
        s.skippedSpread -
        s.skippedPrice -
        s.skippedWarmup -
        s.skippedCooldown -
        s.skippedEvent -
        s.skippedJumpy -
        s.skippedClock -
        s.skippedFees -
        s.skippedRegime -
        s.skippedQuiet -
        s.skippedClosing,
    );
    const causes = [
      {
        n: s.skippedClosing,
        msg:
          `${s.skippedClosing} of ${s.marketsScanned} markets close within your ` +
          `${this.settings.minMinutesToClose}-minute entry cutoff. The endgame is where strikes ` +
          `snap to 0 or 100; lower "Min time to close" in Settings to trade it anyway.`,
      },
      {
        n: s.skippedRegime,
        msg:
          `${s.skippedRegime} of ${s.marketsScanned} markets are being skipped by the regime ` +
          `filter because their recent moves have reversed rather than continued. Turn it off in ` +
          `Settings to trade them anyway.`,
      },
      {
        n: s.skippedQuiet,
        msg:
          `${s.skippedQuiet} of ${s.marketsScanned} markets moved without any contracts trading, ` +
          `so the traded-volume gate refused them. Turn it off in Settings to act on quote moves.`,
      },
      {
        n: s.skippedSpread,
        msg:
          `${s.skippedSpread} of ${s.marketsScanned} markets have a spread wider than your ` +
          `${this.settings.maxSpreadCents}c limit. Raise "Max spread" in Settings to include them — ` +
          `but you pay that spread the moment you enter.`,
      },
      {
        n: s.skippedPrice,
        msg:
          `${s.skippedPrice} of ${s.marketsScanned} markets sit outside your ` +
          `${this.settings.minPriceCents}–${this.settings.maxPriceCents}c price band. Widen it in Settings.`,
      },
      {
        n: underTrigger,
        msg:
          `Markets are clearing your filters, but none has moved ` +
          `${this.settings.momentumThresholdCents}c. Lower the momentum trigger in Settings to act on smaller moves.`,
      },
    ].sort((a, b) => b.n - a.n);

    if (causes[0].n === 0) return null;
    return `No entries in the last ${this.emptyScans} scans. ${causes[0].msg}`;
  }

  /** Live ticks set this from their own clock; replays set it per recorded scan. */
  private setClock(t: number): void {
    this.clockMs = t;
  }

  /**
   * The scan clock, falling back to the wall only before the first tick.
   * Between live ticks this is at most one interval stale, which the
   * 90-second cooldowns and hour-long lockouts never notice; in a replay it
   * is the only clock telling the truth.
   */
  private now(): number {
    return this.clockMs || Date.now();
  }

  private coolingDown(ticker: string): boolean {
    const until = this.cooldownUntil.get(ticker);
    if (until === undefined) return false;
    if (this.now() >= until) {
      this.cooldownUntil.delete(ticker);
      return false;
    }
    return true;
  }

  /**
   * How long this ticker's event ladder stays shut after a loss on it, and
   * which market took that loss. Zero milliseconds means the ladder is open.
   */
  private eventLockRemaining(ticker: string): { ms: number; lostTicker: string } {
    const ev = TradingEngine.eventOf(ticker);
    const lock = this.eventLockoutUntil.get(ev);
    if (lock === undefined) return { ms: 0, lostTicker: "" };
    const left = lock.until - this.now();
    if (left <= 0) {
      this.eventLockoutUntil.delete(ev);
      return { ms: 0, lostTicker: "" };
    }
    return { ms: left, lostTicker: lock.lostTicker };
  }

  /** Open positions plus resting orders on this ticker's event ladder. */
  private eventExposure(ticker: string): number {
    const ev = TradingEngine.eventOf(ticker);
    return (
      this.positions.filter((p) => TradingEngine.eventOf(p.ticker) === ev).length +
      this.pendingOrders.filter((o) => TradingEngine.eventOf(o.ticker) === ev).length
    );
  }

  private mid(m: KalshiMarket): number {
    return m.yes_bid > 0 && m.yes_ask > 0 ? (m.yes_bid + m.yes_ask) / 2 : m.last_price;
  }

  /**
   * Fetches quotes for anything held that the sweep no longer covers.
   *
   * The sweep is the top forty by volume among markets closing within two
   * hours — so every held market is guaranteed to leave it eventually, by
   * closing if nothing else. Before 1.7.2 a position whose market left the
   * sweep went blind: the bid froze at its last seen value, the stop-loss
   * could never fire, and a market that settled was carried at a stale quote
   * instead of the 100c or 0c that actually happened to the money.
   */
  private async refreshMissingMarkets(markets: KalshiMarket[]): Promise<KalshiMarket[]> {
    const seen = new Set(markets.map((m) => m.ticker));
    const held = [
      ...this.positions.map((p) => p.ticker),
      ...this.pendingOrders.map((o) => o.ticker),
    ].filter((t, i, a) => !seen.has(t) && a.indexOf(t) === i);
    if (held.length === 0) return markets;

    const out = [...markets];
    for (const ticker of held) {
      try {
        const { market, status, result } = await this.client.getMarket(ticker);
        if (status === "settled") {
          // A resting order in a settled market can never fill; release it.
          for (const o of this.pendingOrders.filter((x) => x.ticker === ticker)) {
            this.cancelPending(o, "market settled before the order filled");
          }
          const p = this.positions.find((x) => x.ticker === ticker);
          if (p) this.settlePosition(p, result);
        } else if (market.yes_bid > 0 && market.yes_ask > 0) {
          // Still two-sided — hand it to the normal management path so stops,
          // targets and fills work exactly as if it were still in the sweep.
          // Both sides, deliberately: the sweep filters one-sided books out,
          // so the exits have never had to face a bid of zero — and a missing
          // bid read as bid 0 would "stop-loss" the position at a total loss
          // on a trade that never happened.
          out.push(market);
        }
        // "closed" (trading over, settlement pending) and one-sided books
        // offer no exit; nothing to do until quotes or settlement return.
      } catch (e) {
        // One missing quote must not fail the whole tick; ask again next scan.
        this.log("warn", `Could not refresh ${ticker}: ${(e as Error).message}`);
      }
    }
    return out;
  }

  /**
   * Books a settlement: YES paid out at 100c, or expired worthless at 0c.
   *
   * Not a sale — no bid is involved and no taker fee applies. Kalshi charges
   * trading fees on executions, not on settlement, so the only costs in this
   * trade are the ones already paid on the way in.
   */
  private settlePosition(p: Position, result: string): void {
    if (result !== "yes" && result !== "no") {
      // Voided, or settled without a reported result yet. Booking a guess
      // would be worse than waiting; the next refresh asks again.
      this.log(
        "warn",
        `${p.ticker} reports settled with result "${result || "unknown"}" — holding the ` +
          `position until Kalshi says yes or no.`,
      );
      return;
    }
    // No exchange cancel for a resting take-profit here: settlement kills
    // every resting order exchange-side, and cancelling a dead order would
    // only log a scary warning about a race that never was.
    p.tpRestingCents = null;
    p.tpOrderId = null;
    const priceCents = result === "yes" ? 100 : 0;
    this.bookExit(p, priceCents, 0, `settled ${result}`, false);
  }

  private updatePositions(markets: KalshiMarket[]): void {
    const byTicker = new Map(markets.map((m) => [m.ticker, m]));
    for (const p of [...this.positions]) {
      const m = byTicker.get(p.ticker);
      if (!m) continue; // market fell out of the top list; keep at last price
      p.currentBidCents = m.yes_bid;
      p.peakMidCents = Math.max(p.peakMidCents, this.mid(m));
      // Net of both fees: the entry fee is spent and the exit fee is certain,
      // so a position that looks flat gross is really down by the round trip.
      const pnlCents = (m.yes_bid - p.entryCents) * p.contracts;
      p.unrealizedUsd = round2(
        pnlCents / 100 - p.entryFeeUsd - takerFeeUsd(p.contracts, m.yes_bid),
      );

      const perContract = m.yes_bid - p.entryCents;
      if (p.tpRestingCents !== null && !this.isLive && m.yes_bid >= p.tpRestingCents) {
        // The conservative maker-fill rule, mirrored from entries: the sell
        // fills only when the bid pays up to the target, and at the target —
        // not at whatever the bid gapped to. Live fills come from polling.
        this.fillTakeProfit(p);
      } else if (p.tpRestingCents === null && perContract >= this.settings.takeProfitCents) {
        this.closePosition(p, "take-profit");
      } else if (perContract <= -this.settings.stopLossCents) {
        this.closePosition(p, "stop-loss");
      } else if (
        // Its own setting since 1.4.0. Reusing the entry trigger here made
        // this fire on any small pullback, which closed most positions before
        // the take-profit or the stop-loss could apply.
        this.settings.trailingStopCents > 0 &&
        p.peakMidCents - this.mid(m) >= this.settings.trailingStopCents
      ) {
        this.closePosition(p, "trailing stop");
      }
    }
  }

  private scanForEntries(markets: KalshiMarket[], began: number): void {
    // Outside the configured hours the scanner still tracks prices, so that
    // momentum history is warm the moment the window opens again — it just
    // will not buy anything.
    const clockAllows = this.withinTradingHours();

    const stats: ScannerStats = {
      marketsScanned: markets.length,
      tracked: 0,
      eligible: 0,
      skippedSpread: 0,
      skippedPrice: 0,
      skippedWarmup: 0,
      skippedCooldown: 0,
      skippedEvent: 0,
      skippedJumpy: 0,
      skippedClock: 0,
      skippedFees: 0,
      skippedRegime: 0,
      skippedQuiet: 0,
      skippedClosing: 0,
      scanMs: 0,
    };
    const seen: Signal[] = [];
    const maker = this.settings.makerEntries;

    for (const m of markets) {
      const hist = this.priceHistory.get(m.ticker) ?? [];
      hist.push({ mid: this.mid(m), bid: m.yes_bid, volume: m.volume });
      if (hist.length > TradingEngine.MAX_HISTORY) hist.shift();
      this.priceHistory.set(m.ticker, hist);
      stats.tracked++;

      const spread = m.yes_ask - m.yes_bid;
      // The bid is a buyer actually paying more; the mid can be lifted by a
      // seller leaving. Which one counts as momentum is a setting, measured
      // against real recordings before the default is ever changed.
      const src = this.settings.momentumOnBid
        ? (s: MarketSample) => s.bid
        : (s: MarketSample) => s.mid;
      const warm = hist.length > TradingEngine.LOOKBACK;
      const change = warm
        ? src(hist[hist.length - 1]) - src(hist[hist.length - 1 - TradingEngine.LOOKBACK])
        : null;
      // Contracts traded over the same window the momentum is measured on.
      const volumeDelta = warm
        ? hist[hist.length - 1].volume - hist[hist.length - 1 - TradingEngine.LOOKBACK].volume
        : null;

      let eligible = false;
      let reason: string;
      let autocorr: number | null = null;
      let evLock = { ms: 0, lostTicker: "" };

      if (!clockAllows) {
        // Checked first so that outside the window every market says the same
        // thing, rather than the real reason hiding behind a spread complaint.
        reason = `outside trading hours (${this.settings.tradingStartHour}:00–${this.settings.tradingEndHour}:00)`;
        stats.skippedClock++;
      } else if (m.yes_ask < this.settings.minPriceCents || m.yes_ask > this.settings.maxPriceCents) {
        reason = `price ${m.yes_ask}c outside ${this.settings.minPriceCents}–${this.settings.maxPriceCents}c`;
        stats.skippedPrice++;
      } else if (this.settings.stopLossCents > 0 && m.yes_ask <= this.settings.stopLossCents) {
        // A stop that cannot fire is not a stop. The exit rule waits for the
        // bid to fall stopLossCents below entry, and from an entry at or
        // under that distance the trigger price is zero or negative — a
        // place no bid can go. One of these rode 10c down to 1c for an hour,
        // -91% of its cost, and only closed because the engine stopped:
        // its true stop was the entire stake. (The sibling Polymarket bot
        // hit the same wall the same week, from the percentage side.)
        reason = `a ${this.settings.stopLossCents}c stop can never fire from ${m.yes_ask}c — the true risk is the whole stake`;
        stats.skippedPrice++;
      } else if (
        // The endgame gate. The whole sweep closes within two hours, so
        // without this the engine trades nothing but final-minutes ladders,
        // where strikes converge to 0c or 100c and a momentum entry is a bet
        // on the resolution, not on a move. A market with no known close is
        // let through rather than guessed at — old recordings have none.
        //
        // Measured against `began` — the scan's own clock — never the wall
        // clock: in a replay every recorded close time is in the past, so
        // Date.now() here silently marked the entire recording "closing
        // soon" and zeroed every backtest of post-1.9.1 data. The tell was
        // trade counts shrinking as the recording grew.
        this.settings.minMinutesToClose > 0 &&
        m.close_ts > 0 &&
        m.close_ts * 1000 - began < this.settings.minMinutesToClose * 60_000
      ) {
        const minsLeft = Math.max(0, Math.round((m.close_ts * 1000 - began) / 60_000));
        reason = `closes in ${minsLeft}m — under your ${this.settings.minMinutesToClose}m entry cutoff`;
        stats.skippedClosing++;
      } else if (spread > this.settings.maxSpreadCents) {
        // Buying at the ask while valuing at the bid means a wide spread is an
        // instant unrealized loss that trips the stop.
        reason = `spread ${spread}c over ${this.settings.maxSpreadCents}c limit`;
        stats.skippedSpread++;
      } else if (change === null) {
        reason = `warming up (${hist.length}/${TradingEngine.LOOKBACK + 1} samples)`;
        stats.skippedWarmup++;
      } else if (change < this.settings.momentumThresholdCents) {
        reason = `momentum ${fmtCents(change)} under ${this.settings.momentumThresholdCents}c trigger`;
      } else if (
        this.settings.requireTradeActivity &&
        volumeDelta !== null &&
        volumeDelta <= 0
      ) {
        // The quotes moved but nothing printed: a market maker repositioned,
        // nobody actually paid a higher price. That is not momentum.
        reason = `no contracts traded in the window — the move is quotes, not trades`;
        stats.skippedQuiet++;
      } else if (
        this.settings.requireConsistentMove &&
        !TradingEngine.consistentClimb(hist.slice(-(TradingEngine.LOOKBACK + 1)).map(src))
      ) {
        // A staircase is momentum; a single jump is a head-fake. The whole
        // trigger can be one gapped tick that mean-reverts on the next scan
        // — the autopsied instant-stop cluster was full of those. Requiring
        // most steps of the window to climb costs the gap trades and keeps
        // the walks.
        reason = `the ${fmtCents(change)} move is one jump, not a climb — steps disagree`;
        stats.skippedJumpy++;
      } else if (
        // A maker enters at the bid and pays no entry fee; a taker enters at
        // the ask and pays the fee twice. The edge check has to price the
        // trade the way it will actually be done, or it refuses the wrong ones.
        netEdgeCents(this.settings.takeProfitCents, maker ? m.yes_bid : m.yes_ask, maker) <=
        this.settings.minNetEdgeCents
      ) {
        // Even when the trade clears the fees, an edge of half a cent is not
        // worth the risk being taken to collect it. See minNetEdgeCents.
        reason = maker
          ? `take-profit ${this.settings.takeProfitCents}c clears the ` +
            `${takerFeeCentsPerContract(m.yes_bid).toFixed(1)}c exit fee by under ` +
            `${this.settings.minNetEdgeCents}c at ${m.yes_bid}c`
          : `take-profit ${this.settings.takeProfitCents}c clears the ` +
            `${roundTripFeeCentsPerContract(m.yes_ask).toFixed(1)}c round-trip fee by under ` +
            `${this.settings.minNetEdgeCents}c at ${m.yes_ask}c`;
        stats.skippedFees++;
      } else if (
        this.settings.regimeFilterEnabled &&
        hist.length < TradingEngine.MIN_REGIME_SAMPLES
      ) {
        // The filter used to abstain on markets too young to measure — which
        // waved through exactly the ones it could not certify. Both live loss
        // clusters were that: index ladders traded within minutes of first
        // entering the sweep at the futures open, crypto ladders at an hourly
        // rollover. A filter that refuses unjudgeable regimes must refuse the
        // unjudged. A flat-but-well-observed market still passes below: a
        // quiet book waking up is the breakout a momentum rule exists for.
        reason =
          `seen for ${hist.length}/${TradingEngine.MIN_REGIME_SAMPLES} scans — too new for ` +
          `the regime filter to judge`;
        stats.skippedRegime++;
      } else if (
        this.settings.regimeFilterEnabled &&
        (autocorr = lag1Autocorrelation(hist.map((s) => s.mid))) !== null &&
        autocorr < 0
      ) {
        // A momentum rule assumes the last move predicts the next one. When
        // the recent record says the opposite, entering is buying head-fakes.
        reason = `recent moves mean-revert (autocorr ${autocorr.toFixed(2)}) — regime filter`;
        stats.skippedRegime++;
      } else if (this.coolingDown(m.ticker)) {
        // Without this the same tick that takes profit re-buys at the ask,
        // paying the spread again on a position we just sold at the bid.
        const secs = Math.ceil(((this.cooldownUntil.get(m.ticker) ?? 0) - this.now()) / 1000);
        reason = `cooling down for ${secs}s after exiting`;
        stats.skippedCooldown++;
      } else if ((evLock = this.eventLockRemaining(m.ticker)).ms > 0) {
        // A stop-out on one strike is the underlying disproving the move, and
        // every sibling strike prices the same underlying. The engine used to
        // honour the loss lockout on the exact ticker that lost while buying
        // the strike next door 45 seconds later — same ladder, same dip, same
        // stop. One disproof per ladder, not per line on it.
        //
        // Which of the two it was comes from the lock itself rather than from
        // the shape of the ticker: since the ladder is now the last-dash event,
        // a market always differs from its event key and the old test would
        // have blamed a sibling for every loss the market took itself.
        const mins = Math.ceil(evLock.ms / 60_000);
        reason =
          evLock.lostTicker === m.ticker
            ? `locked out for ${mins}m after losing here`
            : `its ladder stopped out — locked for ${mins}m after losing there`;
        stats.skippedEvent++;
      } else if (this.eventExposure(m.ticker) >= this.settings.maxPositionsPerEvent) {
        // Sibling strikes move together, so stacking them is one bet at
        // multiplied size: half of the first two soak days' entries stacked
        // an already-held ladder, and one reversal then booked three or four
        // "independent" stop-losses inside as many minutes.
        reason =
          `already holding ${this.settings.maxPositionsPerEvent === 1 ? "a position" : "positions"} ` +
          `on this ladder — sibling strikes are the same bet`;
        stats.skippedEvent++;
      } else {
        eligible = true;
        stats.eligible++;
        reason = `momentum ${fmtCents(change)} — trigger met`;
      }

      seen.push({
        ticker: m.ticker,
        title: m.title,
        midCents: Math.round(this.mid(m)),
        bidCents: m.yes_bid,
        askCents: m.yes_ask,
        spreadCents: spread,
        changeCents: change,
        eligible,
        reason,
        ts: this.now(),
      });

      if (!eligible) continue;
      // Resting orders count toward the cap: each one is committed cash that
      // becomes a position the moment someone sells into it.
      if (this.positions.length + this.pendingOrders.length >= this.settings.maxPositions) continue;
      if (this.positions.some((p) => p.ticker === m.ticker)) continue;
      if (this.pendingOrders.some((o) => o.ticker === m.ticker)) continue;
      if (maker) this.placeMakerOrder(m);
      else this.openPosition(m);
    }

    stats.scanMs = Date.now() - began;
    this.scanner = stats;
    this.emptyScans = stats.eligible > 0 ? 0 : this.emptyScans + 1;
    // Strongest movers first so the Signals page leads with what nearly traded.
    this.signals = seen
      .sort((a, b) => (b.changeCents ?? -99) - (a.changeCents ?? -99))
      .slice(0, TradingEngine.MAX_SIGNALS);
  }

  private openPosition(m: KalshiMarket): void {
    const factor = this.sizeFactor();
    const contracts = this.sizeContracts(m.yes_ask, factor);
    if (contracts < 1) return;
    const costUsd = (m.yes_ask * contracts) / 100;
    if (costUsd > this.cashUsd) {
      this.log("warn", `Skipped ${m.ticker} — needs ${money(costUsd)}, cash is ${money(this.cashUsd)}`);
      return;
    }

    // Taker fee on the way in. Charged to cash immediately, the way Kalshi
    // does, so paper trading reports the same number live trading would.
    const entryFeeUsd = takerFeeUsd(contracts, m.yes_ask);
    this.cashUsd -= costUsd + entryFeeUsd;
    const opened: Position = {
      ticker: m.ticker,
      title: m.title,
      side: "yes",
      entryCents: m.yes_ask,
      contracts,
      currentBidCents: m.yes_bid,
      peakMidCents: this.mid(m),
      // Already down the spread and both fees the moment it opens: the exit
      // fee is unavoidable, so showing it later would flatter the position.
      unrealizedUsd: round2(
        ((m.yes_bid - m.yes_ask) * contracts) / 100 -
          entryFeeUsd -
          takerFeeUsd(contracts, m.yes_bid),
      ),
      entryFeeUsd,
      tpRestingCents: null,
      tpOrderId: null,
      openedAt: this.now(),
    };
    this.positions.push(opened);

    if (this.isLive) {
      this.trackLiveOp(
        this.client
          .placeOrder({
            ticker: m.ticker,
            side: "yes",
            action: "buy",
            count: contracts,
            buyMaxCostCents: m.yes_ask * contracts,
          })
          // A refused buy used to be logged and nothing else, leaving the
          // ledger holding a position the exchange never opened: cash spent,
          // a take-profit resting to sell contracts nobody owns, and every
          // risk brake measuring a trade that does not exist. The maker path
          // has always unwound its rejections — this is the same discipline
          // on the taker side.
          .catch((e) =>
            this.abandonPosition(opened, `Kalshi refused the order: ${(e as Error).message}`),
          ),
      );
    }

    this.restTakeProfit(opened);
    this.log(
      "trade",
      `OPEN ${m.ticker} — ${contracts}x YES @ ${m.yes_ask}c ` +
        `(${money(costUsd)})` +
        (factor < 0.999 ? ` [size scaled to ${Math.round(factor * 100)}% by drawdown]` : "") +
        ` [${m.title.slice(0, 60)}]`,
    );
    this.emitEvent({
      kind: "opened",
      tone: "info",
      title: `Opened ${m.ticker}`,
      body: `${contracts} contracts at ${m.yes_ask}c · ${money(costUsd)}`,
    });
  }

  /**
   * Rests a buy at the bid instead of crossing to the ask.
   *
   * Joining the bid rather than improving it keeps the order a maker even if
   * the book moves; the entire economics of this mode rest on never paying
   * the taker fee or the spread on entry.
   */
  private placeMakerOrder(m: KalshiMarket): void {
    const factor = this.sizeFactor();
    const limitCents = m.yes_bid;
    const contracts = this.sizeContracts(limitCents, factor);
    if (contracts < 1) return;
    const costUsd = (limitCents * contracts) / 100;
    if (costUsd > this.cashUsd) {
      this.log("warn", `Skipped ${m.ticker} — needs ${money(costUsd)}, cash is ${money(this.cashUsd)}`);
      return;
    }

    const order: PendingOrder = {
      ticker: m.ticker,
      title: m.title,
      side: "yes",
      limitCents,
      contracts,
      costUsd,
      placedAt: this.now(),
      ticksLeft: this.settings.makerTtlTicks,
      orderId: null,
    };
    // Reserved immediately, the way Kalshi holds balance against resting
    // orders, so paper and live report the same cash number.
    this.cashUsd -= costUsd;
    this.pendingOrders.push(order);

    if (this.isLive) {
      this.trackLiveOp(
        this.client
          .placeLimitBuy(m.ticker, contracts, limitCents)
          .then((id) => this.attachOrderId(order, id))
          .catch((e) => {
            // Kalshi refused (post_only would have crossed, insufficient
            // funds, closed market). The paper-side reservation must be
            // unwound or the engine trades as if the money were committed.
            this.cancelPending(order, `Kalshi rejected the order: ${(e as Error).message}`);
          }),
      );
    }

    this.log(
      "trade",
      `REST ${m.ticker} — ${contracts}x YES limit ${limitCents}c (maker, ` +
        `${this.settings.makerTtlTicks} scans to fill)` +
        (factor < 0.999 ? ` [size scaled to ${Math.round(factor * 100)}% by drawdown]` : ""),
    );
  }

  /**
   * Records the exchange's id for a just-placed resting order.
   *
   * Placement is async and local bookkeeping is not: the order can expire or
   * be cancelled here before Kalshi answers. When the id arrives for an order
   * no longer tracked, the only safe move is to cancel it at the exchange too
   * — otherwise a real order rests, and possibly fills, with nothing
   * watching it.
   */
  private attachOrderId(order: PendingOrder, id: string): void {
    if (this.pendingOrders.includes(order)) {
      order.orderId = id;
      return;
    }
    this.trackLiveOp(
      this.client.cancelOrder(id).catch((e) => {
        this.log(
          "warn",
          `A resting order on ${order.ticker} was confirmed after being cancelled locally, and ` +
            `could not be cancelled at Kalshi: ${(e as Error).message}. Check your Kalshi orders page.`,
        );
      }),
    );
  }

  /**
   * Walks resting orders once per scan: fills, then expiry.
   *
   * The paper fill rule is deliberately conservative — a resting buy at L
   * fills only when the ask trades down to L or through it, meaning someone
   * actually sold into the bid. Assuming a fill merely because the bid was
   * touched flatters the strategy; queue position at Kalshi is unknowable
   * from here, and an optimistic fill model is how a backtest lies.
   */
  private processPendingOrders(markets: KalshiMarket[]): void {
    if (this.pendingOrders.length === 0) return;
    const byTicker = new Map(markets.map((m) => [m.ticker, m]));

    for (const o of [...this.pendingOrders]) {
      o.ticksLeft -= 1;

      if (this.isLive) {
        // Live fills come from Kalshi's answer, never from the paper rule: the
        // two can disagree, and only one of them moved real money.
        if (o.ticksLeft <= 0) {
          // cancelPending also cancels the real order at Kalshi.
          this.cancelPending(o, "unfilled when its time ran out");
        } else if (o.orderId) {
          void this.pollLiveOrder(o, byTicker.get(o.ticker) ?? null);
        }
        continue;
      }

      const m = byTicker.get(o.ticker);
      if (m && m.yes_ask <= o.limitCents) {
        this.fillPending(o, o.contracts, m);
        continue;
      }
      if (o.ticksLeft <= 0) this.cancelPending(o, "unfilled when its time ran out");
    }
  }

  /** Asks Kalshi how a live resting order is doing and mirrors the answer. */
  private async pollLiveOrder(o: PendingOrder, m: KalshiMarket | null): Promise<void> {
    try {
      const st = await this.client.getOrder(o.orderId!);
      if (!this.pendingOrders.includes(o)) return; // resolved while we waited
      if (st.status === "executed" || st.filledCount >= o.contracts) {
        this.fillPending(o, o.contracts, m);
      } else if (st.status === "canceled") {
        // Cancelled outside this app — from the Kalshi site, or by the
        // exchange. A partial fill before the cancel is still a position.
        if (st.filledCount > 0) this.fillPending(o, st.filledCount, m);
        else this.cancelPending(o, "cancelled on Kalshi");
      }
    } catch (e) {
      this.log("warn", `Could not check resting order on ${o.ticker}: ${(e as Error).message}`);
    }
  }

  /** Turns a resting order (or the filled part of one) into a tracked position. */
  private fillPending(o: PendingOrder, filledContracts: number, m: KalshiMarket | null): void {
    if (!this.pendingOrders.includes(o)) return; // guard against double resolution
    this.pendingOrders = this.pendingOrders.filter((x) => x !== o);

    const filled = Math.min(o.contracts, Math.max(1, Math.round(filledContracts)));
    // Money reserved for the unfilled remainder comes back.
    this.cashUsd += (o.limitCents * (o.contracts - filled)) / 100;

    const bid = m?.yes_bid ?? o.limitCents;
    const mid = m ? this.mid(m) : o.limitCents;
    this.positions.push({
      ticker: o.ticker,
      title: o.title,
      side: "yes",
      entryCents: o.limitCents,
      contracts: filled,
      currentBidCents: bid,
      peakMidCents: mid,
      // A maker pays nothing to open. Only the taker exit is inevitable, so a
      // fresh fill at the bid shows one fee down, not a spread and two.
      unrealizedUsd: round2(((bid - o.limitCents) * filled) / 100 - takerFeeUsd(filled, bid)),
      entryFeeUsd: 0,
      tpRestingCents: null,
      tpOrderId: null,
      openedAt: this.now(),
    });
    this.restTakeProfit(this.positions[this.positions.length - 1]);

    this.log(
      "trade",
      `FILL ${o.ticker} — ${filled}x YES @ ${o.limitCents}c (maker, no entry fee)` +
        (filled < o.contracts ? ` [${o.contracts - filled} unfilled returned]` : ""),
    );
    this.emitEvent({
      kind: "opened",
      tone: "info",
      title: `Filled ${o.ticker}`,
      body: `${filled} contracts at ${o.limitCents}c · resting order filled`,
    });
  }

  /**
   * Removes a position the exchange never actually opened.
   *
   * Not an exit: nothing was bought, so nothing is sold and nothing is booked
   * to history. The entry cost and fee go back to cash and the position leaves
   * the ledger, which is the only honest answer when the buy was refused —
   * recording it as a closed trade would put a fictional round-trip into the
   * record the risk brakes read from.
   */
  private abandonPosition(p: Position, why: string): void {
    if (!this.positions.includes(p)) return; // already gone: exited, or unwound
    this.positions = this.positions.filter((x) => x !== p);
    this.cashUsd += (p.entryCents * p.contracts) / 100 + p.entryFeeUsd;

    // A take-profit may have been rested against a position that turned out
    // not to exist. It has to die with it, or a live sell sits at the exchange
    // waiting to short contracts nobody owns.
    if (this.isLive && p.tpOrderId) {
      this.trackLiveOp(
        this.client.cancelOrder(p.tpOrderId).catch((e) => {
          this.log(
            "warn",
            `Could not cancel the take-profit left by the refused entry on ${p.ticker}: ` +
              `${(e as Error).message}. Check your Kalshi orders page.`,
          );
        }),
      );
    }
    p.tpRestingCents = null;
    p.tpOrderId = null;

    this.log("error", `VOID ${p.ticker} — ${p.contracts}x never opened: ${why}`);
    this.emitEvent({
      kind: "closed",
      tone: "bad",
      title: `Entry refused · ${p.ticker}`,
      body: `${why} — the position was removed and the money returned.`,
    });
  }

  /** Removes a resting order, returns its reserved cash, and kills the real order. */
  private cancelPending(o: PendingOrder, why: string): void {
    if (!this.pendingOrders.includes(o)) return;
    this.pendingOrders = this.pendingOrders.filter((x) => x !== o);
    this.cashUsd += o.costUsd;
    // The real order has to die with the paper one. Before 1.7.2 only the
    // TTL path cancelled at Kalshi, so stop() and flatten() dropped live
    // resting orders from the books here while leaving them resting — and
    // able to fill — at the exchange, with nothing watching them.
    if (this.isLive && o.orderId) {
      this.trackLiveOp(
        this.client.cancelOrder(o.orderId).catch((e) => {
          // Most likely the order filled in the race between our decision and
          // the cancel. Tell the user to look rather than guessing.
          this.log(
            "warn",
            `Could not cancel resting order on ${o.ticker}: ${(e as Error).message}. ` +
              `Check your Kalshi orders page.`,
          );
        }),
      );
    }
    this.log("info", `EXPIRE ${o.ticker} — ${o.contracts}x limit ${o.limitCents}c: ${why}`);
  }

  /** Session drawdown from peak equity, in percent. */
  private drawdownPct(): number {
    if (this.peakEquityUsd <= 0) return 0;
    return Math.max(0, ((this.peakEquityUsd - this.equity()) / this.peakEquityUsd) * 100);
  }

  /**
   * Fraction of the configured trade size currently allowed.
   *
   * Shrinks linearly from 1 toward 0.25 as drawdown approaches the halt line,
   * so a bad run bleeds slower the worse it gets. Kelly sizing was considered
   * and rejected: it needs a trusted edge estimate, and estimating one from a
   * rolling handful of trades produces size swings that are noise, not risk
   * management. With no demonstrated positive edge, Kelly's honest answer is
   * zero — which is what the halt line is for.
   */
  private sizeFactor(): number {
    const limit = this.settings.maxDrawdownPct;
    if (limit <= 0) return 1;
    const dd = this.drawdownPct();
    if (dd <= 0) return 1;
    return Math.max(0.25, 1 - (0.75 * dd) / limit);
  }

  /**
   * The brake behind the scaling: past the line, stop guessing and stop.
   * Realises the loss by closing everything, which is what a hard drawdown
   * stop means — an unrealised hole this deep is not something to sit in
   * unattended hoping it refills.
   */
  private enforceMaxDrawdown(): void {
    const eq = this.equity();
    if (eq > this.peakEquityUsd) this.peakEquityUsd = eq;
    const limit = this.settings.maxDrawdownPct;
    if (limit <= 0 || this.status !== "running") return;
    const dd = this.drawdownPct();
    if (dd < limit) return;
    this.haltedReason =
      `Equity is down ${dd.toFixed(1)}% from its session peak (limit ${limit}%). ` +
      `Engine stopped itself. Review the strategy, then raise or clear the limit in Settings to resume.`;
    this.log("warn", this.haltedReason);
    this.emitEvent({
      kind: "halted",
      tone: "bad",
      title: "ROM Trader stopped itself",
      body: `Equity down ${dd.toFixed(1)}% from its session peak.`,
    });
    this.stop();
  }

  /**
   * The one place an exit is booked, whatever kind it was.
   *
   * A taker close, a maker take-profit fill and a settlement differ only in
   * the exit price and the fee; the bookkeeping is identical, and keeping
   * three copies of it is how the copies start to disagree.
   */
  private bookExit(
    p: Position,
    exitCents: number,
    exitFeeUsd: number,
    reason: string,
    cooldown: boolean,
  ): void {
    const proceedsUsd = (exitCents * p.contracts) / 100 - exitFeeUsd;
    // Both fees come out of the recorded result, so history and the equity
    // curve show what actually landed rather than a gross figure.
    const pnlUsd = round2(proceedsUsd - (p.entryCents * p.contracts) / 100 - p.entryFeeUsd);
    this.cashUsd += proceedsUsd;
    this.sessionRealizedUsd += pnlUsd;

    this.positions = this.positions.filter((x) => x !== p);
    if (cooldown && this.settings.reentryCooldownSeconds > 0) {
      if (pnlUsd < 0) {
        // The loss lockout, widened from the ticker to its whole ladder in
        // 1.10.0: a stop on one strike is the underlying disproving the move
        // for every sibling too. Winning exits keep the short ticker-scoped
        // cooldown — strength continuing into the next strike is a different
        // claim — and a zero cooldown still disables both.
        this.eventLockoutUntil.set(TradingEngine.eventOf(p.ticker), {
          until: this.now() + TradingEngine.LOSS_LOCKOUT_MS,
          lostTicker: p.ticker,
        });
      } else {
        this.cooldownUntil.set(p.ticker, this.now() + this.settings.reentryCooldownSeconds * 1000);
      }
    }
    const rec: TradeRecord = {
      ticker: p.ticker,
      title: p.title,
      side: "yes",
      entryCents: p.entryCents,
      exitCents,
      contracts: p.contracts,
      pnlUsd,
      openedAt: p.openedAt,
      closedAt: this.now(),
      reason,
      dryRun: !this.isLive,
    };
    try {
      this.store.appendHistory(rec);
    } catch (e) {
      this.log("error", `Trade closed but could not be saved: ${(e as Error).message}`);
    }
    const verb = reason.startsWith("settled") ? "SETTLE" : "CLOSE";
    this.log(
      "trade",
      `${verb} ${p.ticker} — ${p.contracts}x @ ${exitCents}c ` +
        `(${pnlUsd >= 0 ? "+" : ""}${money(pnlUsd)}, ${reason})`,
    );
    this.emitEvent({
      kind: "closed",
      tone: pnlUsd >= 0 ? "good" : "bad",
      title: `${pnlUsd >= 0 ? "+" : ""}${money(pnlUsd)} · ${reason}`,
      body: `${p.ticker} — ${p.contracts} contracts at ${exitCents}c`,
    });
  }

  private closePosition(p: Position, reason: string): void {
    // A resting take-profit must die with the position, or a real order sits
    // at the exchange selling contracts this ledger no longer holds.
    if (this.isLive && p.tpOrderId) {
      this.trackLiveOp(
        this.client.cancelOrder(p.tpOrderId).catch((e) => {
          this.log(
            "warn",
            `Could not cancel the resting take-profit on ${p.ticker}: ${(e as Error).message}. ` +
              `Check your Kalshi orders page.`,
          );
        }),
      );
    }
    p.tpRestingCents = null;
    p.tpOrderId = null;

    if (!this.isLive) {
      this.bookExit(p, p.currentBidCents, takerFeeUsd(p.contracts, p.currentBidCents), reason, true);
      return;
    }

    if (p.exiting) return; // an attempt is already in flight
    if ((p.exitAttempts ?? 0) >= TradingEngine.MAX_EXIT_ATTEMPTS) return; // given up; halted below

    // Booking the exit before knowing the sell was accepted is how a real
    // position becomes an invisible one: history records the trade closed,
    // the ledger drops it, and the contracts sit at Kalshi with no stop-loss,
    // no take-profit and nothing watching them. The exit is booked in the
    // success path only; a failure leaves the position where it is so the
    // next scan sees the same exit condition and tries again.
    p.exiting = true;
    p.exitAttempts = (p.exitAttempts ?? 0) + 1;
    p.exitClientOrderId ??= crypto.randomUUID();
    const exitCents = p.currentBidCents;

    this.trackLiveOp(
      this.client
        .placeOrder({
          ticker: p.ticker,
          side: "yes",
          action: "sell",
          count: p.contracts,
          clientOrderId: p.exitClientOrderId,
        })
        .then(() => this.settleExit(p, exitCents, reason))
        .catch((e) => {
          // 409 means Kalshi already has this exact order — an earlier attempt
          // did land and only its answer went missing. That is a filled exit,
          // not a failed one.
          if (e instanceof KalshiApiError && e.isDuplicate) {
            this.settleExit(p, exitCents, reason);
            return;
          }
          p.exiting = false;
          this.log(
            "error",
            `Live sell failed for ${p.ticker} (attempt ${p.exitAttempts}): ${(e as Error).message}`,
          );
          if ((p.exitAttempts ?? 0) >= TradingEngine.MAX_EXIT_ATTEMPTS) {
            this.abandonExit(p, (e as Error).message);
          }
        }),
    );
  }

  /** The closing sell was accepted: now the exit is real and can be booked. */
  private settleExit(p: Position, exitCents: number, reason: string): void {
    if (!this.positions.includes(p)) return; // already resolved elsewhere
    p.exiting = false;
    this.bookExit(p, exitCents, takerFeeUsd(p.contracts, exitCents), reason, true);
  }

  /**
   * Stops trying to sell a position that will not close, and stops the engine.
   *
   * The position stays in the ledger because it is genuinely still open — the
   * one thing that must not happen here is quietly booking an exit that never
   * occurred. A live position the app cannot close is exactly the situation a
   * person needs to know about while it is still happening.
   */
  private abandonExit(p: Position, why: string): void {
    this.haltedReason =
      `Could not close ${p.ticker} after ${TradingEngine.MAX_EXIT_ATTEMPTS} attempts (${why}). ` +
      `The position is still open at Kalshi and this app has stopped trying — close it on the ` +
      `Kalshi site, then press Resume.`;
    this.log("error", this.haltedReason);
    this.emitEvent({
      kind: "halted",
      tone: "bad",
      title: "ROM Trader could not close a position",
      body: `${p.ticker} is still open at Kalshi. Close it there.`,
    });
    this.stop();
  }

  /**
   * Books a resting take-profit fill: exit at the target, no fee — the sell
   * was the maker.
   */
  private fillTakeProfit(p: Position): void {
    const tp = p.tpRestingCents ?? p.entryCents + this.settings.takeProfitCents;
    p.tpRestingCents = null;
    p.tpOrderId = null;
    this.bookExit(p, tp, 0, "take-profit (maker)", true);
  }

  /**
   * Rests the take-profit sell at the target the moment a position opens.
   *
   * A win that exits as a taker sells at the bid and pays the fee — two to
   * three cents per contract handed back on every winner, on a strategy
   * whose whole battle is with costs. Resting the sell fills at the target
   * itself, fee-free. The stop-loss stays a taker: a stop that waits
   * politely at the ask is not a stop.
   */
  private restTakeProfit(p: Position): void {
    if (!this.settings.makerExits) return;
    const tpCents = p.entryCents + this.settings.takeProfitCents;
    if (tpCents >= 100) return; // nothing can rest at or beyond the dollar
    p.tpRestingCents = tpCents;
    if (this.isLive) {
      this.trackLiveOp(
        this.client
          .placeLimitSell(p.ticker, p.contracts, tpCents)
          .then((id) => this.attachTpOrderId(p, id))
          .catch((e) => {
            // Rejected (post_only would have crossed, market closing). Fall
            // back to the instant taker exit rather than trade without one.
            p.tpRestingCents = null;
            this.log(
              "warn",
              `Could not rest the take-profit for ${p.ticker}: ${(e as Error).message} — ` +
                `using a market exit at target instead.`,
            );
          }),
      );
    }
  }

  /** Same race guard as entry orders: a late id for a gone position is cancelled. */
  private attachTpOrderId(p: Position, id: string): void {
    if (this.positions.includes(p)) {
      p.tpOrderId = id;
      return;
    }
    this.trackLiveOp(
      this.client.cancelOrder(id).catch((e) => {
        this.log(
          "warn",
          `A take-profit order on ${p.ticker} was confirmed after its position closed, and ` +
            `could not be cancelled at Kalshi: ${(e as Error).message}. Check your Kalshi orders page.`,
        );
      }),
    );
  }

  /**
   * Live mode only: asks Kalshi whether resting take-profits have filled.
   * Paper fills come from the conservative rule in updatePositions instead;
   * in live mode that rule stands down, because only one of the two moved
   * real money.
   */
  private async pollLiveTakeProfits(): Promise<void> {
    if (!this.isLive) return;
    for (const p of [...this.positions]) {
      if (!p.tpOrderId) continue;
      try {
        const st = await this.client.getOrder(p.tpOrderId);
        if (st.status === "executed" || st.filledCount >= p.contracts) {
          this.fillTakeProfit(p);
        } else if (st.status === "canceled") {
          // Cancelled outside this app; fall back to the instant taker exit.
          p.tpOrderId = null;
          p.tpRestingCents = null;
          this.log("warn", `The resting take-profit on ${p.ticker} was cancelled on Kalshi — using a market exit at target instead.`);
        }
      } catch (e) {
        this.log("warn", `Could not check the take-profit on ${p.ticker}: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Four losses in a row is not variance you should sit through unattended;
   * either the market changed shape or the settings are wrong. Counts back
   * from the newest trade and stops at the first win.
   */
  private enforceLosingStreak(): void {
    const limit = this.settings.maxConsecutiveLosses;
    if (limit <= 0 || this.status !== "running") return;

    let streak = 0;
    for (const t of [...this.brakeHistory()].reverse()) {
      if (t.pnlUsd >= 0) break;
      streak += 1;
      if (streak >= limit) break;
    }
    if (streak < limit) return;

    this.haltedReason =
      `${streak} losing ${this.isLive ? "live" : "paper"} trades in a row. Engine stopped itself. ` +
      `Review the strategy, then press Resume to carry on or change the limit in Settings.`;
    this.log("warn", this.haltedReason);
    this.emitEvent({
      kind: "halted",
      tone: "bad",
      title: "ROM Trader stopped itself",
      body: `${streak} losing trades in a row.`,
    });
    this.stop();
  }

  private log(level: LogLine["level"], msg: string): void {
    const line: LogLine = { ts: Date.now(), level, msg };
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    for (const l of this.listeners) {
      try {
        l.onLog(line);
      } catch {
        // A dead renderer must not stop the engine from shutting down cleanly.
      }
    }
  }

  private emitState(): void {
    const s = this.getState();
    for (const l of this.listeners) {
      try {
        l.onState(s);
      } catch {
        // as above — notifying is best-effort, never load-bearing
      }
    }
  }

  private emitEvent(e: EngineEvent): void {
    for (const l of this.listeners) {
      try {
        l.onEvent?.(e);
      } catch {
        // a failed toast must never interrupt trading
      }
    }
  }
}

/**
 * Lag-1 autocorrelation of the changes in a price series.
 *
 * Positive means recent moves have continued (trending); negative means they
 * have reversed (chopping). Needs eight changes before it says anything —
 * fewer and the number is an anecdote, so null is returned and the filter
 * stays out of the way rather than blocking on noise.
 */
export function lag1Autocorrelation(prices: number[]): number | null {
  const diffs: number[] = [];
  for (let i = 1; i < prices.length; i++) diffs.push(prices[i] - prices[i - 1]);
  if (diffs.length < 8) return null;

  const a = diffs.slice(0, -1);
  const b = diffs.slice(1);
  const meanA = a.reduce((x, y) => x + y, 0) / a.length;
  const meanB = b.reduce((x, y) => x + y, 0) / b.length;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < a.length; i++) {
    cov += (a[i] - meanA) * (b[i] - meanB);
    varA += (a[i] - meanA) * (a[i] - meanA);
    varB += (b[i] - meanB) * (b[i] - meanB);
  }
  if (varA === 0 || varB === 0) return null; // a flat series has no regime
  return cov / Math.sqrt(varA * varB);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function fmtCents(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}c`;
}
