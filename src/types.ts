export interface Position {
  ticker: string;
  title: string;
  side: "yes";
  entryCents: number;
  contracts: number;
  currentBidCents: number;
  peakMidCents: number;
  unrealizedUsd: number;
  tpRestingCents: number | null;
  openedAt: number;
}

export interface Signal {
  ticker: string;
  title: string;
  midCents: number;
  bidCents: number;
  askCents: number;
  spreadCents: number;
  changeCents: number | null;
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
  skippedEvent: number;
  skippedJumpy: number;
  skippedClock: number;
  skippedFees: number;
  skippedRegime: number;
  skippedQuiet: number;
  skippedClosing: number;
  scanMs: number;
}

/** A resting maker order that has not filled yet. Its cash is already reserved. */
export interface PendingOrder {
  ticker: string;
  title: string;
  side: "yes";
  limitCents: number;
  contracts: number;
  costUsd: number;
  placedAt: number;
  ticksLeft: number;
  orderId: string | null;
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
  idleHint: string | null;
  startedAt: number | null;
}

export interface LogLine {
  ts: number;
  level: "info" | "trade" | "warn" | "error";
  msg: string;
}

/** Secrets are not in here — see CredentialStatus. */
export interface Settings {
  liveMode: boolean;
  dryRunCash: number;
  tradeSizeUsd: number;
  maxPositions: number;
  /** Most concurrent positions within one event ladder (sibling strikes). */
  maxPositionsPerEvent: number;
  momentumThresholdCents: number;
  takeProfitCents: number;
  stopLossCents: number;
  tickSeconds: number;
  maxSpreadCents: number;
  minPriceCents: number;
  maxPriceCents: number;
  dailyLossLimitUsd: number;
  reentryCooldownSeconds: number;
  maxConsecutiveLosses: number;
  trailingStopCents: number;
  tradingHoursEnabled: boolean;
  tradingStartHour: number;
  tradingEndHour: number;
  makerEntries: boolean;
  makerTtlTicks: number;
  minNetEdgeCents: number;
  regimeFilterEnabled: boolean;
  maxDrawdownPct: number;
  momentumOnBid: boolean;
  requireTradeActivity: boolean;
  /** Refuse single-jump moves: more than half the window's steps must rise. */
  requireConsistentMove: boolean;
  makerExits: boolean;
  minMinutesToClose: number;
}

export interface CredentialStatus {
  configured: boolean;
  keyIdHint: string;
  encryptionAvailable: boolean;
  error: string | null;
}

export type StrategyParams = Omit<Settings, "liveMode" | "dryRunCash">;

export interface Strategy {
  id: string;
  name: string;
  tagline: string;
  detail: string;
  risk: "low" | "medium" | "high";
  params: StrategyParams;
}

export interface Profile {
  name: string;
  savedAt: number;
  params: Omit<Settings, "liveMode">;
}

export interface AppSettings {
  disclaimerAccepted: boolean;
  startMinimized: boolean;
  startWithWindows: boolean;
  notifications: boolean;
  closeToTray: boolean;
  passiveRecording: boolean;
}

export interface TradeRecord {
  ticker: string;
  title: string;
  side: "yes";
  entryCents: number;
  exitCents: number;
  contracts: number;
  pnlUsd: number;
  openedAt: number;
  closedAt: number;
  reason: string;
  dryRun: boolean;
}

export interface EquityPoint {
  ts: number;
  equityUsd: number;
}

export interface TestResult {
  ok: boolean;
  balanceUsd?: number;
  message: string;
}

export interface ExportResult {
  saved: boolean;
  message: string;
  filePath?: string;
}

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "current"
  | "error"
  | "unsupported";

export interface UpdateState {
  status: UpdateStatus;
  currentVersion: string;
  newVersion: string | null;
  percent: number;
  message: string | null;
  checkedAt: number | null;
}

export interface RecordingInfo {
  exists: boolean;
  scans: number;
  bytes: number;
  firstTs: number | null;
  lastTs: number | null;
}

/**
 * Progress collecting what markets actually settled at, which the quote
 * recording cannot say. `pending` counts markets seen and not yet resolved;
 * `due` counts the subset already past their close and being asked about.
 */
export interface SettlementInfo {
  settled: number;
  pending: number;
  due: number;
  firstTs: number | null;
  lastTs: number | null;
}

/**
 * Recorded prints. Quotes say what was on offer; only these say what was
 * taken, which is the difference between guessing and measuring whether a
 * resting order would have filled.
 */
export interface TapeInfo {
  exists: boolean;
  trades: number;
  bytes: number;
  firstTs: number | null;
  lastTs: number | null;
}

/** The underlying's own price, which every fair-value question needs. */
export interface SpotInfo {
  exists: boolean;
  points: number;
  assets: number;
  firstTs: number | null;
  lastTs: number | null;
}

/** What is resting behind the quote, as opposed to what it costs. */
export interface DepthInfo {
  exists: boolean;
  points: number;
  markets: number;
  bytes: number;
  firstTs: number | null;
  lastTs: number | null;
}

/** One entry-price band of the calibration study. */
export interface CalibrationBand {
  label: string;
  n: number;
  events: number;
  meanQuote: number;
  realised: number;
  gapPp: number;
  realisedCI: [number, number];
  buyYes: number;
  buyYesCI: [number, number];
  buyNo: number;
  buyNoCI: [number, number];
}

/**
 * Does a price on this venue mean what it says, and is any error big enough to
 * trade? Computed on the user's own recording, with event-clustered intervals.
 */
export interface CalibrationReport {
  markets: number;
  events: number;
  horizonMinutes: number;
  yesRate: number;
  bands: CalibrationBand[];
  tradeable: string[];
  suppressed: string[];
  verdict: string;
}

export interface CalibrationProgressEvent {
  file: string;
  index: number;
  total: number;
}

/**
 * OpenRouter status. Deliberately carries a hint and never the key — the vault
 * has no read path to the renderer, exactly like the Kalshi credentials.
 */
export interface AiStatus {
  configured: boolean;
  keyHint: string;
  model: string;
  encryptionAvailable: boolean;
  error: string | null;
}

export interface NarrationInput {
  subject: string;
  summary: string;
  evidence: { label: string; value: string }[];
}

export type NarrationResult =
  | { ok: true; text: string; model: string }
  | { ok: false; text: string; reason: string };

export interface PerformanceMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  grossWinUsd: number;
  grossLossUsd: number;
  profitFactor: number | null;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  payoffRatio: number | null;
  expectancyUsd: number | null;
  sharpePerTrade: number | null;
  sortinoPerTrade: number | null;
  maxDrawdownUsd: number;
  maxDrawdownPct: number | null;
  longestWinStreak: number;
  longestLossStreak: number;
}

export interface BacktestResult {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  pnlUsd: number;
  maxDrawdownUsd: number;
  bestUsd: number;
  worstUsd: number;
  halted: boolean;
  haltedReason: string | null;
  equity: { ts: number; equityUsd: number }[];
  exitReasons: Record<string, number>;
  metrics: PerformanceMetrics;
  maker: boolean;
  ordersPlaced: number;
  ordersFilled: number;
  ordersExpired: number;
}

export interface SweepCandidate {
  label: string;
  settings: Settings;
  trainPnlUsd: number;
  trainTrades: number;
  testPnlUsd: number;
  testTrades: number;
  testWinRate: number | null;
  /** Positive when it did better on unseen data than on training data. */
  generalisationGapUsd: number;
}

export interface SweepReport {
  scansTrain: number;
  scansTest: number;
  candidates: SweepCandidate[];
  baseline: SweepCandidate | null;
  bestOutOfSample: SweepCandidate | null;
  /** True when even the best candidate lost money on unseen data. */
  nothingWorked: boolean;
  notes: string[];
}

export interface SweepProgress {
  done: number;
  total: number;
}

export interface InstallRefusal {
  installed: false;
  reason: string;
}

export interface RomApi {
  engine: {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    flatten: () => Promise<number>;
    getState: () => Promise<EngineState>;
    getLogs: () => Promise<LogLine[]>;
    getSignals: () => Promise<Signal[]>;
    /** Acknowledges a self-imposed halt; limits stay, their allowance restarts. */
    clearHalt: () => Promise<void>;
    onState: (cb: (s: EngineState) => void) => () => void;
    onLog: (cb: (l: LogLine) => void) => () => void;
  };
  settings: {
    get: () => Promise<Settings>;
    set: (s: Settings) => Promise<Settings>;
  };
  history: {
    get: () => Promise<TradeRecord[]>;
    clear: (mode?: "all" | "paper" | "live") => Promise<TradeRecord[]>;
    export: () => Promise<ExportResult>;
  };
  equity: { get: () => Promise<EquityPoint[]> };
  strategies: {
    list: () => Promise<Strategy[]>;
    apply: (id: string) => Promise<Settings>;
  };
  profiles: {
    list: () => Promise<Profile[]>;
    save: (name: string) => Promise<Profile[]>;
    apply: (name: string) => Promise<Settings>;
    delete: (name: string) => Promise<Profile[]>;
  };
  /** No getter for the key itself — it only ever travels toward the vault. */
  credentials: {
    status: () => Promise<CredentialStatus>;
    set: (c: { apiKeyId: string; apiPrivateKeyPem: string }) => Promise<CredentialStatus>;
    clear: () => Promise<CredentialStatus>;
  };
  kalshi: {
    test: () => Promise<TestResult>;
    balance: () => Promise<number | null>;
  };
  backtest: {
    info: () => Promise<RecordingInfo>;
    settlements: () => Promise<SettlementInfo>;
    tape: () => Promise<TapeInfo>;
    run: () => Promise<BacktestResult[]>;
    clear: () => Promise<RecordingInfo>;
    sweep: () => Promise<SweepReport>;
    onSweepProgress: (cb: (p: SweepProgress) => void) => () => void;
    spot: () => Promise<SpotInfo>;
    depth: () => Promise<DepthInfo>;
  };
  research: {
    calibrate: (horizonMinutes: number) => Promise<CalibrationReport>;
    onProgress: (cb: (p: CalibrationProgressEvent) => void) => () => void;
  };
  ai: {
    status: () => Promise<AiStatus>;
    models: () => Promise<{ id: string; label: string }[]>;
    save: (apiKey: string, model: string) => Promise<AiStatus>;
    clear: () => Promise<AiStatus>;
    narrate: (input: NarrationInput) => Promise<NarrationResult>;
  };
  app: {
    version: () => Promise<string>;
    dataDir: () => Promise<string>;
    openDataFolder: () => Promise<string>;
    openMarket: (ticker: string) => Promise<void>;
    /** ROM's Kalshi sign-up link, or null when no referral code is configured. */
    referral: () => Promise<string | null>;
    openReferral: () => Promise<void>;
    /** Clears results and halts; keeps keys, settings, setups and recordings. */
    resetTradingData: () => Promise<TradeRecord[]>;
    factoryReset: () => Promise<Settings>;
  };
  state: {
    get: () => Promise<AppSettings>;
    set: (patch: Partial<AppSettings>) => Promise<AppSettings>;
  };
  update: {
    get: () => Promise<UpdateState>;
    check: () => Promise<UpdateState>;
    install: (force: boolean) => Promise<InstallRefusal>;
    onState: (cb: (s: UpdateState) => void) => () => void;
  };
  window: {
    minimize: () => void;
    maximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizeChange: (cb: (v: boolean) => void) => () => void;
  };
}

declare global {
  interface Window {
    rom: RomApi;
  }
}
