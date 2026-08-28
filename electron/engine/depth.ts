/**
 * What is standing behind the quote.
 *
 * Seven studies have now measured this venue and every one of them read the
 * touch — one bid, one ask. That is what a trade would COST, and it is silent
 * about what is actually there. A one-cent spread with sixty contracts resting
 * and a one-cent spread with six thousand are the same quote and completely
 * different markets: the first moves if you lean on it, the second does not.
 * Nothing this app has recorded could tell them apart.
 *
 * Depth is the last free input Kalshi publishes that ROM has never stored, and
 * unlike the tape there is no history of it on disk — it cannot be backfilled
 * from anywhere, so it has to start accumulating before it can be studied. That
 * is the whole reason this exists now rather than after the study is designed.
 *
 * WHAT IS KEPT, AND WHY NOT MORE
 *
 * Five levels a side. The full book runs to ninety-nine and the tail is mostly
 * decoration — resting size ten cents from the touch is not going to be hit and
 * costs bytes to remember. Five levels covers the region a marketable order
 * would actually walk, which is the only region where the question "how much is
 * really there" has a tradeable answer.
 *
 * One request per market per poll, forty markets every thirty seconds, is 1.3 a
 * second against a documented budget of two hundred. Same arithmetic as the
 * tape recorder, and for the same reason: the cost is trivial and the data
 * cannot be recovered later if it is not taken now.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { KalshiBook } from "./kalshi";
import { dataDir } from "./store";

const FILE = "depth.jsonl";
const PREV = "depth.1.jsonl";

/** Levels kept per side. */
export const TOP_LEVELS = 5;

/**
 * Rotate at this size rather than growing without bound.
 *
 * Measured shape: forty markets every thirty seconds at roughly two hundred
 * bytes a row is about twenty-three megabytes a day, so a hundred-megabyte cap
 * holds four days — comfortably longer than the tape's seven hours, and enough
 * that a study is not coverage-limited the way the flow study was.
 */
const MAX_BYTES = 100 * 1024 * 1024;

/** One side of one book at one moment: [price in YES cents, resting size]. */
export type Level = [number, number];

export interface DepthPoint {
  ts: number;
  ticker: string;
  bids: Level[];
  asks: Level[];
}

function file(): string {
  return path.join(dataDir(), FILE);
}
function prevPath(): string {
  return path.join(dataDir(), PREV);
}

// ------------------------------------------------------------------ pure

/**
 * Resting size within `withinCents` of the touch, per side.
 *
 * Measured from each side's OWN best price rather than from the mid, so a wide
 * book is not silently reported as empty. Anchoring on the mid would count a
 * bid three cents below its own touch as "far away" purely because the spread
 * was wide, which conflates depth with spread — two things this is meant to
 * separate.
 */
export function restingWithin(
  book: Pick<KalshiBook, "bids" | "asks">,
  withinCents: number,
): { bid: number; ask: number } {
  const bestBid = book.bids[0]?.priceCents ?? null;
  const bestAsk = book.asks[0]?.priceCents ?? null;
  let bid = 0;
  let ask = 0;
  if (bestBid !== null) {
    for (const l of book.bids) {
      if (bestBid - l.priceCents > withinCents) break;
      bid += l.size;
    }
  }
  if (bestAsk !== null) {
    for (const l of book.asks) {
      if (l.priceCents - bestAsk > withinCents) break;
      ask += l.size;
    }
  }
  return { bid, ask };
}

/**
 * Book imbalance: +1 when every resting contract is a bid, −1 when all asks.
 *
 * The hypothesis this exists to test is that a book leaning heavily to one side
 * predicts where the price goes next. It is a genuinely different claim from
 * the flow study, which asked about trades that already happened — this asks
 * about orders that have NOT happened, and whose owners can cancel them
 * costlessly. That asymmetry is exactly why it might be information and exactly
 * why it might be noise.
 *
 * Null rather than zero when the book is empty: an absent book and a balanced
 * one mean opposite things and must never average together.
 */
export function bookImbalance(
  book: Pick<KalshiBook, "bids" | "asks">,
  withinCents = 3,
): number | null {
  const { bid, ask } = restingWithin(book, withinCents);
  const total = bid + ask;
  if (total <= 0) return null;
  return (bid - ask) / total;
}

/** Trims a book to what gets written, best-first. */
export function toPoint(book: KalshiBook, ts: number): DepthPoint {
  return {
    ts,
    ticker: book.ticker,
    bids: book.bids.slice(0, TOP_LEVELS).map((l) => [l.priceCents, l.size] as Level),
    asks: book.asks.slice(0, TOP_LEVELS).map((l) => [l.priceCents, l.size] as Level),
  };
}

/** A book with nothing on either side is not worth a line on disk. */
export function worthRecording(p: DepthPoint): boolean {
  return p.bids.length > 0 || p.asks.length > 0;
}

// ------------------------------------------------------------------ disk

export function recordDepth(points: DepthPoint[]): number {
  const keep = points.filter(worthRecording);
  if (keep.length === 0) return 0;
  try {
    rotateIfHuge();
    const lines = keep.map((p) => JSON.stringify({ t: p.ts, k: p.ticker, b: p.bids, a: p.asks }));
    fs.appendFileSync(file(), lines.join("\n") + "\n", "utf-8");
    return keep.length;
  } catch {
    // Instrumentation never interrupts trading.
    return 0;
  }
}

export function loadDepth(): DepthPoint[] {
  const out: DepthPoint[] = [];
  // Archive first so the result is in time order across a rotation.
  for (const p of [prevPath(), file()]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { t: number; k: string; b: Level[]; a: Level[] };
        if (!r.k || !Number.isFinite(r.t)) continue;
        out.push({ ts: r.t, ticker: r.k, bids: r.b ?? [], asks: r.a ?? [] });
      } catch {
        // torn final line from a killed process
      }
    }
  }
  return out;
}

export interface DepthInfo {
  exists: boolean;
  points: number;
  markets: number;
  bytes: number;
  firstTs: number | null;
  lastTs: number | null;
}

export function depthInfo(): DepthInfo {
  const p = file();
  if (!fs.existsSync(p)) {
    return { exists: false, points: 0, markets: 0, bytes: 0, firstTs: null, lastTs: null };
  }
  const rows = loadDepth();
  let bytes = 0;
  for (const f of [prevPath(), p]) {
    try {
      if (fs.existsSync(f)) bytes += fs.statSync(f).size;
    } catch {
      // a stat failure should cost the byte count, not the report
    }
  }
  return {
    exists: true,
    points: rows.length,
    markets: new Set(rows.map((r) => r.ticker)).size,
    bytes,
    firstTs: rows.length ? rows[0].ts : null,
    lastTs: rows.length ? rows[rows.length - 1].ts : null,
  };
}

export function clearDepth(): void {
  for (const p of [file(), prevPath()]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // the caller only cares that it tried
    }
  }
}

/**
 * Rename, never read-split-write.
 *
 * The tape recorder learned this the expensive way: rewriting a hundred-
 * megabyte log to drop its first half is an O(n) pause inside a trading
 * process. A rename is O(1) and keeps exactly one generation of history.
 */
function rotateIfHuge(): void {
  const p = file();
  try {
    if (!fs.existsSync(p)) return;
    if (fs.statSync(p).size < MAX_BYTES) return;
    const prev = prevPath();
    if (fs.existsSync(prev)) fs.unlinkSync(prev);
    fs.renameSync(p, prev);
  } catch {
    // A failed rotation must not stop the append that triggered it.
  }
}

// ------------------------------------------------------------------ sweep

export type BookFetcher = (ticker: string) => Promise<KalshiBook>;

/**
 * Fetches and stores one book per ticker.
 *
 * Bounded concurrency for the same reason as the tape: forty simultaneous
 * sockets against a shared rate budget is how instrumentation ends up costing
 * a trading request at the moment one matters.
 */
export async function sweepDepth(
  fetcher: BookFetcher,
  tickers: string[],
  concurrency = 4,
  now = Date.now(),
): Promise<number> {
  let written = 0;
  for (let i = 0; i < tickers.length; i += concurrency) {
    const batch = tickers.slice(i, i + concurrency);
    const results = await Promise.allSettled(batch.map((t) => fetcher(t)));
    const points: DepthPoint[] = [];
    for (const r of results) {
      // One unreachable market must not cost the other thirty-nine.
      if (r.status === "fulfilled") points.push(toPoint(r.value, now));
    }
    written += recordDepth(points);
  }
  return written;
}
