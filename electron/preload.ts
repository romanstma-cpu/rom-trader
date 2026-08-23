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
    onState: (cb: (s: unknown) => void) => on("engine:state", cb),
    onLog: (cb: (l: unknown) => void) => on("engine:log", cb),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    set: (s: unknown) => ipcRenderer.invoke("settings:set", s),
  },
  history: {
    get: () => ipcRenderer.invoke("history:get"),
    clear: () => ipcRenderer.invoke("history:clear"),
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
  kalshi: {
    test: () => ipcRenderer.invoke("kalshi:test"),
    balance: () => ipcRenderer.invoke("kalshi:balance"),
  },
  app: {
    version: () => ipcRenderer.invoke("app:version"),
    dataDir: () => ipcRenderer.invoke("app:dataDir"),
    openDataFolder: () => ipcRenderer.invoke("app:openDataFolder"),
    openMarket: (ticker: string) => ipcRenderer.invoke("app:openMarket", ticker),
    factoryReset: () => ipcRenderer.invoke("app:factoryReset"),
  },
  state: {
    get: () => ipcRenderer.invoke("state:get"),
    set: (patch: unknown) => ipcRenderer.invoke("state:set", patch),
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

