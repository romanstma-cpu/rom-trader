import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import { installCrashHandlers, reportFatal } from "./crashlog";
import { TradingEngine } from "./engine/engine";
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
  saveAppState,
  saveProfile,
  saveSettings,
} from "./engine/store";

installCrashHandlers();

let win: BrowserWindow | null = null;
let engine: TradingEngine;

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

  const relay = () => win?.webContents.send("window:maximizeChange", win?.isMaximized() ?? false);
  win.on("maximize", relay);
  win.on("unmaximize", relay);

  const indexHtml = path.join(__dirname, "../dist/index.html");
  win.loadFile(indexHtml).catch((e) => {
    reportFatal(
      new Error(`Could not load the app UI from ${indexHtml}: ${(e as Error).message}`),
      "loadFile",
    );
  });
}

function registerIpc(): void {
  ipcMain.handle("engine:start", () => engine.start());
  ipcMain.handle("engine:stop", () => engine.stop());
  ipcMain.handle("engine:flatten", () => engine.flatten());
  ipcMain.handle("engine:getState", () => engine.getState());
  ipcMain.handle("engine:getLogs", () => engine.getLogs());
  ipcMain.handle("engine:getSignals", () => engine.getSignals());

  ipcMain.handle("settings:get", () => loadSettings());
  ipcMain.handle("settings:set", (_e, s: Settings) => {
    saveSettings(s);
    engine.updateSettings(loadSettings());
    return loadSettings();
  });

  ipcMain.handle("history:get", () => loadHistory());
  ipcMain.handle("history:clear", () => {
    clearHistory();
    clearEquity();
    return [];
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

  ipcMain.handle("kalshi:test", async () => {
    const s = loadSettings();
    return new KalshiClient(s.apiKeyId, s.apiPrivateKeyPem).testConnection();
  });
  ipcMain.handle("kalshi:balance", async () => {
    const s = loadSettings();
    const c = new KalshiClient(s.apiKeyId, s.apiPrivateKeyPem);
    if (!c.hasAuth) return null;
    try {
      return await c.getBalance();
    } catch {
      return null;
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
  ipcMain.handle("app:factoryReset", () => {
    engine.stop();
    factoryReset();
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
}

// A second launch should focus the running window rather than start a rival
// engine against the same settings and history files.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app
    .whenReady()
    .then(() => {
      engine = new TradingEngine(loadSettings());
      engine.subscribe({
        onState: (s) => win?.webContents.send("engine:state", s),
        onLog: (l) => win?.webContents.send("engine:log", l),
      });

      // Seed one point so a fresh chart has a baseline instead of empty axes.
      if (loadEquity().length === 0) {
        appendEquity({ ts: Date.now(), equityUsd: loadSettings().dryRunCash });
      }

      registerIpc();
      createWindow();

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
      });
    })
    .catch((e) => reportFatal(e, "startup"));
}

app.on("window-all-closed", () => {
  engine?.stop();
  if (process.platform !== "darwin") app.quit();
});
