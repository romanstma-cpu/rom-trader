/**
 * Collect the outcomes of markets the sweeper never knew about.
 *
 * The settlement sweeper only asks about markets it has SEEN — `noteMarkets`
 * adds a ticker to the pending map when a scan observes it, and the sweeper
 * works that map. Everything scanned before the sweeper existed is invisible
 * to it, permanently. That turns out to be almost everything: the archive
 * holds 4,732 distinct markets, 4,612 of them closed, and 3,788 of those have
 * never once been asked about.
 *
 * Which is why the fair-value study kept reporting a 99.9% exclusion rate and
 * a sample of twenty events. Not because outcomes were slow to arrive — because
 * nobody had asked. Each answer is one public GET against a documented budget
 * of two hundred reads a second, and they have all been sitting there settled
 * for days.
 *
 * Written to its own file rather than appended to `settlements.jsonl`, because
 * the app is usually running and appending to that file at the same time. Two
 * processes writing one log is a torn line waiting to happen, and the loader
 * reads both files anyway.
 *
 *   npx esbuild scripts/backfill.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/backfill.js
 *   node --max-old-space-size=4096 scripts/backfill.js [--limit 4000] [--rps 8]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { KalshiClient, type KalshiMarket } from "../electron/engine/kalshi";
import type { RecordedScan } from "../electron/engine/recorder";
import { BACKFILL_FILE, isSettled, type Settlement } from "../electron/engine/settlements";

const argNum = (name: string, fallback: number): number => {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : fallback;
};

const GRACE_MS = 5 * 60_000;

function dir(): string {
  return path.join(process.env.APPDATA ?? ".", "ROM Trader");
}

/** Every ticker the recorder has ever seen, with the close time it reported. */
function seenTickers(): Map<string, number> {
  const out = new Map<string, number>();
  const files = fs
    .readdirSync(dir())
    .filter((f) => f === "scans.jsonl" || /^scans-archive-.*\.jsonl$/.test(f));
  for (const f of files) {
    const data = fs.readFileSync(path.join(dir(), f), "utf-8");
    for (const line of data.split("\n")) {
      if (!line.trim()) continue;
      let scan: RecordedScan;
      try {
        scan = JSON.parse(line) as RecordedScan;
      } catch {
        continue;
      }
      if (!Array.isArray(scan.markets)) continue;
      for (const m of scan.markets as KalshiMarket[]) {
        if (!m.ticker || !m.close_ts || m.close_ts <= 0) continue;
        if (!out.has(m.ticker)) out.set(m.ticker, m.close_ts);
      }
    }
  }
  return out;
}

/** Tickers whose result is already on disk, from either settlement file. */
function alreadyKnown(): Set<string> {
  const known = new Set<string>();
  for (const name of ["settlements.jsonl", BACKFILL_FILE]) {
    const p = path.join(dir(), name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        known.add((JSON.parse(line) as Settlement).ticker);
      } catch {
        // torn line
      }
    }
  }
  return known;
}

async function main(): Promise<void> {
  const limit = argNum("limit", 5000);
  const rps = Math.max(1, argNum("rps", 8));
  const out = path.join(dir(), BACKFILL_FILE);

  const seen = seenTickers();
  const known = alreadyKnown();
  const now = Date.now();

  const todo = [...seen.entries()]
    .filter(([t, closeTs]) => !known.has(t) && closeTs * 1000 + GRACE_MS < now)
    // Oldest close first: those are the most certainly resolved, so an
    // interrupted run leaves behind the most usable sample rather than a
    // scattering of maybes.
    .sort((a, b) => a[1] - b[1])
    .slice(0, limit);

  console.log(`\n=== Settlement backfill ===`);
  console.log(`  markets ever recorded   ${seen.size.toLocaleString()}`);
  console.log(`  outcomes already known  ${known.size.toLocaleString()}`);
  console.log(`  closed and unanswered   ${todo.length.toLocaleString()}`);
  console.log(`  rate                    ${rps}/s → about ${Math.ceil(todo.length / rps / 60)} min\n`);

  if (todo.length === 0) {
    console.log(`  Nothing to ask about.\n`);
    return;
  }

  const client = new KalshiClient();
  const gap = 1000 / rps;
  let resolved = 0;
  let open = 0;
  let failed = 0;
  const buffer: string[] = [];

  const flush = (): void => {
    if (buffer.length === 0) return;
    fs.appendFileSync(out, buffer.join(""), "utf-8");
    buffer.length = 0;
  };

  for (let i = 0; i < todo.length; i++) {
    const [ticker, closeTs] = todo[i];
    const started = Date.now();
    try {
      const { result } = await client.getMarket(ticker);
      if (isSettled(result)) {
        const row: Settlement = { ticker, closeTs, result: result.trim(), ts: Date.now() };
        buffer.push(JSON.stringify(row) + "\n");
        resolved++;
      } else {
        open++;
      }
    } catch {
      // A 404 means the ticker is gone; a 5xx means Kalshi is unhappy. Neither
      // is worth retrying here — the sweeper will pick up anything that starts
      // answering later, and a stalled backfill helps nobody.
      failed++;
    }

    // Flushed in batches so an interrupt costs at most a few lookups, without
    // paying a filesystem sync per market.
    if (buffer.length >= 50) flush();
    if ((i + 1) % 250 === 0 || i === todo.length - 1) {
      flush();
      const pct = (((i + 1) / todo.length) * 100).toFixed(0);
      console.log(
        `  ${String(i + 1).padStart(5)}/${todo.length} (${pct.padStart(3)}%)  ` +
          `settled ${resolved}  still open ${open}  failed ${failed}`,
      );
    }

    const elapsed = Date.now() - started;
    if (elapsed < gap) await new Promise((r) => setTimeout(r, gap - elapsed));
  }

  flush();
  console.log(
    `\n  Wrote ${resolved.toLocaleString()} outcomes to ${BACKFILL_FILE}.\n` +
      `  ${open.toLocaleString()} were still open, ${failed.toLocaleString()} could not be reached.\n`,
  );
}

void main();
