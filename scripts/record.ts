/**
 * Headless market recorder.
 *
 * Polls Kalshi's public market endpoint at the app's cadence and appends the
 * same slim scans.jsonl the running engine would write — by default straight
 * into the installed app's data folder, so the Backtest page inside the app
 * can replay what this collected. Public data only; nothing here can place an
 * order, and no credentials are read.
 *
 *   npx esbuild scripts/record.ts --bundle --platform=node --outfile=scripts/record.js
 *   node scripts/record.js --minutes 90 --interval 15
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { KalshiClient, type KalshiMarket } from "../electron/engine/kalshi";

function arg(name: string, fallback: number): number {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) return fallback;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}

/** Only the fields the engine reads — must match recorder.ts slim(). */
function slim(m: KalshiMarket): Partial<KalshiMarket> {
  return {
    ticker: m.ticker,
    title: m.title,
    yes_bid: m.yes_bid,
    yes_ask: m.yes_ask,
    volume: m.volume,
    status: m.status,
  };
}

async function main(): Promise<void> {
  const minutes = arg("minutes", 90);
  const intervalS = arg("interval", 15);
  const out = argStr(
    "out",
    path.join(process.env.APPDATA ?? ".", "ROM Trader", "scans.jsonl"),
  );

  fs.mkdirSync(path.dirname(out), { recursive: true });
  const client = new KalshiClient();
  const deadline = Date.now() + minutes * 60_000;
  let scans = 0;
  let failures = 0;

  console.log(`Recording to ${out}`);
  console.log(`${minutes} minutes at one scan every ${intervalS}s\n`);

  while (Date.now() < deadline) {
    const began = Date.now();
    try {
      const markets = await client.getActiveMarkets(40);
      if (markets.length > 0) {
        fs.appendFileSync(
          out,
          JSON.stringify({ ts: Date.now(), markets: markets.map(slim) }) + "\n",
          "utf-8",
        );
        scans += 1;
        const spreads = markets.map((m) => m.yes_ask - m.yes_bid).sort((a, b) => a - b);
        const median = spreads[Math.floor(spreads.length / 2)];
        console.log(
          `scan ${scans} — ${markets.length} markets, median spread ${median}c, ` +
            `${new Date().toISOString()}`,
        );
      } else {
        console.log(`scan skipped — no active markets returned`);
      }
    } catch (e) {
      failures += 1;
      console.log(`scan failed: ${(e as Error).message}`);
      // A run of failures means the API or the network is down; stop burning
      // time rather than record a file full of gaps.
      if (failures >= 20) {
        console.log("Twenty failures — giving up.");
        break;
      }
    }
    const elapsed = Date.now() - began;
    const wait = Math.max(0, intervalS * 1000 - elapsed);
    if (Date.now() + wait >= deadline) break;
    await new Promise((r) => setTimeout(r, wait));
  }

  console.log(`\nDone: ${scans} scans recorded, ${failures} failures.`);
}

void main();
