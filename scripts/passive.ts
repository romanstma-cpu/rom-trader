/**
 * If you rest a bid instead of crossing the spread, do you get filled — and do
 * you regret it when you do?
 *
 * Everything else measured so far assumed a taker. The engine buys at the ask
 * and sells at the bid, so it pays roughly 3.5 cents a round trip against a
 * measured edge of about 0.7, and no amount of parameter tuning closes a gap
 * that shape. A resting order changes the arithmetic completely rather than
 * incrementally: on Kalshi's crypto ladders the maker multiplier is zero, so a
 * bid that fills costs nothing, and a position held to resolution pays no exit
 * fee either. The whole round trip is free. A strategy that buys at 85c and
 * holds needs the thing to happen 85% of the time, and not one basis point
 * more.
 *
 * Which moves the entire question onto two numbers nobody has measured:
 *
 *   1. HOW OFTEN DOES A RESTING BID FILL? An order that never fills earns
 *      nothing however good its price was.
 *
 *   2. WHAT FILLS IT? This is the one that kills strategies. A resting bid is
 *      hit by whoever wants to sell, and the people who most want to sell you
 *      a favourite at 85c are the ones who have just worked out it is worth
 *      80. If the markets that fill you settle NO more often than the ones
 *      that pass you by, the fill rate is not an opportunity, it is a
 *      selection effect, and every cent saved on fees is handed straight back.
 *
 * So this reports `settle | filled` against `settle | not filled`. If they
 * agree, the flow is benign and the free round trip is real money. If the
 * filled side is materially worse, the plan is dead and it cost an afternoon
 * to find out instead of a live account.
 *
 * FILLS ARE INFERRED FROM TOP-OF-BOOK SNAPSHOTS, which cannot see the queue or
 * the tape, so three rules bracket the truth rather than pretending to one
 * answer:
 *
 *   strict  a later scan shows ask <= our bid. That book state is impossible
 *           while our order still rests — it would have matched — so we filled.
 *           Airtight, and undercounts.
 *   traded  the bid fell below ours AND volume rose, so trades happened at or
 *           through our level. The honest middle.
 *   loose   the bid fell below ours. The level is gone, but it may have been
 *           cancelled rather than lifted. Overcounts.
 *
 * Decisions get made on `strict` and `traded`. `loose` is printed so the width
 * of the uncertainty is visible instead of assumed away.
 *
 *   npx esbuild scripts/passive.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/passive.js
 *   node scripts/passive.js [--in <scans.jsonl>] [--settle <settlements.jsonl>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { KalshiMarket } from "../electron/engine/kalshi";
import type { RecordedScan } from "../electron/engine/recorder";
import type { Settlement } from "../electron/engine/settlements";

function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}
const argNum = (name: string, fallback: number): number => {
  const v = Number(argStr(name, String(fallback)));
  return Number.isFinite(v) ? v : fallback;
};

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

// ------------------------------------------------------------------ outcomes

/**
 * Confidence thresholds for reading a settlement off the last quote, used only
 * when no recorded outcome exists for that ticker.
 *
 * This is the weak link and it is why `settlements.ts` was written. A market
 * pinned at 96c almost certainly settled YES, but a market that simply dropped
 * off the top-forty volume table at 60c reveals nothing — and those are not
 * randomly distributed, they are concentrated in the middle of the price range
 * where the answer matters most. Every inference is counted and the exclusion
 * rate is printed, because a reader who cannot see the size of that hole
 * cannot judge anything below it.
 */
const SETTLED_YES = 95;
const SETTLED_NO = 5;

type Outcome = "yes" | "no" | "unknown";

function loadSettlementMap(file: string): Map<string, Outcome> {
  const map = new Map<string, Outcome>();
  if (!fs.existsSync(file)) return map;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line) as Settlement;
      const r = (s.result ?? "").trim().toLowerCase();
      if (r === "yes" || r === "no") map.set(s.ticker, r);
      // "void" and anything else is deliberately not mapped: a voided market
      // neither won nor lost, and folding it into either bucket would bias
      // every rate computed from it.
    } catch {
      // partial line
    }
  }
  return map;
}

// ------------------------------------------------------------------ the study

interface Rest {
  ticker: string;
  /** The price we joined, in cents. */
  price: number;
  restedAt: number;
  restedVolume: number;
  closeTs: number;
  /** Which rules have declared this filled. */
  strict: boolean;
  traded: boolean;
  loose: boolean;
  done: boolean;
}

type Rule = "strict" | "traded" | "loose";
const RULES: Rule[] = ["strict", "traded", "loose"];

/**
 * Does this market have a faster price somewhere else?
 *
 * The distinction that matters for a resting order is not the subject, it is
 * whether a counterparty can watch the answer move in real time on a venue
 * quicker than Kalshi. "Will BTC be above 85,000 at 18:00" is a lagging mirror
 * of a book that trades in microseconds on three continents; anyone with a
 * Binance feed knows the fair value of that contract before the Kalshi quote
 * updates, and a resting bid is a standing offer to be picked off by them. The
 * high temperature in Miami has no such feed. It resolves from a reading
 * nobody can trade ahead of, so a seller hitting your bid is likely rebalancing
 * or bored rather than informed.
 *
 * That is a hypothesis about mechanism, not a classification of topic, and it
 * is testable here: if it is right, the adverse-selection gap should be severe
 * on 'mirror' series and near zero on 'estimate' ones. If both are equally bad
 * the hypothesis is wrong and passive entry is simply not viable.
 */
type Kind = "mirror" | "estimate";

/** Underlyings that trade continuously somewhere faster than Kalshi. */
const MIRROR_STEMS = [
  "BTC", "ETH", "SOL", "XRP", "DOGE", "ADA", "LTC", "LINK",
  "INX", "NASDAQ", "SPX", "DJIA", "RUT",
  "WTI", "BRENT", "GOLD", "SILVER", "COPPER", "NGAS",
  "USDJPY", "EURUSD", "GBPUSD", "USDCAD", "USDMXN",
];

function seriesOf(ticker: string): string {
  return ticker.split("-")[0] ?? ticker;
}

function kindOf(ticker: string): Kind {
  const s = seriesOf(ticker).toUpperCase();
  // Longest stem first so BTC does not shadow a hypothetical BTCSOMETHING that
  // is really a different underlying.
  for (const stem of [...MIRROR_STEMS].sort((a, b) => b.length - a.length)) {
    if (s.includes(stem)) return "mirror";
  }
  return "estimate";
}

interface Tally {
  filled: number;
  fillYes: number;
  fillNo: number;
  fillUnknown: number;
  passYes: number;
  passNo: number;
  passUnknown: number;
  /** Sum of entry prices on filled orders, for the average paid. */
  fillPriceSum: number;
}

const blank = (): Tally => ({
  filled: 0,
  fillYes: 0,
  fillNo: 0,
  fillUnknown: 0,
  passYes: 0,
  passNo: 0,
  passUnknown: 0,
  fillPriceSum: 0,
});

function main(): void {
  const file = argStr("in", path.join(process.env.APPDATA ?? ".", "ROM Trader", "scans.jsonl"));
  const settleFile = argStr(
    "settle",
    path.join(process.env.APPDATA ?? ".", "ROM Trader", "settlements.jsonl"),
  );
  const lo = argNum("lo", 75);
  const hi = argNum("hi", 92);
  const minMins = argNum("mins", 20);
  const cancelMins = argNum("cancel", 10);
  const driftCents = argNum("drift", 3);

  const scans = loadScans(file);
  if (scans.length === 0) {
    console.log(`No scans in ${file}`);
    return;
  }
  const recorded = loadSettlementMap(settleFile);

  // ---------------------------------------------------------- pass 1: outcomes
  // The last quote of every market, so an outcome can be inferred where none
  // was recorded.
  const lastQuote = new Map<string, { bid: number; ask: number }>();
  for (const scan of scans) {
    for (const m of scan.markets as KalshiMarket[]) {
      lastQuote.set(m.ticker, { bid: m.yes_bid, ask: m.yes_ask });
    }
  }

  let fromRecord = 0;
  let fromQuote = 0;
  const outcome = (ticker: string): Outcome => {
    const known = recorded.get(ticker);
    if (known) {
      fromRecord++;
      return known;
    }
    const q = lastQuote.get(ticker);
    if (!q) return "unknown";
    if (q.bid >= SETTLED_YES || q.ask >= SETTLED_YES) {
      fromQuote++;
      return "yes";
    }
    if (q.ask <= SETTLED_NO || q.bid <= SETTLED_NO) {
      fromQuote++;
      return "no";
    }
    return "unknown";
  };

  // ------------------------------------------------- pass 2: rest and walk on
  const open = new Map<string, Rest>();
  const finished: Rest[] = [];
  /** Every ticker that was ever eligible, filled or not, for the pass-by arm. */
  const eligible = new Set<string>();
  let restedCount = 0;

  for (const scan of scans) {
    for (const m of scan.markets as KalshiMarket[]) {
      const bid = m.yes_bid;
      const ask = m.yes_ask;
      if (bid <= 0 || ask <= 0 || ask >= 100) continue;
      const minsLeft = m.close_ts > 0 ? (m.close_ts * 1000 - scan.ts) / 60_000 : Infinity;

      const live = open.get(m.ticker);
      if (live && !live.done) {
        // ---- walk an existing resting order forward
        if (ask <= live.price) {
          // The book crossed our price. It could not have while we rested.
          live.strict = true;
          live.traded = true;
          live.loose = true;
          live.done = true;
        } else if (bid < live.price) {
          live.loose = true;
          if (m.volume > live.restedVolume) live.traded = true;
          // A level that emptied with trades against it is a fill under the
          // middle rule; without them it stays merely 'loose' and keeps
          // walking, because the price can come back to us.
          if (live.traded) live.done = true;
        }
        if (!live.done && bid - live.price >= driftCents) {
          live.done = true; // market ran away; a real bot cancels and re-quotes
        }
        if (!live.done && minsLeft <= cancelMins) {
          live.done = true; // pulled before the close
        }
        if (live.done) {
          finished.push(live);
          open.delete(m.ticker);
        }
        continue;
      }

      // ---- consider resting a new order
      if (open.has(m.ticker)) continue;
      if (bid < lo || bid > hi) continue;
      if (minsLeft < minMins) continue;
      eligible.add(m.ticker);
      open.set(m.ticker, {
        ticker: m.ticker,
        price: bid,
        restedAt: scan.ts,
        restedVolume: m.volume,
        closeTs: m.close_ts,
        strict: false,
        traded: false,
        loose: false,
        done: false,
      });
      restedCount++;
    }
  }
  // Orders still resting when the recording ended never resolved either way.
  for (const r of open.values()) finished.push(r);

  // ------------------------------------------------------------------- tally
  const overall: Record<Rule, Tally> = {
    strict: blank(),
    traded: blank(),
    loose: blank(),
  };
  const bands: { lo: number; hi: number; t: Record<Rule, Tally> }[] = [];
  for (let b = lo; b < hi; b += 5) {
    bands.push({ lo: b, hi: Math.min(b + 5, hi), t: { strict: blank(), traded: blank(), loose: blank() } });
  }
  const kinds: Record<Kind, Record<Rule, Tally>> = {
    mirror: { strict: blank(), traded: blank(), loose: blank() },
    estimate: { strict: blank(), traded: blank(), loose: blank() },
  };
  /** Per-series, on the strict rule, so the worst offenders can be named. */
  const bySeries = new Map<string, Tally>();

  for (const r of finished) {
    const out = outcome(r.ticker);
    const band = bands.find((b) => r.price >= b.lo && r.price < b.hi);
    const kind = kinds[kindOf(r.ticker)];
    const series = seriesOf(r.ticker);
    if (!bySeries.has(series)) bySeries.set(series, blank());
    for (const rule of RULES) {
      const hit = r[rule];
      const perSeries = rule === "strict" ? bySeries.get(series) : undefined;
      for (const t of [overall[rule], band?.t[rule], kind[rule], perSeries]) {
        if (!t) continue;
        if (hit) {
          t.filled++;
          t.fillPriceSum += r.price;
          if (out === "yes") t.fillYes++;
          else if (out === "no") t.fillNo++;
          else t.fillUnknown++;
        } else {
          if (out === "yes") t.passYes++;
          else if (out === "no") t.passNo++;
          else t.passUnknown++;
        }
      }
    }
  }

  // ------------------------------------------------------------------ report
  const hours = (scans[scans.length - 1].ts - scans[0].ts) / 3_600_000;
  console.log(`\n=== Would a resting bid have filled, and was it worth it? ===`);
  console.log(`  ${path.basename(file)} · ${scans.length.toLocaleString()} scans · ${hours.toFixed(0)}h`);
  console.log(
    `  resting at the bid when the bid is ${lo}-${hi}c and at least ${minMins} min from close;\n` +
      `  cancelled if the bid runs ${driftCents}c away or with ${cancelMins} min left\n`,
  );
  console.log(`  ${restedCount.toLocaleString()} orders rested across ${eligible.size.toLocaleString()} markets\n`);

  const rate = (n: number, d: number) => (d === 0 ? NaN : (n / d) * 100);
  const se = (p: number, n: number) => (n === 0 ? NaN : Math.sqrt(((p / 100) * (1 - p / 100)) / n) * 100);
  const pct = (v: number) => (Number.isFinite(v) ? `${v.toFixed(1)}%` : "—");

  console.log(
    `  ${"rule".padEnd(8)} ${"fill rate".padStart(10)} ${"n filled".padStart(9)} ` +
      `${"settle|filled".padStart(15)} ${"settle|passed".padStart(15)} ${"gap".padStart(9)} ${"edge/ct".padStart(9)}`,
  );
  console.log(`  ${"-".repeat(8)} ${"-".repeat(10)} ${"-".repeat(9)} ${"-".repeat(15)} ${"-".repeat(15)} ${"-".repeat(9)} ${"-".repeat(9)}`);

  for (const rule of RULES) {
    const t = overall[rule];
    const decidedFill = t.fillYes + t.fillNo;
    const decidedPass = t.passYes + t.passNo;
    const fillRate = rate(t.filled, finished.length);
    const sFill = rate(t.fillYes, decidedFill);
    const sPass = rate(t.passYes, decidedPass);
    const gap = sFill - sPass;
    const paid = t.filled === 0 ? NaN : t.fillPriceSum / t.filled;
    // Zero fees on a zero-maker series held to settlement, so the edge is
    // simply the settlement rate less the price paid.
    const edge = sFill - paid;
    console.log(
      `  ${rule.padEnd(8)} ${pct(fillRate).padStart(10)} ${String(decidedFill).padStart(9)} ` +
        `${`${pct(sFill)} ±${se(sFill, decidedFill).toFixed(1)}`.padStart(15)} ` +
        `${`${pct(sPass)} ±${se(sPass, decidedPass).toFixed(1)}`.padStart(15)} ` +
        `${(Number.isFinite(gap) ? `${gap >= 0 ? "+" : ""}${gap.toFixed(1)}pp` : "—").padStart(9)} ` +
        `${(Number.isFinite(edge) ? `${edge >= 0 ? "+" : ""}${edge.toFixed(2)}c` : "—").padStart(9)}`,
    );
  }

  console.log(
    `\n  'gap' is the adverse-selection test: settlement rate on the orders that filled\n` +
      `  minus the rate on the ones that did not. Near zero means whoever sold to us was\n` +
      `  not better informed than the market. Materially negative means we are filled\n` +
      `  precisely when we are wrong, and no fee saving survives that.\n` +
      `  'edge/ct' assumes a zero maker fee and no exit leg, which is what KXBTCD is.\n`,
  );

  // Per-band, on the middle rule only — three rules times four bands is a table
  // nobody reads.
  console.log(`  By entry price, on the 'traded' rule:\n`);
  console.log(
    `  ${"band".padEnd(9)} ${"rested".padStart(8)} ${"filled".padStart(8)} ${"fill%".padStart(7)} ` +
      `${"settle|filled".padStart(15)} ${"paid".padStart(7)} ${"edge/ct".padStart(9)}`,
  );
  console.log(`  ${"-".repeat(9)} ${"-".repeat(8)} ${"-".repeat(8)} ${"-".repeat(7)} ${"-".repeat(15)} ${"-".repeat(7)} ${"-".repeat(9)}`);
  for (const b of bands) {
    const t = b.t.traded;
    const rested = t.filled + t.passYes + t.passNo + t.passUnknown;
    const decided = t.fillYes + t.fillNo;
    if (rested === 0) continue;
    const sFill = rate(t.fillYes, decided);
    const paid = t.filled === 0 ? NaN : t.fillPriceSum / t.filled;
    const edge = sFill - paid;
    console.log(
      `  ${`${b.lo}-${b.hi}c`.padEnd(9)} ${String(rested).padStart(8)} ${String(t.filled).padStart(8)} ` +
        `${pct(rate(t.filled, rested)).padStart(7)} ` +
        `${(decided >= 10 ? `${pct(sFill)} ±${se(sFill, decided).toFixed(1)}` : `n=${decided}`).padStart(15)} ` +
        `${(Number.isFinite(paid) ? `${paid.toFixed(1)}c` : "—").padStart(7)} ` +
        `${(Number.isFinite(edge) && decided >= 10 ? `${edge >= 0 ? "+" : ""}${edge.toFixed(2)}c` : "—").padStart(9)}`,
    );
  }

  // ------------------------------------------- does a faster market elsewhere
  //                                              explain who is hitting the bid?
  console.log(`\n  By whether a faster price exists elsewhere, on the strict rule:\n`);
  console.log(
    `  ${"kind".padEnd(10)} ${"rested".padStart(8)} ${"fill%".padStart(7)} ` +
      `${"settle|filled".padStart(15)} ${"settle|passed".padStart(15)} ${"gap".padStart(9)} ${"edge/ct".padStart(9)}`,
  );
  console.log(
    `  ${"-".repeat(10)} ${"-".repeat(8)} ${"-".repeat(7)} ${"-".repeat(15)} ${"-".repeat(15)} ${"-".repeat(9)} ${"-".repeat(9)}`,
  );
  for (const kind of ["mirror", "estimate"] as Kind[]) {
    const t = kinds[kind].strict;
    const rested = t.filled + t.passYes + t.passNo + t.passUnknown;
    if (rested === 0) continue;
    const decidedFill = t.fillYes + t.fillNo;
    const decidedPass = t.passYes + t.passNo;
    const sFill = rate(t.fillYes, decidedFill);
    const sPass = rate(t.passYes, decidedPass);
    const paid = t.filled === 0 ? NaN : t.fillPriceSum / t.filled;
    console.log(
      `  ${kind.padEnd(10)} ${String(rested).padStart(8)} ${pct(rate(t.filled, rested)).padStart(7)} ` +
        `${`${pct(sFill)} ±${se(sFill, decidedFill).toFixed(1)}`.padStart(15)} ` +
        `${`${pct(sPass)} ±${se(sPass, decidedPass).toFixed(1)}`.padStart(15)} ` +
        `${(Number.isFinite(sFill - sPass) ? `${sFill - sPass >= 0 ? "+" : ""}${(sFill - sPass).toFixed(1)}pp` : "—").padStart(9)} ` +
        `${(Number.isFinite(sFill - paid) ? `${sFill - paid >= 0 ? "+" : ""}${(sFill - paid).toFixed(2)}c` : "—").padStart(9)}`,
    );
  }
  console.log(
    `\n  'mirror' = the underlying trades continuously somewhere faster than Kalshi\n` +
      `  (crypto, indices, metals, oil, FX). 'estimate' = it does not (weather, social\n` +
      `  counts, politics). If the gap is severe on the first and mild on the second,\n` +
      `  the counterparty is picking us off with a feed we do not have.\n`,
  );

  // Named, because "some series are worse" is not actionable and a list is.
  const ranked = [...bySeries.entries()]
    .map(([series, t]) => ({
      series,
      rested: t.filled + t.passYes + t.passNo + t.passUnknown,
      decided: t.fillYes + t.fillNo,
      settle: rate(t.fillYes, t.fillYes + t.fillNo),
      paid: t.filled === 0 ? NaN : t.fillPriceSum / t.filled,
      kind: kindOf(series),
    }))
    .filter((r) => r.decided >= 20)
    .map((r) => ({ ...r, edge: r.settle - r.paid }))
    .sort((a, b) => b.edge - a.edge);

  if (ranked.length > 0) {
    console.log(`  Per series with at least 20 decided fills, best edge first:\n`);
    console.log(
      `  ${"series".padEnd(16)} ${"kind".padEnd(9)} ${"decided".padStart(8)} ` +
        `${"settle|filled".padStart(15)} ${"paid".padStart(7)} ${"edge/ct".padStart(9)}`,
    );
    console.log(
      `  ${"-".repeat(16)} ${"-".repeat(9)} ${"-".repeat(8)} ${"-".repeat(15)} ${"-".repeat(7)} ${"-".repeat(9)}`,
    );
    for (const r of ranked) {
      console.log(
        `  ${r.series.padEnd(16)} ${r.kind.padEnd(9)} ${String(r.decided).padStart(8)} ` +
          `${`${pct(r.settle)} ±${se(r.settle, r.decided).toFixed(1)}`.padStart(15)} ` +
          `${`${r.paid.toFixed(1)}c`.padStart(7)} ` +
          `${`${r.edge >= 0 ? "+" : ""}${r.edge.toFixed(2)}c`.padStart(9)}`,
      );
    }
    console.log("");
  }

  // ------------------------------------------------------- honesty about gaps
  const t = overall.traded;
  const unknown = t.fillUnknown + t.passUnknown;
  const total = finished.length;
  console.log(
    `\n  ${fromRecord.toLocaleString()} outcomes came from recorded settlements, ` +
      `${fromQuote.toLocaleString()} were inferred from a final quote.`,
  );
  console.log(
    `  ${unknown.toLocaleString()} of ${total.toLocaleString()} rested orders ` +
      `(${((unknown / Math.max(1, total)) * 100).toFixed(0)}%) have no outcome at all and are excluded.`,
  );
  if (fromRecord === 0) {
    console.log(
      `\n  NO RECORDED SETTLEMENTS WERE FOUND, so every outcome above is inferred from\n` +
        `  the last quote — which systematically loses the markets that went quiet\n` +
        `  before resolving, and those cluster in the middle of the price range. Treat\n` +
        `  this run as a direction, not a number. Leave the app running so\n` +
        `  settlements.jsonl fills, then run it again.`,
    );
  }
  console.log("");
}

main();
