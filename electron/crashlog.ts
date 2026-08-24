import { app, dialog } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Startup failures used to surface as Electron's bare "A JavaScript error
 * occurred in the main process" box, which names neither the cause nor a file
 * to send back. Everything here exists so a crash on someone else's machine
 * arrives as a readable message plus a log on disk.
 */

let reported = false;

function logPath(): string {
  // userData can itself be the thing that failed, so fall back to temp.
  try {
    const dir = app.getPath("userData");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "crash.log");
  } catch {
    return path.join(os.tmpdir(), "rom-trader-crash.log");
  }
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? `${err.name}: ${err.message}`;
  return String(err);
}

function writeEntry(err: unknown, origin: string): string {
  const file = logPath();
  const entry =
    // ASCII only: this file gets opened in whatever editor the reader has.
    `\n=== ${new Date().toISOString()} - ${origin} ===\n` +
    `ROM Trader ${app.getVersion()} | Electron ${process.versions.electron} | ` +
    `${os.platform()} ${os.release()} (${process.arch})\n` +
    `${describe(err)}\n`;
  try {
    fs.appendFileSync(file, entry);
  } catch {
    // disk is unwritable; whatever the caller shows is all we have left
  }
  return file;
}

export function reportFatal(err: unknown, origin: string): void {
  const file = writeEntry(err, origin);

  // Only the first failure is worth a dialog — cascading errors would stack boxes.
  if (reported) return;
  reported = true;

  dialog.showErrorBox(
    "ROM Trader hit a fatal error",
    `${describe(err)}\n\n` +
      `Details were written to:\n${file}\n\n` +
      `Send that file to whoever set this up and they can fix it.`,
  );
  app.exit(1);
}

/** Logged and survived — for failures that do not justify killing the app. */
export function reportBackground(err: unknown, origin: string): void {
  writeEntry(err, origin);
}

export function installCrashHandlers(): void {
  // An uncaught exception leaves the process in a state Node explicitly says
  // not to trust, so exiting is right — with an accurate dialog, not one that
  // claims a running app "failed to start".
  process.on("uncaughtException", (err) => reportFatal(err, "uncaughtException"));
  // A stray promise rejection is a bug worth a log line, not an execution.
  // Before 1.7.3 this path hard-exited the app: one missed .catch anywhere,
  // and a trading session died mid-position behind a startup-failure dialog.
  // Genuine startup failures still exit — the whenReady chain reports them
  // through reportFatal explicitly.
  process.on("unhandledRejection", (err) => reportBackground(err, "unhandledRejection"));
}
