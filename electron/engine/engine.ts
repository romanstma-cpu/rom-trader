import type { Credentials } from "./credentials";
import { KalshiClient, KalshiMarket } from "./kalshi";
import {
  netEdgeCents,
  roundTripFeeCentsPerContract,
  takerFeeCentsPerContract,
  takerFeeUsd,
} from "./fees";
import {
  EquityPoint,
  Settings,
  TradeRecord,
  appendEquity,
  appendHistory,
  loadHistory,
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
  openedAt: number;
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
  /** Blocked because the clock is outside the configured trading window. */
  skippedClock: number;
  /** Blocked because the take-profit cannot clear the fees by enough. */
  skippedFees: number;
  /** Blocked because recent moves have been mean-reverting, not trending. */
  skippedRegime: number;
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
}

const LIVE_STORE: EngineStore = {
  loadHistory,
  appendHistory,
  appendEquity,
};

/** A ledger that exists only for the duration of a replay. */
export function memoryStore(): EngineStore {
  const history: TradeRecord[] = [];
  const equity: EquityPoint[] = [];
  return {
    loadHistory: () => history,
    appendHistory: (t) => void history.push(t),
    appendEquity: (p) => void equity.push(p),
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
  private priceHistory = new Map<string, number[]>(); // ticker -> recent mids (cents)
  private cooldownUntil = new Map<string, number>(); // ticker -> ms timestamp
  private signals: Signal[] = [];
  private scanner: ScannerStats | null = null;
  private emptyScans = 0;

  private static readonly LOOKBACK = 3; // samples back for momentum
  private static readonly MAX_HISTORY = 20;
  private static readonly MAX_SIGNALS = 60;

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
    this.emitState();
  }

  updateSettings(s: Settings): void {
    const tickChanged = s.tickSeconds !== this.settings.tickSeconds;
    this.settings = s;
    if (this.status === "stopped") this.cashUsd = s.dryRunCash;
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

  private todayPnl(history: TradeRecord[]): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return history
      .filter((t) => t.closedAt >= start.getTime())
      .reduce((sum, t) => sum + t.pnlUsd, 0);
  }

  getState(): EngineState {
    const history = this.store.loadHistory();
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

  start(): void {
    if (this.status === "running") return;
    this.status = "running";
    this.lastError = null;
    this.haltedReason = null;
    this.sessionRealizedUsd = 0;
    this.cashUsd = this.settings.dryRunCash;
    this.peakEquityUsd = this.settings.dryRunCash;
    this.startedAt = Date.now();
    this.priceHistory.clear();
    this.cooldownUntil.clear();
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

  /** Closes every open position at the current bid but leaves the engine running. */
  flatten(): number {
    const orders = this.pendingOrders.length;
    for (const o of [...this.pendingOrders]) this.cancelPending(o, "flattened by user");
    const n = this.positions.length;
    if (n === 0 && orders === 0) return 0;
    for (const p of [...this.positions]) this.closePosition(p, "flattened by user");
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
    try {
      const markets = await this.client.getActiveMarkets(40);
      this.lastTickAt = Date.now();
      this.lastError = null;
      // Recorded before any decision is made, so a replay sees exactly what
      // this tick saw. Only for live sweeps — a replay must not record itself.
      this.record?.(markets);
      this.processPendingOrders(markets);
      this.updatePositions(markets);
      this.scanForEntries(markets, began);
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
    const today = this.todayPnl(this.store.loadHistory());
    if (today > -limit) return;
    this.haltedReason =
      `Daily loss limit hit (${money(today)} today, limit ${money(-limit)}). ` +
      `Engine stopped itself. Raise or clear the limit in Settings to resume.`;
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
        s.skippedClock -
        s.skippedFees -
        s.skippedRegime,
    );
    const causes = [
      {
        n: s.skippedRegime,
        msg:
          `${s.skippedRegime} of ${s.marketsScanned} markets are being skipped by the regime ` +
          `filter because their recent moves have reversed rather than continued. Turn it off in ` +
          `Settings to trade them anyway.`,
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

  private coolingDown(ticker: string): boolean {
    const until = this.cooldownUntil.get(ticker);
    if (until === undefined) return false;
    if (Date.now() >= until) {
      this.cooldownUntil.delete(ticker);
      return false;
    }
    return true;
  }

  private mid(m: KalshiMarket): number {
    return m.yes_bid > 0 && m.yes_ask > 0 ? (m.yes_bid + m.yes_ask) / 2 : m.last_price;
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
      if (perContract >= this.settings.takeProfitCents) {
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
      skippedClock: 0,
      skippedFees: 0,
      skippedRegime: 0,
      scanMs: 0,
    };
    const seen: Signal[] = [];
    const maker = this.settings.makerEntries;

    for (const m of markets) {
      const hist = this.priceHistory.get(m.ticker) ?? [];
      hist.push(this.mid(m));
      if (hist.length > TradingEngine.MAX_HISTORY) hist.shift();
      this.priceHistory.set(m.ticker, hist);
      stats.tracked++;

      const spread = m.yes_ask - m.yes_bid;
      const change =
        hist.length > TradingEngine.LOOKBACK
          ? hist[hist.length - 1] - hist[hist.length - 1 - TradingEngine.LOOKBACK]
          : null;

      let eligible = false;
      let reason: string;
      let autocorr: number | null = null;

      if (!clockAllows) {
        // Checked first so that outside the window every market says the same
        // thing, rather than the real reason hiding behind a spread complaint.
        reason = `outside trading hours (${this.settings.tradingStartHour}:00–${this.settings.tradingEndHour}:00)`;
        stats.skippedClock++;
      } else if (m.yes_ask < this.settings.minPriceCents || m.yes_ask > this.settings.maxPriceCents) {
        reason = `price ${m.yes_ask}c outside ${this.settings.minPriceCents}–${this.settings.maxPriceCents}c`;
        stats.skippedPrice++;
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
        (autocorr = lag1Autocorrelation(hist)) !== null &&
        autocorr < 0
      ) {
        // A momentum rule assumes the last move predicts the next one. When
        // the recent record says the opposite, entering is buying head-fakes.
        reason = `recent moves mean-revert (autocorr ${autocorr.toFixed(2)}) — regime filter`;
        stats.skippedRegime++;
      } else if (this.coolingDown(m.ticker)) {
        // Without this the same tick that takes profit re-buys at the ask,
        // paying the spread again on a position we just sold at the bid.
        const secs = Math.ceil(((this.cooldownUntil.get(m.ticker) ?? 0) - Date.now()) / 1000);
        reason = `cooling down for ${secs}s after exiting`;
        stats.skippedCooldown++;
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
        ts: Date.now(),
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
    const contracts = Math.floor((this.settings.tradeSizeUsd * factor * 100) / m.yes_ask);
    if (contracts < 1) return;
    const costUsd = (m.yes_ask * contracts) / 100;
    if (costUsd > this.cashUsd) {
      this.log("warn", `Skipped ${m.ticker} — needs ${money(costUsd)}, cash is ${money(this.cashUsd)}`);
      return;
    }

    if (this.isLive) {
      void this.client
        .placeOrder({
          ticker: m.ticker,
          side: "yes",
          action: "buy",
          count: contracts,
          buyMaxCostCents: m.yes_ask * contracts,
        })
        .catch((e) => this.log("error", `Live order failed for ${m.ticker}: ${e.message}`));
    }

    // Taker fee on the way in. Charged to cash immediately, the way Kalshi
    // does, so paper trading reports the same number live trading would.
    const entryFeeUsd = takerFeeUsd(contracts, m.yes_ask);
    this.cashUsd -= costUsd + entryFeeUsd;
    this.positions.push({
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
      openedAt: Date.now(),
    });
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
    const contracts = Math.floor((this.settings.tradeSizeUsd * factor * 100) / limitCents);
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
      placedAt: Date.now(),
      ticksLeft: this.settings.makerTtlTicks,
      orderId: null,
    };
    // Reserved immediately, the way Kalshi holds balance against resting
    // orders, so paper and live report the same cash number.
    this.cashUsd -= costUsd;
    this.pendingOrders.push(order);

    if (this.isLive) {
      void this.client
        .placeLimitBuy(m.ticker, contracts, limitCents)
        .then((id) => {
          order.orderId = id;
        })
        .catch((e) => {
          // Kalshi refused (post_only would have crossed, insufficient funds,
          // closed market). The paper-side reservation must be unwound or the
          // engine trades as if the money were still committed.
          this.cancelPending(order, `Kalshi rejected the order: ${(e as Error).message}`);
        });
    }

    this.log(
      "trade",
      `REST ${m.ticker} — ${contracts}x YES limit ${limitCents}c (maker, ` +
        `${this.settings.makerTtlTicks} scans to fill)` +
        (factor < 0.999 ? ` [size scaled to ${Math.round(factor * 100)}% by drawdown]` : ""),
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
          if (o.orderId) {
            void this.client.cancelOrder(o.orderId).catch((e) => {
              // Most likely the order filled in the race between our decision
              // and the cancel. The next poll of positions will not see it,
              // so tell the user to look rather than guessing.
              this.log(
                "warn",
                `Could not cancel resting order on ${o.ticker}: ${(e as Error).message}. ` +
                  `Check your Kalshi orders page.`,
              );
            });
          }
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
      openedAt: Date.now(),
    });

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

  /** Removes a resting order and returns its reserved cash. */
  private cancelPending(o: PendingOrder, why: string): void {
    if (!this.pendingOrders.includes(o)) return;
    this.pendingOrders = this.pendingOrders.filter((x) => x !== o);
    this.cashUsd += o.costUsd;
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

  private closePosition(p: Position, reason: string): void {
    if (this.isLive) {
      void this.client
        .placeOrder({ ticker: p.ticker, side: "yes", action: "sell", count: p.contracts })
        .catch((e) => this.log("error", `Live sell failed for ${p.ticker}: ${e.message}`));
    }

    const exitFeeUsd = takerFeeUsd(p.contracts, p.currentBidCents);
    const proceedsUsd = (p.currentBidCents * p.contracts) / 100 - exitFeeUsd;
    // Both fees come out of the recorded result, so history and the equity
    // curve show what actually landed rather than a gross figure.
    const pnlUsd = round2(proceedsUsd - (p.entryCents * p.contracts) / 100 - p.entryFeeUsd);
    this.cashUsd += proceedsUsd;
    this.sessionRealizedUsd += pnlUsd;

    this.positions = this.positions.filter((x) => x !== p);
    if (this.settings.reentryCooldownSeconds > 0) {
      this.cooldownUntil.set(p.ticker, Date.now() + this.settings.reentryCooldownSeconds * 1000);
    }
    const rec: TradeRecord = {
      ticker: p.ticker,
      title: p.title,
      side: "yes",
      entryCents: p.entryCents,
      exitCents: p.currentBidCents,
      contracts: p.contracts,
      pnlUsd,
      openedAt: p.openedAt,
      closedAt: Date.now(),
      reason,
      dryRun: !this.isLive,
    };
    try {
      this.store.appendHistory(rec);
    } catch (e) {
      this.log("error", `Trade closed but could not be saved: ${(e as Error).message}`);
    }
    this.log(
      "trade",
      `CLOSE ${p.ticker} — ${p.contracts}x @ ${p.currentBidCents}c ` +
        `(${pnlUsd >= 0 ? "+" : ""}${money(pnlUsd)}, ${reason})`,
    );
    this.emitEvent({
      kind: "closed",
      tone: pnlUsd >= 0 ? "good" : "bad",
      title: `${pnlUsd >= 0 ? "+" : ""}${money(pnlUsd)} · ${reason}`,
      body: `${p.ticker} — ${p.contracts} contracts at ${p.currentBidCents}c`,
    });
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
    for (const t of [...this.store.loadHistory()].reverse()) {
      if (t.pnlUsd >= 0) break;
      streak += 1;
      if (streak >= limit) break;
    }
    if (streak < limit) return;

    this.haltedReason =
      `${streak} losing trades in a row. Engine stopped itself. ` +
      `Review the strategy, then raise or clear the limit in Settings to resume.`;
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
