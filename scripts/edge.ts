/**
 * Does the momentum trigger predict anything?
 *
 * replay.ts answers "what would these settings have done" and the answer is
 * always a loss. That is a fact about the settings. This asks the question
 * underneath it, which no amount of parameter tuning can reach: on real Kalshi
 * books, after the bid climbs, does it keep climbing?
 *
 * The engine buys YES at the ask and marks it at the bid, so the honest unit
 * is the barrier race a real position runs: from an entry at the ask, does the
 * bid reach entry + takeProfit before it reaches entry - stopLoss? That is the
 * number the win rate in the backtest is made of, measured here without any
 * position sizing, brakes, cooldowns or ladder caps in the way.
 *
 * The same race is measured for the opposite trade — buying NO after a YES
 * climb, which is the fade — because a signal that loses reliably is worth as
 * much as one that wins, and the engine currently cannot express it.
 *
 *   npx esbuild scripts/edge.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/edge.js
 *   node scripts/edge.js [--in <path to scans.jsonl>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { TradingEngine } from "../electron/engine/engine";
import type { KalshiMarket } from "../electron/engine/kalshi";
import {
  roundTripFeeCentsPerContract,
  takerFeeCentsPerContract,
} from "../electron/engine/fees";
import { segmentScans } from "../electron/engine/recorder";

/** Mirrors TradingEngine.LOOKBACK, which is private. */
const LOOKBACK = 3;
/** Mirrors MIN_REGIME_SAMPLES: how long a market is watched before it is judged. */
const MIN_SAMPLES = 9;

interface Scan {
  ts: number;
  markets: KalshiMarket[];
}

interface Sample {
  ts: number;
  bid: number;
  ask: number;
  volume: number;
  closeTs: number;
}

function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}

function loadScans(file: string): Scan[] {
  const out: Scan[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const s = JSON.parse(line) as Scan;
      if (Array.isArray(s.markets) && s.markets.length > 0) out.push(s);
    } catch {
      // half-written final line
    }
  }
  return out;
}

/**
 * Per-ticker runs of consecutive observations.
 *
 * A market drops out of the sweep whenever it falls off the top-40 volume
 * table and comes back later. Treating that as one continuous series would
 * measure a momentum move across a hole in time, which is the same mistake
 * segmentScans exists to prevent at the scan level.
 */
function runs(seg: Scan[]): Map<string, Sample[][]> {
  const lastIndex = new Map<string, number>();
  const out = new Map<string, Sample[][]>();

  seg.forEach((scan, i) => {
    for (const m of scan.markets) {
      const sample: Sample = {
        ts: scan.ts,
        bid: m.yes_bid,
        ask: m.yes_ask,
        volume: m.volume ?? 0,
        closeTs: m.close_ts ?? 0,
      };
      const chains = out.get(m.ticker) ?? [];
      const prev = lastIndex.get(m.ticker);
      if (prev === i - 1 && chains.length > 0) chains[chains.length - 1].push(sample);
      else chains.push([sample]);
      out.set(m.ticker, chains);
      lastIndex.set(m.ticker, i);
    }
  });

  return out;
}

type Outcome = "win" | "loss" | "neither";

/**
 * The barrier race for a YES long: entered at the ask, marked at the bid.
 *
 * Both barriers inside one scan counts as a loss. The engine checks its stop
 * before its target for the same reason — between two 15-second samples there
 * is no way to know which came first, and assuming the good one is how a
 * backtest invents money.
 */
function raceYes(s: Sample[], i: number, tp: number, sl: number, maxAhead: number): Outcome {
  const entry = s[i].ask;
  for (let j = i + 1; j < Math.min(s.length, i + 1 + maxAhead); j++) {
    if (s[j].bid <= entry - sl) return "loss";
    if (s[j].bid >= entry + tp) return "win";
  }
  return "neither";
}

/**
 * The same race for a NO long, quoted from the YES book: buying NO costs
 * 100 - yes_bid and is marked at 100 - yes_ask. This is the trade the engine
 * cannot currently place, so measuring it is the only way to know what it is
 * leaving on the table.
 */
function raceNo(s: Sample[], i: number, tp: number, sl: number, maxAhead: number): Outcome {
  const entry = 100 - s[i].bid;
  for (let j = i + 1; j < Math.min(s.length, i + 1 + maxAhead); j++) {
    const mark = 100 - s[j].ask;
    if (mark <= entry - sl) return "loss";
    if (mark >= entry + tp) return "win";
  }
  return "neither";
}

/**
 * The maker race: filled at the bid rather than the ask, and marked at the bid
 * throughout. This is the same signal with the spread removed from the entry,
 * and it is a different race, not a discount on the same one — a taker starts
 * the spread underwater, so it needs `tp + spread` to win and only
 * `sl - spread` to lose. At a 3c spread and a 12c barrier that is 15c up
 * against 9c down before the signal says anything at all.
 *
 * The fill is assumed, deliberately. Whether a resting bid actually gets hit
 * is the engine's job to model and replay.ts already measures it; the question
 * here is what the signal is worth to an order that does fill.
 */
function raceMaker(s: Sample[], i: number, tp: number, sl: number, maxAhead: number): Outcome {
  const entry = s[i].bid;
  for (let j = i + 1; j < Math.min(s.length, i + 1 + maxAhead); j++) {
    if (s[j].bid <= entry - sl) return "loss";
    if (s[j].bid >= entry + tp) return "win";
  }
  return "neither";
}

interface Bucket {
  n: number;
  yesWin: number;
  yesLoss: number;
  yesNeither: number;
  noWin: number;
  noLoss: number;
  noNeither: number;
  makerWin: number;
  makerLoss: number;
  fwdBid: number[];
  spreads: number[];
}

function emptyBucket(): Bucket {
  return {
    n: 0,
    yesWin: 0,
    yesLoss: 0,
    yesNeither: 0,
    noWin: 0,
    noLoss: 0,
    noNeither: 0,
    makerWin: 0,
    makerLoss: 0,
    fwdBid: [],
    spreads: [],
  };
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Standard error of a proportion, for deciding whether a gap from 50% is real. */
function seProp(p: number, n: number): number {
  return n === 0 ? 0 : Math.sqrt((p * (1 - p)) / n);
}

function rate(win: number, loss: number): { p: number; n: number } {
  const n = win + loss;
  return { p: n === 0 ? 0 : win / n, n };
}

function pct(p: number): string {
  return `${(p * 100).toFixed(1)}%`;
}

interface Row {
  label: string;
  bucket: Bucket;
}

/** The share of decided races a config must win to break even, after fees. */
function breakEven(tp: number, sl: number, maker: boolean): number {
  const fee = maker ? takerFeeCentsPerContract(50) : roundTripFeeCentsPerContract(50);
  return (sl + fee) / (tp - fee + sl + fee);
}

function report(title: string, rows: Row[], tp: number, sl: number): void {
  const beTaker = breakEven(tp, sl, false);
  const beMaker = breakEven(tp, sl, true);
  console.log(`\n  ${title}`);
  console.log(
    `  ${"bucket".padEnd(22)} ${"n".padStart(7)} ${"spr".padStart(5)} ${"fwd bid".padStart(9)} ` +
      `${"taker YES".padStart(10)} ${"NO".padStart(7)} ${"maker YES".padStart(10)} ${"±".padStart(6)} ${"decided".padStart(8)}`,
  );
  console.log(
    `  ${"-".repeat(22)} ${"-".repeat(7)} ${"-".repeat(5)} ${"-".repeat(9)} ` +
      `${"-".repeat(10)} ${"-".repeat(7)} ${"-".repeat(10)} ${"-".repeat(6)} ${"-".repeat(8)}`,
  );
  for (const { label, bucket: b } of rows) {
    if (b.n === 0) continue;
    const y = rate(b.yesWin, b.yesLoss);
    const no = rate(b.noWin, b.noLoss);
    const mk = rate(b.makerWin, b.makerLoss);
    const decided = (b.yesWin + b.yesLoss) / b.n;
    // A star marks a bucket that clears its own break-even — the only thing
    // on this table that would mean money rather than a smaller loss.
    const flag = (p: number, n: number, be: number) => (n > 0 && p > be ? "*" : " ");
    console.log(
      `  ${label.padEnd(22)} ${String(b.n).padStart(7)} ` +
        `${mean(b.spreads).toFixed(1).padStart(4)}c ` +
        `${mean(b.fwdBid).toFixed(2).padStart(8)}c ` +
        `${(y.n === 0 ? "—" : pct(y.p)).padStart(9)}${flag(y.p, y.n, beTaker)} ` +
        `${(no.n === 0 ? "—" : pct(no.p)).padStart(7)} ` +
        `${(mk.n === 0 ? "—" : pct(mk.p)).padStart(9)}${flag(mk.p, mk.n, beMaker)} ` +
        `${(mk.n === 0 ? "—" : pct(seProp(mk.p, mk.n))).padStart(6)} ` +
        `${pct(decided).padStart(8)}`,
    );
  }
  console.log(
    `  break-even at ${tp}c/${sl}c: taker ${pct(beTaker)}, maker ${pct(beMaker)} of decided races`,
  );
}

function main(): void {
  const file = argStr("in", path.join(process.env.APPDATA ?? ".", "ROM Trader", "scans.jsonl"));
  const tp = Number(argStr("tp", "12"));
  const sl = Number(argStr("sl", "12"));
  // Forty scans is ten minutes at the default interval — long enough for a
  // 12c barrier to be reached, short enough that the market is recognisable.
  const maxAhead = Number(argStr("ahead", "40"));

  const scans = loadScans(file);
  const segs = segmentScans(scans, 180_000, 10);
  console.log(`\n=== Signal edge study: ${path.basename(file)} ===`);
  console.log(
    `  ${scans.length} scans, ${segs.length} contiguous segments, ` +
      `barrier ${tp}c target / ${sl}c stop, ${maxAhead} scans ahead`,
  );

  // Every observation that clears the engine's structural filters. The
  // momentum threshold is deliberately NOT applied: the point is to see the
  // whole distribution the trigger is carving a slice out of.
  const byMomentum = new Map<string, Bucket>();
  const order = [
    "< -6c",
    "-6 to -4c",
    "-4 to -2c",
    "-2 to 0c",
    "flat 0c",
    "0 to +2c",
    "+2 to +4c",
    "+4 to +6c",
    ">= +6c",
  ];
  for (const k of order) byMomentum.set(k, emptyBucket());

  // The engine's own trigger, split by the gates that ship on, so each gate's
  // contribution to entry quality is visible rather than inferred.
  const gated = new Map<string, Bucket>();
  const gateOrder = [
    "trigger >= 4c",
    "  + traded volume",
    "  + consistent climb",
    "  + both gates",
    "  + both, spread<=2",
  ];
  for (const k of gateOrder) gated.set(k, emptyBucket());

  const byMinutesLeft = new Map<string, Bucket>();
  const minsOrder = ["< 15m", "15-30m", "30-60m", "60-120m", "> 120m"];
  for (const k of minsOrder) byMinutesLeft.set(k, emptyBucket());

  // Kalshi's fee is 0.07 x P x (1 - P) per contract, so it peaks at 50c and
  // collapses toward both ends: 1.75c a side at 50c, 0.89c at 15c or 85c,
  // 0.39c at 94c. The engine's 10-85c band spans the whole curve and spends
  // most of its trades in the expensive middle. If the signal survives at the
  // ends, the cost of using it there is a fraction of what it is at 50c.
  const byPrice = new Map<string, Bucket>();
  const priceOrder = ["10-25c", "25-40c", "40-60c", "60-75c", "75-85c"];
  for (const k of priceOrder) byPrice.set(k, emptyBucket());

  // The two axes that the study above says actually matter — how hard the bid
  // moved, and how tight the book is — crossed, with both gates on. If any
  // cell clears its break-even line, that cell is a configuration.
  const momSteps = [3, 4, 5, 6, 8];
  const spreadSteps = [1, 2, 3];
  const matrix = new Map<string, Bucket>();
  const matrixOrder: string[] = [];
  for (const mth of momSteps) {
    for (const sp of spreadSteps) {
      const k = `mom>=${mth}c spr<=${sp}c`;
      matrixOrder.push(k);
      matrix.set(k, emptyBucket());
    }
  }

  let observations = 0;

  for (const seg of segs) {
    for (const chains of runs(seg).values()) {
      for (const s of chains) {
        for (let i = LOOKBACK; i < s.length - 1; i++) {
          const cur = s[i];
          const spread = cur.ask - cur.bid;
          // Structural filters only: a book with no two-sided quote, a price
          // where the stop cannot fire, a market past its entry cutoff. These
          // are conditions on whether a trade is possible at all, not on
          // whether the signal is any good.
          if (cur.bid <= 0 || cur.ask <= 0 || cur.ask >= 100) continue;
          if (cur.ask < 10 || cur.ask > 85) continue;
          if (cur.ask <= sl) continue;
          if (spread <= 0) continue;
          if (i + 1 < MIN_SAMPLES) continue;

          const mom = cur.bid - s[i - LOOKBACK].bid;
          const volDelta = cur.volume - s[i - LOOKBACK].volume;
          const climb = TradingEngine.consistentClimb(
            s.slice(i - LOOKBACK, i + 1).map((x) => x.bid),
          );
          const minsLeft = cur.closeTs > 0 ? (cur.closeTs * 1000 - cur.ts) / 60_000 : Infinity;

          const yes = raceYes(s, i, tp, sl, maxAhead);
          const no = raceNo(s, i, tp, sl, maxAhead);
          const maker = raceMaker(s, i, tp, sl, maxAhead);
          const ahead = Math.min(s.length - 1, i + maxAhead);
          const fwd = s[ahead].bid - cur.bid;

          const add = (b: Bucket) => {
            b.n++;
            if (yes === "win") b.yesWin++;
            else if (yes === "loss") b.yesLoss++;
            else b.yesNeither++;
            if (no === "win") b.noWin++;
            else if (no === "loss") b.noLoss++;
            else b.noNeither++;
            if (maker === "win") b.makerWin++;
            else if (maker === "loss") b.makerLoss++;
            b.fwdBid.push(fwd);
            b.spreads.push(spread);
          };

          observations++;

          const key =
            mom <= -6
              ? "< -6c"
              : mom <= -4
                ? "-6 to -4c"
                : mom <= -2
                  ? "-4 to -2c"
                  : mom < 0
                    ? "-2 to 0c"
                    : mom === 0
                      ? "flat 0c"
                      : mom < 2
                        ? "0 to +2c"
                        : mom < 4
                          ? "+2 to +4c"
                          : mom < 6
                            ? "+4 to +6c"
                            : ">= +6c";
          add(byMomentum.get(key)!);

          if (mom >= 4) {
            add(gated.get("trigger >= 4c")!);
            if (volDelta > 0) add(gated.get("  + traded volume")!);
            if (climb) add(gated.get("  + consistent climb")!);
            if (volDelta > 0 && climb) add(gated.get("  + both gates")!);
            if (volDelta > 0 && climb && spread <= 2) add(gated.get("  + both, spread<=2")!);

            const mk =
              minsLeft < 15
                ? "< 15m"
                : minsLeft < 30
                  ? "15-30m"
                  : minsLeft < 60
                    ? "30-60m"
                    : minsLeft < 120
                      ? "60-120m"
                      : "> 120m";
            add(byMinutesLeft.get(mk)!);
          }

          if (mom >= 4 && volDelta > 0 && climb && spread <= 2) {
            const p = cur.ask;
            const pk =
              p < 25 ? "10-25c" : p < 40 ? "25-40c" : p < 60 ? "40-60c" : p < 75 ? "60-75c" : "75-85c";
            add(byPrice.get(pk)!);
          }

          if (volDelta > 0 && climb) {
            for (const mth of momSteps) {
              if (mom < mth) continue;
              for (const sp of spreadSteps) {
                if (spread <= sp) add(matrix.get(`mom>=${mth}c spr<=${sp}c`)!);
              }
            }
          }
        }
      }
    }
  }

  console.log(`  ${observations.toLocaleString()} tradeable observations\n`);

  report(
    "Every observation, by how far the bid moved over the last 3 scans:",
    order.map((k) => ({ label: k, bucket: byMomentum.get(k)! })),
    tp,
    sl,
  );
  report(
    "The engine's trigger, and what each shipped gate does to it:",
    gateOrder.map((k) => ({ label: k, bucket: gated.get(k)! })),
    tp,
    sl,
  );
  report(
    "Triggered entries by time left before the market closes:",
    minsOrder.map((k) => ({ label: k, bucket: byMinutesLeft.get(k)! })),
    tp,
    sl,
  );
  report(
    "Trigger strength x book tightness, both gates on:",
    matrixOrder.map((k) => ({ label: k, bucket: matrix.get(k)! })),
    tp,
    sl,
  );

  // Priced per bucket rather than at 50c: the whole question here is whether a
  // cheaper corner of the fee curve is reachable, so quoting every row against
  // the mid-price fee would hide the answer.
  console.log("\n  Triggered entries by price, against the fee actually charged there:");
  console.log(
    `  ${"band".padEnd(22)} ${"n".padStart(7)} ${"fee/side".padStart(9)} ${"fwd bid".padStart(9)} ` +
      `${"maker YES".padStart(10)} ${"needs".padStart(7)} ${"margin".padStart(8)}`,
  );
  console.log(
    `  ${"-".repeat(22)} ${"-".repeat(7)} ${"-".repeat(9)} ${"-".repeat(9)} ${"-".repeat(10)} ${"-".repeat(7)} ${"-".repeat(8)}`,
  );
  for (const k of priceOrder) {
    const b = byPrice.get(k)!;
    if (b.n === 0) continue;
    const mid = Number(k.split("-")[0]) + (Number(k.split("-")[1].replace("c", "")) - Number(k.split("-")[0])) / 2;
    const fee = takerFeeCentsPerContract(mid);
    const need = (sl + fee) / (tp - fee + sl + fee);
    const mk = rate(b.makerWin, b.makerLoss);
    const margin = mk.n === 0 ? 0 : mk.p - need;
    console.log(
      `  ${k.padEnd(22)} ${String(b.n).padStart(7)} ${`${fee.toFixed(2)}c`.padStart(9)} ` +
        `${mean(b.fwdBid).toFixed(2).padStart(8)}c ` +
        `${(mk.n === 0 ? "—" : pct(mk.p)).padStart(10)} ${pct(need).padStart(7)} ` +
        `${`${margin >= 0 ? "+" : ""}${(margin * 100).toFixed(1)}pt`.padStart(8)}`,
    );
  }

  console.log(
    "\n  'decided' is the share of races that reached a barrier at all within the\n" +
      "  window; the rest were still open and are excluded from the win rates.\n" +
      "  YES and NO are the same race scored from opposite sides, so they do not\n" +
      "  sum to 100%: the spread sits between them and is paid by both.\n",
  );
}

main();
