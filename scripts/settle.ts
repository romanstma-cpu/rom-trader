/**
 * Are Kalshi's prices honest probabilities?
 *
 * Every strategy measured so far trades the path: buy, wait for a move, take a
 * profit or a stop. Each of those legs pays a fee, and the fee is larger than
 * the edge. This asks whether the destination is mispriced instead.
 *
 * A contract quoted at 67c is the market saying "67% likely". If that is
 * accurate, buying and holding to settlement has an expected value of zero
 * before costs. Betting markets are famously not accurate in one specific
 * way — the favourite-longshot bias, where longshots are overbet and
 * favourites underbet — and if that bias exists on Kalshi it would show up as
 * contracts in the 60-75c band settling YES more than 60-75% of the time.
 *
 * That matters because a hold-to-settlement trade has no exit leg. On the
 * entry side a resting bid pays no fee either. A strategy with no exit fee and
 * no entry fee does not need to beat 1.75 cents a side; it only needs the
 * price to be wrong.
 *
 * OUTCOMES ARE INFERRED, and that is the weakness of this script. The
 * recording holds quotes, not settlements. A market whose last observed quote
 * sits at or above 95c almost certainly settled YES and one at or below 5c
 * almost certainly settled NO, but a market that simply fell off the top-40
 * volume table while trading at 60c reveals nothing and is discarded. Discards
 * are counted and reported, because a sample that keeps only the markets that
 * resolved loudly is a biased sample and the size of that bias is the first
 * thing a reader should see.
 *
 *   npx esbuild scripts/settle.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/settle.js
 *   node scripts/settle.js [--in <scans.jsonl>]
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

/** Confidence that a final quote reveals the settlement. */
const SETTLED_YES = 95;
const SETTLED_NO = 5;

interface Track {
  ticker: string;
  first: { ts: number; bid: number; ask: number; closeTs: number };
  last: { ts: number; bid: number; ask: number };
  /** Best quote seen at least 30 minutes before close, for an entry price. */
  entry: { ts: number; bid: number; ask: number } | null;
}

function main(): void {
  const file = argStr("in", path.join(process.env.APPDATA ?? ".", "ROM Trader", "scans.jsonl"));
  const minMinutes = Number(argStr("mins", "30"));
  const scans = loadScans(file);

  const tracks = new Map<string, Track>();
  for (const scan of scans) {
    for (const m of scan.markets as KalshiMarket[]) {
      if (m.yes_bid <= 0 || m.yes_ask <= 0 || m.yes_ask >= 100) {
        // Still worth recording as a final state: a market pinned at 0/100 is
        // exactly the resolution this script is looking for.
        const t0 = tracks.get(m.ticker);
        if (t0) t0.last = { ts: scan.ts, bid: m.yes_bid, ask: m.yes_ask };
        continue;
      }
      let t = tracks.get(m.ticker);
      if (!t) {
        t = {
          ticker: m.ticker,
          first: { ts: scan.ts, bid: m.yes_bid, ask: m.yes_ask, closeTs: m.close_ts ?? 0 },
          last: { ts: scan.ts, bid: m.yes_bid, ask: m.yes_ask },
          entry: null,
        };
        tracks.set(m.ticker, t);
      }
      t.last = { ts: scan.ts, bid: m.yes_bid, ask: m.yes_ask };
      // The last quote comfortably before the close is the one a
      // hold-to-settlement strategy would actually be able to buy at.
      const minsLeft = t.first.closeTs > 0 ? (t.first.closeTs * 1000 - scan.ts) / 60_000 : Infinity;
      if (minsLeft >= minMinutes) t.entry = { ts: scan.ts, bid: m.yes_bid, ask: m.yes_ask };
    }
  }

  const BANDS: [number, number][] = [
    [1, 10], [10, 20], [20, 30], [30, 40], [40, 50],
    [50, 60], [60, 70], [70, 80], [80, 90], [90, 99],
  ];
  const rows = BANDS.map(([lo, hi]) => ({
    lo, hi, yes: 0, no: 0, unresolved: 0, sumEntry: 0,
  }));

  let noClose = 0;
  for (const t of tracks.values()) {
    if (!t.entry) continue;
    if (t.first.closeTs <= 0) {
      noClose++;
      continue;
    }
    const px = t.entry.ask; // what a buyer actually pays
    const band = rows.find((r) => px >= r.lo && px < r.hi);
    if (!band) continue;
    band.sumEntry += px;
    if (t.last.bid >= SETTLED_YES || t.last.ask >= SETTLED_YES) band.yes++;
    else if (t.last.ask <= SETTLED_NO || t.last.bid <= SETTLED_NO) band.no++;
    else band.unresolved++;
  }

  console.log(`\n=== Is the price the probability? ${path.basename(file)} ===`);
  console.log(
    `  ${scans.length.toLocaleString()} scans · ${tracks.size.toLocaleString()} distinct markets · ` +
      `entry taken at the last quote at least ${minMinutes} minutes before close\n`,
  );
  console.log(
    `  ${"price band".padEnd(12)} ${"resolved".padStart(9)} ${"unresolved".padStart(11)} ` +
      `${"settled YES".padStart(12)} ${"paid".padStart(7)} ${"edge".padStart(8)} ${"net/contract".padStart(13)}`,
  );
  console.log(
    `  ${"-".repeat(12)} ${"-".repeat(9)} ${"-".repeat(11)} ${"-".repeat(12)} ${"-".repeat(7)} ${"-".repeat(8)} ${"-".repeat(13)}`,
  );

  let totalResolved = 0;
  let totalUnresolved = 0;
  for (const r of rows) {
    const resolved = r.yes + r.no;
    totalResolved += resolved;
    totalUnresolved += r.unresolved;
    if (resolved < 10) continue;
    const rate = r.yes / resolved;
    const paid = r.sumEntry / (resolved + r.unresolved);
    // A maker entry pays no fee; settlement pays none either. The taker case
    // is shown as the conservative reading.
    const edge = rate * 100 - paid;
    const net = edge - takerFeeCentsPerContract(paid);
    const se = Math.sqrt((rate * (1 - rate)) / resolved) * 100;
    console.log(
      `  ${`${r.lo}-${r.hi}c`.padEnd(12)} ${String(resolved).padStart(9)} ${String(r.unresolved).padStart(11)} ` +
        `${`${(rate * 100).toFixed(1)}% ±${se.toFixed(1)}`.padStart(12)} ${`${paid.toFixed(1)}c`.padStart(7)} ` +
        `${`${edge >= 0 ? "+" : ""}${edge.toFixed(1)}c`.padStart(8)} ${`${net >= 0 ? "+" : ""}${net.toFixed(1)}c`.padStart(13)}`,
    );
  }

  console.log(
    `\n  ${totalResolved.toLocaleString()} markets resolved loudly enough to read; ` +
      `${totalUnresolved.toLocaleString()} did not and are excluded (${((totalUnresolved / (totalResolved + totalUnresolved)) * 100).toFixed(0)}%).`,
  );
  console.log(`  ${noClose} markets had no close time recorded and were skipped.`);
  console.log(
    `\n  'edge' is settlement rate minus the price paid: positive means the band was\n` +
      `  underpriced. 'net' subtracts one taker fee; a resting bid would pay none, and\n` +
      `  settlement itself is not charged. A band whose edge is inside its own standard\n` +
      `  error is not evidence of anything.\n`,
  );

  // The exclusion is the thing most likely to be lying, so characterise it.
  const drift = [...tracks.values()].filter((t) => t.entry && t.first.closeTs > 0);
  const excluded = drift.filter(
    (t) => t.last.bid < SETTLED_YES && t.last.ask > SETTLED_NO && t.last.ask < SETTLED_YES,
  );
  if (excluded.length > 0) {
    const px = excluded.map((t) => t.entry!.ask).sort((a, b) => a - b);
    console.log(
      `  Excluded markets were quoted at a median of ${px[Math.floor(px.length / 2)]}c at entry — ` +
        `if that\n  is far from the middle of the price range, the surviving sample is skewed.\n`,
    );
  }
}

main();
