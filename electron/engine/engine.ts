import type { Credentials } from "./credentials";
import { KalshiClient, KalshiMarket } from "./kalshi";
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
  openedAt: number;
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
    return (
      this.cashUsd +
      this.positions.reduce((s, p) => s + (p.currentBidCents * p.contracts) / 100, 0)
    );
  }

  start(): void {
    if (this.status === "running") return;
    this.status = "running";
    this.lastError = null;
    this.haltedReason = null;
    this.sessionRealizedUsd = 0;
    this.cashUsd = this.settings.dryRunCash;
    this.startedAt = Date.now();
    this.priceHistory.clear();
    this.cooldownUntil.clear();
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
    // close all open positions at current bid
    for (const p of [...this.positions]) this.closePosition(p, "engine stopped");
    this.status = "stopped";
    this.startedAt = null;
    this.log("info", "Engine stopped");
    this.emitState();
  }

  /** Closes every open position at the current bid but leaves the engine running. */
  flatten(): number {
    const n = this.positions.length;
    if (n === 0) return 0;
    for (const p of [...this.positions]) this.closePosition(p, "flattened by user");
    this.log("warn", `Flattened ${n} position${n === 1 ? "" : "s"} on request`);
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
      this.updatePositions(markets);
      this.scanForEntries(markets, began);
      this.enforceDailyLossLimit();
      this.enforceLosingStreak();
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
        s.skippedClock,
    );
    const causes = [
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
      const pnlCents = (m.yes_bid - p.entryCents) * p.contracts;
      p.unrealizedUsd = round2(pnlCents / 100);

      const perContract = m.yes_bid - p.entryCents;
      if (perContract >= this.settings.takeProfitCents) {
        this.closePosition(p, "take-profit");
      } else if (perContract <= -this.settings.stopLossCents) {
        this.closePosition(p, "stop-loss");
      } else if (p.peakMidCents - this.mid(m) >= this.settings.momentumThresholdCents) {
        this.closePosition(p, "momentum reversal");
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
      scanMs: 0,
    };
    const seen: Signal[] = [];

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
      if (this.positions.length >= this.settings.maxPositions) continue;
      if (this.positions.some((p) => p.ticker === m.ticker)) continue;
      this.openPosition(m);
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
    const contracts = Math.floor((this.settings.tradeSizeUsd * 100) / m.yes_ask);
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

    this.cashUsd -= costUsd;
    this.positions.push({
      ticker: m.ticker,
      title: m.title,
      side: "yes",
      entryCents: m.yes_ask,
      contracts,
      currentBidCents: m.yes_bid,
      peakMidCents: this.mid(m),
      unrealizedUsd: round2(((m.yes_bid - m.yes_ask) * contracts) / 100),
      openedAt: Date.now(),
    });
    this.log(
      "trade",
      `OPEN ${m.ticker} — ${contracts}x YES @ ${m.yes_ask}c ` +
        `(${money(costUsd)}) [${m.title.slice(0, 60)}]`,
    );
    this.emitEvent({
      kind: "opened",
      tone: "info",
      title: `Opened ${m.ticker}`,
      body: `${contracts} contracts at ${m.yes_ask}c · ${money(costUsd)}`,
    });
  }

  private closePosition(p: Position, reason: string): void {
    if (this.isLive) {
      void this.client
        .placeOrder({ ticker: p.ticker, side: "yes", action: "sell", count: p.contracts })
        .catch((e) => this.log("error", `Live sell failed for ${p.ticker}: ${e.message}`));
    }

    const proceedsUsd = (p.currentBidCents * p.contracts) / 100;
    const pnlUsd = round2(proceedsUsd - (p.entryCents * p.contracts) / 100);
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

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function fmtCents(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}c`;
}
