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
import { KalshiClient } from "./engine/kalshi";
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
      .then((markets) => recordScan(markets))
      .catch(() => {
        // Offline or rate-limited: skip this sweep, try again next interval.
      })
      .finally(() => {
        sweeping = false;
      });
  }, 30_000);
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
      engine.setRecorder(recordScan);
      startPassiveRecorder();
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
app.on("before-quit", () => {
  quitting = true;
});

app.on("window-all-closed", () => {
  engine?.stop();
  if (process.platform !== "darwin") app.quit();
});
