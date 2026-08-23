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

export function reportFatal(err: unknown, origin: string): void {
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
    // disk is unwritable; the dialog below is all we have left
  }

  // Only the first failure is worth a dialog — cascading errors would stack boxes.
  if (reported) return;
  reported = true;

  dialog.showErrorBox(
    "ROM Trader failed to start",
    `${describe(err)}\n\n` +
      `Details were written to:\n${file}\n\n` +
      `Send that file to whoever set this up and they can fix it.`,
  );
  app.exit(1);
}

export function installCrashHandlers(): void {
  process.on("uncaughtException", (err) => reportFatal(err, "uncaughtException"));
  process.on("unhandledRejection", (err) => reportFatal(err, "unhandledRejection"));
}
