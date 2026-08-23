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
  tradingHoursEnabled: boolean;
  tradingStartHour: number;
  tradingEndHour: number;
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
    onState: (cb: (s: EngineState) => void) => () => void;
    onLog: (cb: (l: LogLine) => void) => () => void;
  };
  settings: {
    get: () => Promise<Settings>;
    set: (s: Settings) => Promise<Settings>;
  };
  history: {
    get: () => Promise<TradeRecord[]>;
    clear: () => Promise<TradeRecord[]>;
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
  app: {
    version: () => Promise<string>;
    dataDir: () => Promise<string>;
    openDataFolder: () => Promise<string>;
    openMarket: (ticker: string) => Promise<void>;
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
