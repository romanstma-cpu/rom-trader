import { app, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";

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

/** Six hours; a trading session can run all day without a restart. */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 8_000;

let state: UpdateState = {
  status: "idle",
  currentVersion: "0.0.0",
  newVersion: null,
  percent: 0,
  message: null,
  checkedAt: null,
};

let getWindow: () => BrowserWindow | null = () => null;
/** Set by main so the updater can refuse to restart mid-trade. */
let engineBusy: () => { running: boolean; openPositions: number } = () => ({
  running: false,
  openPositions: 0,
});

function publish(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  getWindow()?.webContents.send("update:state", state);
}

export function getUpdateState(): UpdateState {
  return state;
}

export function initUpdater(
  window: () => BrowserWindow | null,
  busy: () => { running: boolean; openPositions: number },
): void {
  getWindow = window;
  engineBusy = busy;
  state.currentVersion = app.getVersion();

  // electron-updater cannot resolve a feed from an unpackaged tree, and
  // throwing there would just noise up development.
  if (!app.isPackaged) {
    state.status = "unsupported";
    state.message = "Updates are only checked in an installed build.";
    return;
  }

  autoUpdater.autoDownload = true;
  // The engine may be holding positions. Never install behind the user's back
  // on quit — installing is an explicit action, guarded below.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = null;

  autoUpdater.on("checking-for-update", () => publish({ status: "checking", message: null }));

  autoUpdater.on("update-not-available", () =>
    publish({
      status: "current",
      newVersion: null,
      percent: 0,
      message: "You're on the latest version.",
      checkedAt: Date.now(),
    }),
  );

  autoUpdater.on("update-available", (info) =>
    publish({
      status: "available",
      newVersion: info.version,
      percent: 0,
      message: `Version ${info.version} is available. Downloading…`,
      checkedAt: Date.now(),
    }),
  );

  autoUpdater.on("download-progress", (p) =>
    publish({ status: "downloading", percent: Math.round(p.percent) }),
  );

  autoUpdater.on("update-downloaded", (info) =>
    publish({
      status: "ready",
      newVersion: info.version,
      percent: 100,
      message: `Version ${info.version} is ready to install.`,
    }),
  );

  autoUpdater.on("error", (err) =>
    publish({
      status: "error",
      message: `Update check failed: ${err?.message ?? String(err)}`,
      checkedAt: Date.now(),
    }),
  );

  setTimeout(() => void checkForUpdates(), FIRST_CHECK_DELAY_MS);
  setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);
}

export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) return state;
  // Don't re-check over an update that is already downloading or staged.
  if (state.status === "downloading" || state.status === "ready") return state;
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    publish({ status: "error", message: (e as Error).message, checkedAt: Date.now() });
  }
  return state;
}

export interface InstallRefusal {
  installed: false;
  reason: string;
}

/**
 * Installing restarts the app. If the engine is mid-session the caller is told
 * why it was refused rather than having positions abandoned under it; `force`
 * is the user answering that prompt.
 */
export function installUpdate(force = false): InstallRefusal | never {
  if (state.status !== "ready") {
    return { installed: false, reason: "No downloaded update is waiting to be installed." };
  }

  const { running, openPositions } = engineBusy();
  if (!force && (running || openPositions > 0)) {
    const bits: string[] = [];
    if (running) bits.push("the engine is running");
    if (openPositions > 0) {
      bits.push(`${openPositions} position${openPositions === 1 ? " is" : "s are"} still open`);
    }
    return {
      installed: false,
      reason:
        `Installing restarts ROM Trader, and ${bits.join(" and ")}. ` +
        `Stop the engine first so open positions are closed and recorded.`,
    };
  }

  // Silent: the user already agreed in-app, so making them click through the
  // NSIS wizard again is just friction. isForceRunAfter reopens the new build.
  autoUpdater.quitAndInstall(true, true);
  throw new Error("unreachable: quitAndInstall does not return");
}
