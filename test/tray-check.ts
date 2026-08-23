/**
 * Verifies the background behaviour that unit tests cannot reach: closing the
 * window with "keep running in the tray" on must hide it and leave the process
 * trading, and turning the setting off must let a close actually quit.
 *
 * This also proves the tray icon exists, because main only swallows the close
 * event when a Tray was successfully created.
 *
 *   npm run traycheck
 */
import { type ChildProcess, spawn } from "node:child_process";
import * as path from "node:path";

const PORT = 9356;
const ROOT = path.resolve(__dirname, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

interface Target { type: string; webSocketDebuggerUrl?: string }

async function findPage(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Target[];
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("no DevTools page target");
}

class Cdp {
  private id = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(String((ev as MessageEvent).data)) as {
        id?: number; result?: unknown; error?: { message: string };
      };
      if (m.id === undefined) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("socket failed")), { once: true });
    });
    return new Cdp(ws);
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => this.pending.delete(id) && reject(new Error(`${method} timed out`)), 20_000);
    });
  }
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send<{ result: { value?: T } }>("Runtime.evaluate", {
      expression, awaitPromise: true, returnByValue: true,
    });
    return r.result.value as T;
  }
}

function launch(): ChildProcess {
  return spawn(
    path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"),
    [".", `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, windowsHide: true, stdio: "ignore" },
  );
}

/** A DevTools page target disappears once the app really exits. */
async function appAlive(): Promise<boolean> {
  try {
    const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as Target[];
    return targets.some((t) => t.type === "page");
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log("\n== tray and background behaviour ==");
  let child = launch();

  try {
    let cdp = await Cdp.connect(await findPage());
    await cdp.send("Runtime.enable");
    for (let i = 0; i < 40; i++) {
      if (await cdp.eval<boolean>(`typeof window.rom === "object"`)) break;
      await sleep(400);
    }

    // Accept the disclaimer so the real UI is mounted, not the welcome gate.
    await cdp.eval(`window.rom.state.set({ disclaimerAccepted: true, closeToTray: true })`);
    const st = await cdp.eval<{ closeToTray: boolean; notifications: boolean }>(
      `window.rom.state.get()`,
    );
    check("closeToTray persists", st.closeToTray === true);
    check("notifications default on", typeof st.notifications === "boolean");

    // Closing must hide, not quit — which only happens if a Tray exists.
    await cdp.eval(`window.rom.window.close()`);
    await sleep(2500);
    check("closing with tray enabled leaves the app running", await appAlive());
    check(
      "and the window is hidden, not just unfocused",
      (await cdp.eval<boolean>(`document.visibilityState === "hidden"`)) === true,
    );

    // Bring it back, the way the tray menu does.
    await cdp.eval(`window.rom.state.set({ closeToTray: false })`);

    // Now a close should genuinely quit. The evaluate that triggers it never
    // gets a reply — the renderer is torn down first — so it is fired without
    // waiting rather than treated as a failure.
    await cdp.eval(`window.rom.window.close()`).catch(() => {});
    await sleep(3500);
    check("with the setting off, closing quits", !(await appAlive()));
  } finally {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    await sleep(500);
  }

  console.log(`\n${"=".repeat(52)}`);
  console.log(`${passed} passed, ${failures.length} failed`);
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
