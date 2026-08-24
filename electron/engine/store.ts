import { app } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Everything in here is written to settings.json in the clear, so it must stay
 * free of secrets. Kalshi credentials live in the encrypted vault instead —
 * see ./credentials.ts.
 */
export interface Settings {
  liveMode: boolean;
  dryRunCash: number; // starting paper cash in USD
  tradeSizeUsd: number; // per-trade budget in USD
  maxPositions: number;
  momentumThresholdCents: number;
  takeProfitCents: number;
  stopLossCents: number;
  tickSeconds: number;
  maxSpreadCents: number; // widest bid/ask gap we will pay
  minPriceCents: number; // ignore markets cheaper than this
  maxPriceCents: number; // ignore markets richer than this
  dailyLossLimitUsd: number; // engine halts itself past this loss; 0 disables
  reentryCooldownSeconds: number; // block re-entering a ticker just exited; 0 disables
  maxConsecutiveLosses: number; // halt after this many losses in a row; 0 disables
  /**
   * Exit once the mid falls this far from its peak. 0 disables.
   *
   * Until 1.4.0 this reused the entry trigger, so a 3c pullback closed every
   * position and the stop-loss setting almost never got a say.
   */
  trailingStopCents: number;
  tradingHoursEnabled: boolean; // confine entries to a window of the local day
  tradingStartHour: number; // 0-23, inclusive
  tradingEndHour: number; // 0-23, exclusive; may wrap past midnight
  /**
   * Enter with a resting limit order at the bid instead of crossing to the ask.
   *
   * This is the one change the simulations said flips the sign of the result
   * rather than the size: a maker pays no fee to open and never pays the
   * spread on entry. The price is that fills are not guaranteed, and the ones
   * that do arrive come when the price trades down through the bid — see
   * docs/STRATEGY-FINDINGS.md.
   */
  makerEntries: boolean;
  /** Scans a resting order waits before being cancelled unfilled. */
  makerTtlTicks: number;
  /**
   * Refuse entries whose take-profit clears the fees by less than this many
   * cents. Zero keeps only the old "must clear at all" rule.
   */
  minNetEdgeCents: number;
  /**
   * Skip markets whose recent moves have been mean-reverting (negative lag-1
   * autocorrelation). A momentum rule in a chopping market is buying every
   * head-fake at the top of it.
   */
  regimeFilterEnabled: boolean;
  /**
   * Halt once session equity falls this far below its session peak, in
   * percent. Trade size also scales down as drawdown approaches it. 0 disables.
   */
  maxDrawdownPct: number;
  /**
   * Measure momentum on the bid instead of the mid.
   *
   * The mid rises half of any one-sided quote change, so a seller pulling an
   * ask reads as buying pressure with nothing traded. The bid only rises when
   * a buyer is actually paying more.
   */
  momentumOnBid: boolean;
  /**
   * Refuse entries when no contracts traded during the momentum window —
   * quotes repositioning without prints is not momentum.
   */
  requireTradeActivity: boolean;
}

export interface AppState {
  disclaimerAccepted: boolean;
  startMinimized: boolean;
  startWithWindows: boolean;
  /** Windows toasts for fills, exits and halts. */
  notifications: boolean;
  /** Closing the window leaves the engine running in the tray. */
  closeToTray: boolean;
  /**
   * Keep recording market sweeps while the engine is stopped.
   *
   * Recording used to happen only inside the trading loop, which meant the
   * Backtest page had data exactly when the bot was busy and none when it was
   * parked — and a brake halt stopped data collection along with the trading.
   */
  passiveRecording: boolean;
}

export interface Profile {
  name: string;
  savedAt: number;
  /** liveMode is excluded so importing a profile can never arm real orders. */
  params: Omit<Settings, "liveMode">;
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

export const DEFAULT_SETTINGS: Settings = {
  liveMode: false,
  dryRunCash: 100,
  tradeSizeUsd: 10,
  maxPositions: 5,
  momentumThresholdCents: 3,
  // Must clear the ~3.5c round-trip fee plus the 2c spread with room to
  // spare, or a win is not worth taking. See docs/STRATEGY-FINDINGS.md.
  takeProfitCents: 12,
  // Was 4c, which with a 2c spread left only 2c of room and stopped trades out
  // almost on entry.
  stopLossCents: 12,
  tickSeconds: 15,
  maxSpreadCents: 2,
  minPriceCents: 5,
  maxPriceCents: 90,
  dailyLossLimitUsd: 50,
  reentryCooldownSeconds: 90,
  maxConsecutiveLosses: 4,
  trailingStopCents: 0,
  tradingHoursEnabled: false,
  tradingStartHour: 9,
  tradingEndHour: 21,
  makerEntries: false,
  makerTtlTicks: 4,
  minNetEdgeCents: 2,
  regimeFilterEnabled: false,
  maxDrawdownPct: 20,
  // Both gates default on. They were designed from the mechanism before being
  // measured, they can only refuse entries (a gate cannot create a bad trade,
  // only skip one), and on real recorded data the pair nearly halved the
  // per-trade loss of the old defaults. See docs/STRATEGY-FINDINGS.md.
  momentumOnBid: true,
  requireTradeActivity: true,
};

export const DEFAULT_APP_STATE: AppState = {
  disclaimerAccepted: false,
  startMinimized: false,
  startWithWindows: false,
  notifications: true,
  closeToTray: false,
  passiveRecording: true,
};

const MAX_EQUITY_POINTS = 720;

export function dataDir(): string {
  const dir = app.getPath("userData");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Notepad and PowerShell both write a UTF-8 BOM, which JSON.parse rejects. */
function readText(file: string): string | null {
  const p = path.join(dataDir(), file);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, "utf-8").replace(/^﻿/, "");
}

function readJson<T>(file: string, fallback: T): T {
  try {
    const raw = readText(file);
    if (raw === null) return fallback;
    return { ...fallback, ...JSON.parse(raw) };
  } catch {
    return fallback;
  }
}

function readArray<T>(file: string): T[] {
  try {
    const raw = readText(file);
    if (raw === null) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeJson(file: string, value: unknown): void {
  try {
    fs.writeFileSync(path.join(dataDir(), file), JSON.stringify(value, null, 2));
  } catch (e) {
    // Raw ENOENT/EPERM text tells the user nothing; name the folder involved.
    throw new Error(
      `Could not save ${file} to ${app.getPath("userData")}: ${(e as Error).message}`,
    );
  }
}

/** Clamp anything a hand-edited settings.json could put out of range. */
function sanitize(s: Settings): Settings {
  const num = (v: number, min: number, max: number, fallback: number) =>
    Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
  // Belt and braces: a pre-1.1.2 file, or a renderer that still sends them,
  // must never put credentials back into settings.json.
  const clean = { ...s } as Settings & Record<string, unknown>;
  delete clean.apiKeyId;
  delete clean.apiPrivateKeyPem;
  return {
    ...clean,
    dryRunCash: num(s.dryRunCash, 1, 1_000_000, DEFAULT_SETTINGS.dryRunCash),
    tradeSizeUsd: num(s.tradeSizeUsd, 1, 100_000, DEFAULT_SETTINGS.tradeSizeUsd),
    maxPositions: Math.round(num(s.maxPositions, 1, 50, DEFAULT_SETTINGS.maxPositions)),
    momentumThresholdCents: num(s.momentumThresholdCents, 1, 50, 3),
    takeProfitCents: num(s.takeProfitCents, 1, 90, 6),
    stopLossCents: num(s.stopLossCents, 1, 90, 4),
    tickSeconds: num(s.tickSeconds, 5, 600, 15),
    maxSpreadCents: num(s.maxSpreadCents, 1, 20, 2),
    minPriceCents: num(s.minPriceCents, 1, 98, 5),
    maxPriceCents: num(s.maxPriceCents, 2, 99, 90),
    dailyLossLimitUsd: num(s.dailyLossLimitUsd, 0, 1_000_000, 50),
    reentryCooldownSeconds: num(s.reentryCooldownSeconds, 0, 3600, 90),
    maxConsecutiveLosses: Math.round(num(s.maxConsecutiveLosses, 0, 100, 4)),
    trailingStopCents: Math.round(num(s.trailingStopCents, 0, 90, 0)),
    tradingHoursEnabled: Boolean(s.tradingHoursEnabled),
    tradingStartHour: Math.round(num(s.tradingStartHour, 0, 23, 9)),
    tradingEndHour: Math.round(num(s.tradingEndHour, 0, 23, 21)),
    makerEntries: Boolean(s.makerEntries),
    makerTtlTicks: Math.round(num(s.makerTtlTicks, 1, 120, DEFAULT_SETTINGS.makerTtlTicks)),
    minNetEdgeCents: num(s.minNetEdgeCents, 0, 30, DEFAULT_SETTINGS.minNetEdgeCents),
    regimeFilterEnabled: Boolean(s.regimeFilterEnabled),
    maxDrawdownPct: num(s.maxDrawdownPct, 0, 95, DEFAULT_SETTINGS.maxDrawdownPct),
    momentumOnBid: Boolean(s.momentumOnBid),
    requireTradeActivity: Boolean(s.requireTradeActivity),
  };
}

export function loadSettings(): Settings {
  return sanitize(readJson<Settings>("settings.json", DEFAULT_SETTINGS));
}

export function saveSettings(s: Settings): void {
  writeJson("settings.json", sanitize(s));
}

export function loadAppState(): AppState {
  return readJson<AppState>("app-state.json", DEFAULT_APP_STATE);
}

export function saveAppState(s: AppState): void {
  writeJson("app-state.json", s);
}

export function loadHistory(): TradeRecord[] {
  return readArray<TradeRecord>("history.json");
}

export function appendHistory(t: TradeRecord): TradeRecord[] {
  const all = loadHistory();
  all.push(t);
  writeJson("history.json", all);
  return all;
}

export function clearHistory(): void {
  writeJson("history.json", []);
}

export function loadProfiles(): Profile[] {
  return readArray<Profile>("profiles.json");
}

export function saveProfile(name: string, s: Settings): Profile[] {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Give the profile a name first.");
  const { liveMode: _l, ...params } = s;
  const all = loadProfiles().filter((x) => x.name !== trimmed);
  all.push({ name: trimmed, savedAt: Date.now(), params });
  all.sort((a, b) => a.name.localeCompare(b.name));
  writeJson("profiles.json", all);
  return all;
}

export function deleteProfile(name: string): Profile[] {
  const all = loadProfiles().filter((x) => x.name !== name);
  writeJson("profiles.json", all);
  return all;
}

export function loadEquity(): EquityPoint[] {
  return readArray<EquityPoint>("equity.json");
}

export function appendEquity(p: EquityPoint): void {
  const all = loadEquity();
  all.push(p);
  // Keep the file bounded; the chart only ever shows a trailing window.
  writeJson("equity.json", all.slice(-MAX_EQUITY_POINTS));
}

export function clearEquity(): void {
  writeJson("equity.json", []);
}

/** Wipes every file this app owns. The caller is responsible for confirming. */
export function factoryReset(): void {
  for (const f of [
    "settings.json",
    "history.json",
    "profiles.json",
    "equity.json",
    "app-state.json",
    "credentials.dat",
    "scans.jsonl",
  ]) {
    try {
      const p = path.join(dataDir(), f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // a locked file shouldn't abort the rest of the reset
    }
  }
}

export function historyToCsv(rows: TradeRecord[]): string {
  const head = [
    "closed_at",
    "opened_at",
    "ticker",
    "title",
    "contracts",
    "entry_cents",
    "exit_cents",
    "pnl_usd",
    "reason",
    "mode",
  ];
  const esc = (v: unknown) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = rows.map((r) =>
    [
      new Date(r.closedAt).toISOString(),
      new Date(r.openedAt).toISOString(),
      r.ticker,
      r.title,
      r.contracts,
      r.entryCents,
      r.exitCents,
      r.pnlUsd.toFixed(2),
      r.reason,
      r.dryRun ? "paper" : "live",
    ]
      .map(esc)
      .join(","),
  );
  return [head.join(","), ...lines].join("\r\n");
}
