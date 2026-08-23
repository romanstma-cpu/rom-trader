import { KalshiClient, KalshiMarket } from "./kalshi";
import {
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
  startedAt: number | null;
}

export interface LogLine {
  ts: number;
  level: "info" | "trade" | "warn" | "error";
  msg: string;
}

type Listener = {
  onState: (s: EngineState) => void;
  onLog: (l: LogLine) => void;
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
  private signals: Signal[] = [];
  private scanner: ScannerStats | null = null;

  private static readonly LOOKBACK = 3; // samples back for momentum
  private static readonly MAX_HISTORY = 20;
  private static readonly MAX_SIGNALS = 60;

  constructor(settings: Settings) {
    this.settings = settings;
    this.client = new KalshiClient(settings.apiKeyId, settings.apiPrivateKeyPem);
    this.cashUsd = settings.dryRunCash;
  }

  subscribe(l: Listener): void {
    this.listeners.push(l);
  }

  updateSettings(s: Settings): void {
    const tickChanged = s.tickSeconds !== this.settings.tickSeconds;
    this.settings = s;
    this.client = new KalshiClient(s.apiKeyId, s.apiPrivateKeyPem);
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
    const history = loadHistory();
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
    this.signals = [];
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
      this.updatePositions(markets);
      this.scanForEntries(markets, began);
      this.enforceDailyLossLimit();
      appendEquity({ ts: Date.now(), equityUsd: round2(this.equity()) });
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
    const today = this.todayPnl(loadHistory());
    if (today > -limit) return;
    this.haltedReason =
      `Daily loss limit hit (${money(today)} today, limit ${money(-limit)}). ` +
      `Engine stopped itself. Raise or clear the limit in Settings to resume.`;
    this.log("warn", this.haltedReason);
    this.stop();
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
    const stats: ScannerStats = {
      marketsScanned: markets.length,
      tracked: 0,
      eligible: 0,
      skippedSpread: 0,
      skippedPrice: 0,
      skippedWarmup: 0,
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

      if (m.yes_ask < this.settings.minPriceCents || m.yes_ask > this.settings.maxPriceCents) {
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
      appendHistory(rec);
    } catch (e) {
      this.log("error", `Trade closed but could not be saved: ${(e as Error).message}`);
    }
    this.log(
      "trade",
      `CLOSE ${p.ticker} — ${p.contracts}x @ ${p.currentBidCents}c ` +
        `(${pnlUsd >= 0 ? "+" : ""}${money(pnlUsd)}, ${reason})`,
    );
  }

  private log(level: LogLine["level"], msg: string): void {
    const line: LogLine = { ts: Date.now(), level, msg };
    this.logs.push(line);
    if (this.logs.length > 500) this.logs.shift();
    for (const l of this.listeners) l.onLog(line);
  }

  private emitState(): void {
    const s = this.getState();
    for (const l of this.listeners) l.onState(s);
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
