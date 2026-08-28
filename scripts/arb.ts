/**
 * Does the recording contain riskless trades?
 *
 * Everything measured so far has been about prediction: does a price move
 * predict the next price. The answer is that it does, faintly, by less than
 * the fee. This asks a different question that needs no prediction at all.
 *
 * A Kalshi ladder is a set of "above X" contracts on one underlying and one
 * expiry. Being above 78,600 is strictly more likely than being above 78,700,
 * so the lower strike must never be cheaper than the higher one. When it is,
 * a position of long YES(low) + long NO(high) pays 100 if the price lands
 * outside the band and 200 if it lands inside, for a cost of
 * ask(low) + 100 - bid(high). That cost is under 100 exactly when
 *
 *     ask(low) < bid(high)
 *
 * and the difference, less two taker fees, is money the market hands you for
 * noticing. No forecast, no holding period, no stop-loss.
 *
 * The sibling case is a band ladder — "between X and Y" contracts covering an
 * exhaustive set of outcomes. Exactly one settles at 100, so the asks must sum
 * to at least 100; if they sum to less, buying the whole set is riskless.
 *
 * Two things decide whether either is tradeable rather than merely present:
 * how often it appears, and whether it survives long enough to hit. A
 * violation visible in one 15-second scan and gone by the next cannot be
 * reached by a bot that polls every 15 seconds, so persistence is measured
 * rather than assumed.
 *
 *   npx esbuild scripts/arb.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/arb.js
 *   node scripts/arb.js [--in <scans.jsonl>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { takerFeeCentsPerContract } from "../electron/engine/fees";
import type { KalshiMarket } from "../electron/engine/kalshi";
import type { RecordedScan } from "../electron/engine/recorder";

function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}

function loadScans(file: string): RecordedScan[] {
  const out: RecordedScan[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const s = JSON.parse(line) as RecordedScan;
      if (Array.isArray(s.markets) && s.markets.length > 0) out.push(s);
    } catch {
      // torn final line
    }
  }
  return out;
}

/** KXBTCD-26AUG2621-T78899.99 -> event KXBTCD-26AUG2621, kind T, strike 78899.99 */
function parse(ticker: string): { event: string; kind: string; strike: number } | null {
  const i = ticker.lastIndexOf("-");
  if (i <= 0) return null;
  const event = ticker.slice(0, i);
  const tail = ticker.slice(i + 1);
  const m = tail.match(/^([A-Za-z]*)([\d.]+)$/);
  if (!m) return null;
  const strike = Number(m[2]);
  if (!Number.isFinite(strike)) return null;
  return { event, kind: m[1].toUpperCase(), strike };
}

interface Violation {
  ts: number;
  event: string;
  lowTicker: string;
  highTicker: string;
  /** bid(high) - ask(low), in cents. Positive means the books are crossed. */
  grossCents: number;
  netCents: number;
  contracts: number;
}

/** A trade only exists if both legs can be filled, so size is the thinner side. */
const ASSUMED_DEPTH = 10;

function main(): void {
  const file = argStr("in", path.join(process.env.APPDATA ?? ".", "ROM Trader", "scans.jsonl"));
  const scans = loadScans(file);

  console.log(`\n=== Riskless-trade scan: ${path.basename(file)} ===`);
  console.log(`  ${scans.length} scans\n`);

  const violations: Violation[] = [];
  const crossedBooks: { ts: number; ticker: string; bid: number; ask: number }[] = [];
  /** key -> consecutive scan indices it was seen in, to measure persistence. */
  const seen = new Map<string, number[]>();

  let ladderObs = 0;
  let laddersChecked = 0;
  let bandSetsChecked = 0;
  const bandGaps: number[] = [];

  scans.forEach((scan, scanIdx) => {
    // A book with no two-sided quote is not tradeable at all.
    const live = scan.markets.filter(
      (m: KalshiMarket) => m.yes_bid > 0 && m.yes_ask > 0 && m.yes_ask < 100 && m.status === "active",
    );

    // Crossed within a single market: ask below bid. Should be impossible.
    for (const m of live) {
      if (m.yes_ask < m.yes_bid) {
        crossedBooks.push({ ts: scan.ts, ticker: m.ticker, bid: m.yes_bid, ask: m.yes_ask });
      }
    }

    const byEvent = new Map<string, { m: KalshiMarket; strike: number; kind: string }[]>();
    for (const m of live) {
      const p = parse(m.ticker);
      if (!p) continue;
      const arr = byEvent.get(`${p.event}|${p.kind}`) ?? [];
      arr.push({ m, strike: p.strike, kind: p.kind });
      byEvent.set(`${p.event}|${p.kind}`, arr);
    }

    for (const [key, rows] of byEvent) {
      if (rows.length < 2) continue;
      rows.sort((a, b) => a.strike - b.strike);
      const kind = rows[0].kind;

      if (kind === "T") {
        // Threshold ladder: "above X". Lower strike is strictly more likely,
        // so its price must not be lower. Every pair is checked, not only
        // neighbours — the widest crossing is the most profitable one.
        laddersChecked++;
        for (let i = 0; i < rows.length; i++) {
          for (let j = i + 1; j < rows.length; j++) {
            ladderObs++;
            const low = rows[i].m;
            const high = rows[j].m;
            const gross = high.yes_bid - low.yes_ask;
            if (gross <= 0) continue;
            const fees =
              takerFeeCentsPerContract(low.yes_ask) + takerFeeCentsPerContract(100 - high.yes_bid);
            const net = gross - fees;
            const v: Violation = {
              ts: scan.ts,
              event: key,
              lowTicker: low.ticker,
              highTicker: high.ticker,
              grossCents: gross,
              netCents: Math.round(net * 100) / 100,
              contracts: ASSUMED_DEPTH,
            };
            violations.push(v);
            const k = `${low.ticker}|${high.ticker}`;
            const list = seen.get(k) ?? [];
            list.push(scanIdx);
            seen.set(k, list);
          }
        }
      } else if (kind === "B" && rows.length >= 3) {
        // Band ladder: exactly one settles at 100, so buying every band costs
        // at least 100 unless the market is mispriced.
        bandSetsChecked++;
        const askSum = rows.reduce((s, r) => s + r.m.yes_ask, 0);
        bandGaps.push(askSum);
      }
    }
  });

  // ---------------------------------------------------------------- report

  console.log(`  Threshold ladders: ${laddersChecked.toLocaleString()} ladder-scans, ` +
    `${ladderObs.toLocaleString()} strike pairs compared`);
  console.log(`  Crossed single books (ask < bid): ${crossedBooks.length}`);

  const profitable = violations.filter((v) => v.netCents > 0);
  console.log(`\n  Monotonicity violations found: ${violations.length}`);
  console.log(`  ...of which clear both taker fees: ${profitable.length}`);

  if (violations.length > 0) {
    const gross = violations.map((v) => v.grossCents).sort((a, b) => a - b);
    console.log(
      `  gross edge: median ${gross[Math.floor(gross.length / 2)]}c, ` +
        `max ${gross[gross.length - 1]}c`,
    );
  }

  if (profitable.length > 0) {
    const byPair = new Map<string, Violation[]>();
    for (const v of profitable) {
      const k = `${v.lowTicker}|${v.highTicker}`;
      byPair.set(k, [...(byPair.get(k) ?? []), v]);
    }

    // Persistence: how many consecutive scans a given crossing survived. One
    // scan means it was gone before a 15-second poller could act.
    const runs: number[] = [];
    for (const [, list] of byPair) {
      const idxs = [...new Set(list.map((v) => scans.findIndex((s) => s.ts === v.ts)))].sort((a, b) => a - b);
      let run = 1;
      for (let i = 1; i < idxs.length; i++) {
        if (idxs[i] === idxs[i - 1] + 1) run++;
        else {
          runs.push(run);
          run = 1;
        }
      }
      runs.push(run);
    }
    runs.sort((a, b) => a - b);

    const totalNet = profitable.reduce((s, v) => s + v.netCents * v.contracts, 0) / 100;
    console.log(
      `\n  distinct crossed pairs: ${byPair.size}` +
        `\n  net edge after fees: median ${median(profitable.map((v) => v.netCents)).toFixed(2)}c, ` +
        `max ${Math.max(...profitable.map((v) => v.netCents)).toFixed(2)}c`,
    );
    console.log(
      `  persistence: median ${runs[Math.floor(runs.length / 2)]} consecutive scans, ` +
        `max ${runs[runs.length - 1]} · ${((runs.filter((r) => r === 1).length / runs.length) * 100).toFixed(0)}% lasted one scan only`,
    );
    console.log(
      `  theoretical total at ${ASSUMED_DEPTH} contracts a leg: $${totalNet.toFixed(2)} ` +
        `over ${((scans[scans.length - 1].ts - scans[0].ts) / 3_600_000).toFixed(0)}h`,
    );

    console.log(`\n  Largest ten:`);
    for (const v of [...profitable].sort((a, b) => b.netCents - a.netCents).slice(0, 10)) {
      console.log(
        `    ${new Date(v.ts).toISOString().slice(5, 16).replace("T", " ")}  ` +
          `${v.netCents.toFixed(2)}c net  ${v.lowTicker.slice(-12)} vs ${v.highTicker.slice(-12)}`,
      );
    }
  }

  if (bandSetsChecked > 0) {
    bandGaps.sort((a, b) => a - b);
    const under = bandGaps.filter((s) => s < 100).length;
    console.log(
      `\n  Band ladders: ${bandSetsChecked.toLocaleString()} set-scans · ` +
        `ask sum median ${bandGaps[Math.floor(bandGaps.length / 2)].toFixed(0)}c, ` +
        `min ${bandGaps[0].toFixed(0)}c · ${under} sets priced under 100c`,
    );
    console.log(
      `    (a set summing under 100c is only riskless when the bands are exhaustive;\n` +
        `     these recordings hold the top-40 by volume, so a set is usually partial)`,
    );
  }

  console.log("");
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)];
}

main();
