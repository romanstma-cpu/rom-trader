import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]) => cb(args[0] as T);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  engine: {
    start: () => ipcRenderer.invoke("engine:start"),
    stop: () => ipcRenderer.invoke("engine:stop"),
    flatten: () => ipcRenderer.invoke("engine:flatten"),
    getState: () => ipcRenderer.invoke("engine:getState"),
    getLogs: () => ipcRenderer.invoke("engine:getLogs"),
    getSignals: () => ipcRenderer.invoke("engine:getSignals"),
    clearHalt: () => ipcRenderer.invoke("engine:clearHalt"),
    onState: (cb: (s: unknown) => void) => on("engine:state", cb),
    onLog: (cb: (l: unknown) => void) => on("engine:log", cb),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (s: unknown) => ipcRenderer.invoke("settings:set", s),
  },
  history: {
    get: () => ipcRenderer.invoke("history:get"),
    clear: (mode?: "all" | "paper" | "live") => ipcRenderer.invoke("history:clear", mode ?? "all"),
    export: () => ipcRenderer.invoke("history:export"),
  },
  equity: {
    get: () => ipcRenderer.invoke("equity:get"),
  },
  strategies: {
    list: () => ipcRenderer.invoke("strategies:list"),
    apply: (id: string) => ipcRenderer.invoke("strategies:apply", id),
  },
  profiles: {
    list: () => ipcRenderer.invoke("profiles:list"),
    save: (name: string) => ipcRenderer.invoke("profiles:save", name),
    apply: (name: string) => ipcRenderer.invoke("profiles:apply", name),
    delete: (name: string) => ipcRenderer.invoke("profiles:delete", name),
  },
  // Write-only by design: there is no getter for the private key.
  credentials: {
    status: () => ipcRenderer.invoke("credentials:status"),
    set: (c: unknown) => ipcRenderer.invoke("credentials:set", c),
    clear: () => ipcRenderer.invoke("credentials:clear"),
  },
  kalshi: {
    test: () => ipcRenderer.invoke("kalshi:test"),
    balance: () => ipcRenderer.invoke("kalshi:balance"),
  },
  backtest: {
    info: () => ipcRenderer.invoke("backtest:info"),
    settlements: () => ipcRenderer.invoke("backtest:settlements"),
    tape: () => ipcRenderer.invoke("backtest:tape"),
    run: () => ipcRenderer.invoke("backtest:run"),
    clear: () => ipcRenderer.invoke("backtest:clear"),
    sweep: () => ipcRenderer.invoke("backtest:sweep"),
    onSweepProgress: (cb: (p: unknown) => void) => on("sweep:progress", cb),
  },
  ai: {
    status: () => ipcRenderer.invoke("ai:status"),
    models: () => ipcRenderer.invoke("ai:models"),
    save: (apiKey: string, model: string) => ipcRenderer.invoke("ai:save", apiKey, model),
    clear: () => ipcRenderer.invoke("ai:clear"),
    narrate: (input: unknown) => ipcRenderer.invoke("ai:narrate", input),
  },
  app: {
    version: () => ipcRenderer.invoke("app:version"),
    dataDir: () => ipcRenderer.invoke("app:dataDir"),
    openDataFolder: () => ipcRenderer.invoke("app:openDataFolder"),
    openMarket: (ticker: string) => ipcRenderer.invoke("app:openMarket", ticker),
    referral: () => ipcRenderer.invoke("app:referral"),
    openReferral: () => ipcRenderer.invoke("app:openReferral"),
    resetTradingData: () => ipcRenderer.invoke("app:resetTradingData"),
    factoryReset: () => ipcRenderer.invoke("app:factoryReset"),
  },
  state: {
    get: () => ipcRenderer.invoke("state:get"),
    set: (patch: unknown) => ipcRenderer.invoke("state:set", patch),
  },
  update: {
    get: () => ipcRenderer.invoke("update:get"),
    check: () => ipcRenderer.invoke("update:check"),
    install: (force: boolean) => ipcRenderer.invoke("update:install", force),
    onState: (cb: (s: unknown) => void) => on("update:state", cb),
  },
  window: {
    minimize: () => ipcRenderer.send("window:minimize"),
    maximize: () => ipcRenderer.send("window:maximize"),
    close: () => ipcRenderer.send("window:close"),
    isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
    onMaximizeChange: (cb: (v: unknown) => void) => on("window:maximizeChange", cb),
  },
};

contextBridge.exposeInMainWorld("rom", api);

export type RomApi = typeof api;

