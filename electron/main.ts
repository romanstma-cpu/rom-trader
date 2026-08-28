import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { installCrashHandlers, reportFatal } from "./crashlog";
import { checkForUpdates, getUpdateState, initUpdater, installUpdate } from "./updater";
import { compareStrategies } from "./engine/backtest";
import { runSweepAsync } from "./engine/sweep";
import { type EngineEvent, TradingEngine } from "./engine/engine";
import { clearRecording, loadRecording, recordScan, recordingInfo } from "./engine/recorder";
import {
  clearCredentials,
  credentialStatus,
  loadCredentials,
  migrateLegacyCredentials,
  saveCredentials,
} from "./engine/credentials";
import { KalshiClient, type KalshiMarket } from "./engine/kalshi";
import {
  clearSettlements,
  noteMarkets,
  settlementInfo,
  sweepSettlements,
} from "./engine/settlements";
import { clearTape, keepTrades, nextPollFrom, recordTrades, tapeInfo } from "./engine/tape";
import { clearSpot, spotInfo, sweepSpot } from "./engine/spot";
import { clearDepth, depthInfo, sweepDepth } from "./engine/depth";
import {
  FREE_MODELS,
  aiStatus,
  clearAi,
  looksLikeKey,
  narrate,
  saveAi,
  type NarrationInput,
} from "./engine/ai";
import { STRATEGIES, findStrategy } from "./engine/strategies";
import {
  AppState,
  Settings,
  appendEquity,
  clearEquity,
  clearHistory,
  dataDir,
  deleteProfile,
  factoryReset,
  historyToCsv,
  loadAppState,
  loadEquity,
  loadHistory,
  loadProfiles,
  loadSettings,
  resetTradingData,
  saveAppState,
  saveProfile,
  saveSettings,
} from "./engine/store";

installCrashHandlers();

// Windows routes toasts by App User Model ID and silently drops them when it
// does not match a known shortcut. electron-builder registers this id from
// build.appId when it creates the Start Menu entry, so it has to agree.
if (process.platform === "win32") app.setAppUserModelId("trade.rom.app");

let win: BrowserWindow | null = null;
let engine: TradingEngine;

/**
 * Send to the renderer, or quietly do nothing if it is already gone.
 *
 * On quit the BrowserWindow object outlives its webContents, so `win?.` is not
 * enough: the reference is non-null while the contents underneath are
 * destroyed, and sending to those throws "Object has been destroyed". That
 * escapes as an uncaught exception during shutdown and Electron shows its
 * blank "A JavaScript error occurred in the main process" dialog — which is
 * what users hit when closing the app with the engine still running.
 */
function sendToRenderer(channel: string, payload?: unknown): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

let tray: Tray | null = null;
/** Set when the user really means to exit, so close-to-tray can be bypassed. */
let quitting = false;

function iconPath(): string {
  return path.join(__dirname, "../assets/icon.ico");
}

/**
 * A toast for the handful of events worth interrupting someone for.
 *
 * Silent by design: a bot that pings for every fill during an active session
 * gets muted at the OS level, and then it cannot tell you about the halt that
 * actually mattered.
 */
function notify(e: EngineEvent): void {
  if (!loadAppState().notifications) return;
  if (!Notification.isSupported()) return;
  try {
    const n = new Notification({
      title: e.title,
      body: e.body,
      icon: iconPath(),
      silent: e.kind !== "halted",
    });
    n.on("click", () => showWindow());
    n.show();
  } catch {
    // Notifications are a convenience; never let one break a trading tick.
  }
}

function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

function refreshTray(): void {
  if (!tray) return;
  const s = engine?.getState();
  const running = s?.status === "running";
  const open = s?.positions.length ?? 0;

  tray.setToolTip(
    running
      ? `ROM Trader — running${open > 0 ? `, ${open} open` : ""}`
      : "ROM Trader — idle",
  );

  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: running ? `Running · ${open} open` : "Idle", enabled: false },
      { type: "separator" },
      { label: "Open ROM Trader", click: () => showWindow() },
      {
        label: running ? "Stop trading" : "Start trading",
        click: () => {
          if (running) engine.stop();
          else engine.start();
          refreshTray();
        },
      },
      {
        label: "Close all positions",
        enabled: open > 0,
        click: () => {
          engine.flatten();
          refreshTray();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
}

function createTray(): void {
  if (tray) return;
  try {
    tray = new Tray(iconPath());
    tray.on("double-click", () => showWindow());
    refreshTray();
  } catch {
    // Without a tray the app still works; it just cannot be hidden to one.
    tray = null;
  }
}

function createWindow(): void {
  const appState = loadAppState();

  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 1040,
    minHeight: 660,
    backgroundColor: "#0d0a14",
    title: "ROM Trader",
    icon: path.join(__dirname, "../assets/icon.ico"),
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.once("ready-to-show", () => {
    if (appState.startMinimized) win?.minimize();
    else win?.show();
  });

  const relay = () => sendToRenderer("window:maximizeChange", win?.isMaximized() ?? false);
  win.on("maximize", relay);
  win.on("unmaximize", relay);

  // Closing hides the window instead of quitting, but only when the user has
  // asked for that and there is a tray icon to get back from. Hiding with no
  // way to reopen would look exactly like a crash that kept trading.
  win.on("close", (e) => {
    if (quitting || !loadAppState().closeToTray || !tray) return;
    e.preventDefault();
    win?.hide();
  });

  const indexHtml = path.join(__dirname, "../dist/index.html");
  win.loadFile(indexHtml).catch((e) => {
    reportFatal(
      new Error(`Could not load the app UI from ${indexHtml}: ${(e as Error).message}`),
      "loadFile",
    );
  });
}

/**
 * Records market sweeps while the engine is parked.
 *
 * Recording used to live inside the trading loop, so the Backtest page had
 * data exactly when the bot was busy and none when it was not — and a brake
 * halt stopped data collection along with the trading, which is backwards:
 * the stretch after a halt is precisely the one worth studying later.
 *
 * Public endpoint, no credentials, one request every thirty seconds. While
 * the engine runs it records its own sweeps and this loop stands down, so
 * nothing is written twice.
 */
function startPassiveRecorder(): void {
  const publicClient = new KalshiClient();
  let sweeping = false;
  setInterval(() => {
    if (sweeping) return;
    if (engine.getState().status === "running") return;
    if (!loadAppState().passiveRecording) return;
    sweeping = true;
    publicClient
      .getActiveMarkets(40)
      .then((markets) => keepScan(markets))
      .catch(() => {
        // Offline or rate-limited: skip this sweep, try again next interval.
      })
      .finally(() => {
        sweeping = false;
      });
  }, 30_000);
}

/**
 * A sweep is worth two different things and they are stored separately: the
 * quotes, for replaying a strategy against the path, and the ticker, so its
 * eventual outcome can be collected. Both call sites go through here so a
 * future third one cannot record half of it.
 */
function keepScan(markets: KalshiMarket[]): void {
  recordScan(markets);
  noteMarkets(markets);
  recordedUniverse.clear();
  for (const m of markets) recordedUniverse.add(m.ticker);
}

/**
 * The tickers in the most recent sweep, which is what the tape polls.
 *
 * Replaced rather than accumulated. A cumulative set would keep every market
 * ever seen and poll thousands of settled tickers within a day, and the trades
 * it collected would be for periods with no quotes recorded beside them —
 * unjoinable, and paid for with real requests. A market that drops off the
 * volume table stops being polled, which is exactly right: the study only ever
 * asks whether an order rested during a window we have quotes for.
 */
const recordedUniverse = new Set<string>();

/**
 * ROM's Kalshi referral code, from Kalshi → Menu → Referrals.
 *
 * EMPTY DISABLES THE CARD ENTIRELY. That is deliberate rather than lazy: a
 * half-configured affiliate link is worse than none, because it ships a button
 * that either 404s or credits nobody, and the person who clicked it can no
 * longer be credited afterwards — Kalshi only accepts a code before the first
 * deposit and within 72 hours of signup.
 *
 * Kalshi's own copy is "up to $500"; the published distribution is $15 for 70%
 * of claimants, $35 for 24%, $75 for 5%, $100 for 0.65% and $500 for 0.35%.
 * The credit needs identity verification plus a trading requirement, and
 * expires seven days after it is granted. Whatever the card says has to match
 * that, because it is a promotional claim about a regulated venue.
 */
const KALSHI_REFERRAL_CODE = "07e2562a-3ef4-4b05-94e8-889e8d98b238";

/**
 * Kalshi's own short form, `kalshi.com/r/<code>`, rather than a hand-built
 * `sign-up?referral=` query. The two are not interchangeable to guess between:
 * a referral that lands on the wrong shape credits nobody, and Kalshi only
 * accepts a code before the first deposit and inside 72 hours of signup, so
 * there is no repairing it afterwards for whoever clicked.
 */
function referralUrl(): string | null {
  const code = KALSHI_REFERRAL_CODE.trim();
  if (code === "") return null;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(code)) return null;
  return `https://kalshi.com/r/${encodeURIComponent(code)}`;
}

/**
 * Collects settlement outcomes for markets that have already closed.
 *
 * Runs whether or not the engine is trading and whether or not quote recording
 * is switched on. That sounds like ignoring the user's preference and is not:
 * the backlog only ever grows while recording is enabled, so turning recording
 * off lets this drain what was already gathered and then fall silent. Throwing
 * away outcomes for quotes already on disk would waste the recording rather
 * than respect the setting.
 *
 * Public endpoint, ten lookups a minute. Kalshi's read budget at the lowest
 * tier is two hundred a second.
 */
/**
 * Records the trade tape for the markets already being recorded.
 *
 * Runs alongside quote recording rather than instead of it, because the two
 * answer different questions: quotes say what was on offer, the tape says what
 * was taken. Only the second can tell whether a resting order would have
 * filled, and that is the question the whole passive-execution case turns on.
 *
 * Gated on the same setting as quote recording — unlike the settlement sweep,
 * this collects new data rather than completing data already gathered, so
 * switching recording off must switch it off too.
 */
function startTapeRecorder(): void {
  const publicClient = new KalshiClient();
  let polling = false;

  /** Small, so forty requests cannot starve a trading write of its budget. */
  const CONCURRENCY = 4;

  async function pollOnce(): Promise<void> {
    const since = nextPollFrom();
    const tickers = [...recordedUniverse];
    for (let i = 0; i < tickers.length; i += CONCURRENCY) {
      const batch = tickers.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((t) => publicClient.getTrades(t, since)),
      );
      const got: Parameters<typeof recordTrades>[0] = [];
      for (const r of results) {
        // One market being unreachable must not cost the other thirty-nine.
        if (r.status === "fulfilled") got.push(...r.value.trades);
      }
      recordTrades(keepTrades(got, recordedUniverse));
    }
  }

  setInterval(() => {
    if (polling) return;
    if (!loadAppState().passiveRecording) return;
    if (recordedUniverse.size === 0) return; // nothing to join trades to yet
    polling = true;
    pollOnce()
      .catch(() => {
        // Offline. The watermark only advances on a successful write, so the
        // next poll asks for the same window and nothing is lost.
      })
      .finally(() => {
        polling = false;
      });
  }, 30_000);
}

/**
 * Records what is resting behind the quote.
 *
 * Every study so far has read the touch, which says what a trade would cost and
 * nothing about what is standing there. Depth is the last free input Kalshi
 * publishes that this app has never stored, and it is the only one that cannot
 * be backfilled — the tape and the settlements could be fetched for markets
 * that closed days ago, but a book that has already resolved is gone. So it
 * starts recording now, before the study that reads it exists.
 *
 * Gated on the same setting as the tape and spot: it collects new data rather
 * than completing data already gathered, so switching recording off must switch
 * it off too.
 */
function startDepthRecorder(): void {
  const publicClient = new KalshiClient();
  let polling = false;

  setInterval(() => {
    if (polling) return;
    if (!loadAppState().passiveRecording) return;
    if (recordedUniverse.size === 0) return; // nothing to attach a book to yet
    polling = true;
    sweepDepth((t) => publicClient.getOrderbook(t), [...recordedUniverse])
      .catch(() => {
        // Offline or rate-limited. Books are a snapshot, not a stream — a
        // missed poll is a missed moment, not a gap that needs repairing.
      })
      .finally(() => {
        polling = false;
      });
  }, 30_000);
}

/**
 * Records the underlying's price alongside the contract's.
 *
 * The one input every fair-value question needs, and the app has never had it.
 * Every strategy measured so far has been a bet about the CONTRACT; a Kalshi
 * crypto ladder settles on BTC, and without BTC's price there is no way to ask
 * what a strike should be worth.
 *
 * Coinbase returns roughly 350 one-minute candles per request, so this catches
 * up after a restart instead of starting blind, and one poll a minute across
 * four assets costs nothing. Gated on the same switch as the tape: it collects
 * new data rather than completing data already gathered.
 */
function startSpotRecorder(): void {
  let polling = false;
  setInterval(() => {
    if (polling) return;
    if (!loadAppState().passiveRecording) return;
    polling = true;
    sweepSpot()
      .catch(() => {
        // Offline. Nothing is written, and the next poll re-requests the same
        // window — Coinbase always returns the recent history.
      })
      .finally(() => {
        polling = false;
      });
  }, 60_000);
}

function startSettlementSweeper(): void {
  const publicClient = new KalshiClient();
  let sweeping = false;
  setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    sweepSettlements((ticker) =>
      publicClient.getMarket(ticker).then((m) => ({ status: m.status, result: m.result })),
    )
      .catch(() => {
        // Offline: the pending map is unchanged, so nothing is lost.
      })
      .finally(() => {
        sweeping = false;
      });
  }, 60_000);
}

function registerIpc(): void {
  ipcMain.handle("engine:start", () => engine.start());
  ipcMain.handle("engine:stop", () => engine.stop());
  ipcMain.handle("engine:flatten", () => engine.flatten());
  ipcMain.handle("engine:getState", () => engine.getState());
  ipcMain.handle("engine:getLogs", () => engine.getLogs());
  ipcMain.handle("engine:getSignals", () => engine.getSignals());
  ipcMain.handle("engine:clearHalt", () => engine.clearHalt());

  ipcMain.handle("settings:get", () => loadSettings());
  ipcMain.handle("settings:set", (_e, s: Settings) => {
    saveSettings(s);
    engine.updateSettings(loadSettings());
    return loadSettings();
  });

  ipcMain.handle("history:get", () => loadHistory());
  ipcMain.handle("history:clear", (_e, mode: "all" | "paper" | "live" = "all") => {
    const kept = clearHistory(mode);
    // The equity curve is one line across both modes, so it can only be
    // truthfully kept when nothing was deleted from under it.
    if (mode === "all") clearEquity();
    return kept;
  });
  ipcMain.handle("history:export", async () => {
    const rows = loadHistory();
    if (rows.length === 0) return { saved: false, message: "There are no trades to export yet." };
    const stamp = new Date().toISOString().slice(0, 10);
    const res = await dialog.showSaveDialog(win!, {
      title: "Export trade history",
      defaultPath: path.join(app.getPath("documents"), `rom-trader-history-${stamp}.csv`),
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (res.canceled || !res.filePath) return { saved: false, message: "Export cancelled." };
    fs.writeFileSync(res.filePath, historyToCsv(rows), "utf-8");
    return { saved: true, message: `Exported ${rows.length} trades.`, filePath: res.filePath };
  });

  ipcMain.handle("equity:get", () => loadEquity());

  ipcMain.handle("strategies:list", () => STRATEGIES);
  ipcMain.handle("strategies:apply", (_e, id: string) => {
    const strat = findStrategy(id);
    if (!strat) throw new Error(`Unknown strategy "${id}".`);
    const next = { ...loadSettings(), ...strat.params };
    saveSettings(next);
    engine.updateSettings(loadSettings());
    return loadSettings();
  });

  ipcMain.handle("profiles:list", () => loadProfiles());
  ipcMain.handle("profiles:save", (_e, name: string) => saveProfile(name, loadSettings()));
  ipcMain.handle("profiles:apply", (_e, name: string) => {
    const p = loadProfiles().find((x) => x.name === name);
    if (!p) throw new Error(`No saved profile called "${name}".`);
    const next = { ...loadSettings(), ...p.params };
    saveSettings(next);
    engine.updateSettings(loadSettings());
    return loadSettings();
  });
  ipcMain.handle("profiles:delete", (_e, name: string) => deleteProfile(name));

  // The private key is deliberately write-only across this boundary: the
  // renderer can set it or clear it, but never read it back.
  ipcMain.handle("credentials:status", () => credentialStatus());
  ipcMain.handle("credentials:set", (_e, c: { apiKeyId: string; apiPrivateKeyPem: string }) => {
    saveCredentials({
      apiKeyId: String(c?.apiKeyId ?? ""),
      apiPrivateKeyPem: String(c?.apiPrivateKeyPem ?? ""),
    });
    engine.updateCredentials(loadCredentials());
    return credentialStatus();
  });
  ipcMain.handle("credentials:clear", () => {
    clearCredentials();
    // Clearing keys can never leave the engine armed for real orders.
    saveSettings({ ...loadSettings(), liveMode: false });
    engine.updateCredentials(loadCredentials());
    engine.updateSettings(loadSettings());
    return credentialStatus();
  });

  ipcMain.handle("kalshi:test", async () => {
    const c = loadCredentials();
    return new KalshiClient(c.apiKeyId, c.apiPrivateKeyPem).testConnection();
  });
  ipcMain.handle("kalshi:balance", async () => {
    const cred = loadCredentials();
    const c = new KalshiClient(cred.apiKeyId, cred.apiPrivateKeyPem);
    if (!c.hasAuth) return null;
    try {
      return await c.getBalance();
    } catch {
      return null;
    }
  });

  ipcMain.handle("backtest:info", () => recordingInfo());
  ipcMain.handle("backtest:settlements", () => settlementInfo());
  ipcMain.handle("backtest:tape", () => tapeInfo());
  ipcMain.handle("backtest:spot", () => spotInfo());
  ipcMain.handle("backtest:depth", () => depthInfo());

  // The key is written here and never read back. `ai:status` returns a hint and
  // a flag; there is deliberately no handler that hands the renderer the key,
  // for the same reason the Kalshi vault has none.
  ipcMain.handle("ai:status", () => aiStatus());
  ipcMain.handle("ai:models", () => FREE_MODELS);
  ipcMain.handle("ai:save", (_e, apiKey: string, model: string) => {
    if (!looksLikeKey(apiKey)) {
      throw new Error("That does not look like an OpenRouter key — they start with sk-or-v1-.");
    }
    saveAi({ apiKey, model });
    return aiStatus();
  });
  ipcMain.handle("ai:clear", () => {
    clearAi();
    return aiStatus();
  });
  ipcMain.handle("ai:narrate", (_e, input: NarrationInput) => {
    // Shape-checked rather than trusted: this text is interpolated into a
    // prompt, and the renderer is the least trustworthy caller in the app.
    const evidence = Array.isArray(input?.evidence) ? input.evidence.slice(0, 40) : [];
    return narrate({
      subject: String(input?.subject ?? "these results").slice(0, 120),
      summary: String(input?.summary ?? "").slice(0, 4000),
      evidence: evidence.map((e) => ({
        label: String(e?.label ?? "").slice(0, 120),
        value: String(e?.value ?? "").slice(0, 240),
      })),
    });
  });
  ipcMain.handle("backtest:run", () => {
    const scans = loadRecording();
    if (scans.length < 10) {
      throw new Error(
        `Only ${scans.length} recorded scans so far. Leave the engine running for a while — ` +
          `a replay over a handful of sweeps says nothing.`,
      );
    }
    return compareStrategies(scans, loadSettings());
  });
  ipcMain.handle("backtest:clear", () => {
    clearRecording();
    // Outcomes and prints belong to the quotes they describe. Keeping either
    // after the recording is gone would leave rows nothing can be joined to.
    clearSettlements();
    clearTape();
    clearSpot();
    clearDepth();
    return recordingInfo();
  });

  let sweepRunning = false;
  ipcMain.handle("backtest:sweep", async () => {
    if (sweepRunning) throw new Error("A sweep is already running.");
    const scans = loadRecording();
    if (scans.length < 60) {
      throw new Error(
        `Only ${scans.length} recorded scans. A parameter search over less than a quarter ` +
          `of an hour of data would just rank noise.`,
      );
    }
    sweepRunning = true;
    try {
      // Sliced across event-loop turns inside runSweepAsync, so the app stays
      // responsive while nearly three hundred replays grind through.
      return await runSweepAsync(scans, loadSettings(), (done, total) =>
        sendToRenderer("sweep:progress", { done, total }),
      );
    } finally {
      sweepRunning = false;
    }
  });

  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:dataDir", () => dataDir());
  ipcMain.handle("app:openDataFolder", () => shell.openPath(dataDir()));
  ipcMain.handle("app:referral", () => referralUrl());
  ipcMain.handle("app:openReferral", () => {
    const url = referralUrl();
    // Built here rather than passed in from the renderer: a URL that arrives
    // over IPC is a URL an injected renderer can choose, and this one opens in
    // the user's real browser.
    if (!url) throw new Error("No referral code is configured.");
    return shell.openExternal(url);
  });
  ipcMain.handle("app:openMarket", (_e, ticker: string) => {
    // Only ever open Kalshi, and only for a ticker shaped like one.
    if (!/^[A-Z0-9._-]{1,64}$/i.test(ticker)) throw new Error("Refusing to open an odd ticker.");
    return shell.openExternal(`https://kalshi.com/markets/${encodeURIComponent(ticker)}`);
  });
  ipcMain.handle("app:resetTradingData", () => {
    // Stopping first so nothing is mid-position when the ledger disappears.
    engine.stop();
    resetTradingData();
    // The engine caches nothing from these files, but its in-memory halt has
    // to go too or the banner outlives the data that justified it.
    engine.clearHalt();
    return loadHistory();
  });

  ipcMain.handle("app:factoryReset", () => {
    engine.stop();
    factoryReset();
    clearCredentials(); // drops the in-memory copy too, not just the file
    engine.updateCredentials(loadCredentials());
    engine.updateSettings(loadSettings());
    return loadSettings();
  });

  ipcMain.handle("state:get", () => loadAppState());
  ipcMain.handle("state:set", (_e, patch: Partial<AppState>) => {
    const next = { ...loadAppState(), ...patch };
    saveAppState(next);
    if (patch.startWithWindows !== undefined && app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: next.startWithWindows });
    }
    return next;
  });

  ipcMain.on("window:minimize", () => win?.minimize());
  ipcMain.on("window:maximize", () => {
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.on("window:close", () => win?.close());
  ipcMain.handle("window:isMaximized", () => win?.isMaximized() ?? false);

  ipcMain.handle("update:get", () => getUpdateState());
  ipcMain.handle("update:check", () => checkForUpdates());
  ipcMain.handle("update:install", (_e, force: boolean) => installUpdate(force));
}

// A second launch should focus the running window rather than start a rival
// engine against the same settings and history files.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Launching again while hidden in the tray should bring the window back,
  // not appear to do nothing.
  app.on("second-instance", () => showWindow());

  app
    .whenReady()
    .then(() => {
      // Must run before anything reads settings: 1.1.1 and earlier kept the
      // signing key in settings.json as plain text.
      if (migrateLegacyCredentials()) {
        console.log("Moved Kalshi credentials into the encrypted store.");
      }

      engine = new TradingEngine(loadSettings(), loadCredentials());
      // Every live sweep is kept so strategies can be compared on real data
      // later instead of on argument.
      engine.setRecorder(keepScan);
      startPassiveRecorder();
      startSettlementSweeper();
      startTapeRecorder();
      startSpotRecorder();
      startDepthRecorder();
      engine.subscribe({
        onState: (s) => {
          sendToRenderer("engine:state", s);
          refreshTray();
        },
        onLog: (l) => sendToRenderer("engine:log", l),
        onEvent: (e) => notify(e),
      });

      // Seed one point so a fresh chart has a baseline instead of empty axes.
      if (loadEquity().length === 0) {
        appendEquity({ ts: Date.now(), equityUsd: loadSettings().dryRunCash });
      }

      registerIpc();
      createTray();
      createWindow();

      // The updater needs to know whether a restart would abandon a live
      // session, so give it a read-only view of the engine.
      initUpdater(
        () => win,
        () => {
          const s = engine.getState();
          return { running: s.status === "running", openPositions: s.positions.length };
        },
      );

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((e) => reportFatal(e, "startup"));
}

// Signing out or shutting down Windows must not be intercepted by close-to-tray.
let draining = false;
app.on("before-quit", (e) => {
  quitting = true;
  if (draining) return;
  const s = engine?.getState();
  const busy =
    s !== undefined &&
    (s.status === "running" || s.positions.length > 0 || s.pendingOrders.length > 0);
  if (!busy) return;
  // Stopping fires the closing sells and order cancels; give them a bounded
  // moment to actually leave the machine before the process dies under them.
  // In dry-run there is nothing in flight and this resolves immediately.
  e.preventDefault();
  draining = true;
  engine.stop();
  void engine.drainLiveOrders().then(() => app.quit());
});

app.on("window-all-closed", () => {
  engine?.stop();
  if (process.platform !== "darwin") app.quit();
});
