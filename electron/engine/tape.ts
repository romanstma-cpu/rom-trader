/**
 * What actually changed hands.
 *
 * The scan recorder keeps top-of-book quotes, and quotes cannot answer the one
 * question a resting-order strategy lives or dies on. When the best bid falls
 * from 85c to 84c, two opposite things may have happened: somebody sold into
 * the 85c bids, or everybody resting at 85c cancelled and walked away. A bid
 * of ours sitting at 85c is filled in the first world and untouched in the
 * second, and a snapshot taken every fifteen seconds cannot tell them apart.
 *
 * The first study of this had to guess, and bracketed the answer with three
 * rules whose results disagreed about the *sign* of the edge — one said minus
 * three cents a contract, another said plus two. That spread is not a finding,
 * it is the width of the guess, and no amount of further analysis on quotes
 * alone narrows it.
 *
 * The tape closes it. Every trade carries `taker_outcome_side`, and a taker
 * positioned for NO is selling YES into the resting bids. A YES bid resting at
 * or above that price was on the other side of that trade — subject only to
 * queue position, which is the one thing still unmeasured and is at least
 * bounded rather than unknown.
 *
 * One public request every thirty seconds covers every market at once, and
 * what is not in the recorded universe is discarded rather than stored.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { KalshiTrade } from "./kalshi";
import { dataDir } from "./store";

const FILE = "tape.jsonl";
const PREV = "tape.1.jsonl";
const STATE = "tape-state.json";

/**
 * Measured, not guessed: forty markets print about 14,000 trades an hour at
 * roughly 117 bytes a row — some 39MB a day, and four fills in five are on the
 * BTC hourly ladder alone. The scan recorder's 40MB cap would therefore rotate
 * this file every single day, leaving less tape than there are scans to join
 * it to.
 *
 * Two files of 100MB give about five days, which matches what the scan
 * recording holds, and rotating by rename means the cost does not grow with
 * the file. That second part matters more than the first: the scan recorder
 * rotates by reading the whole file, splitting it and writing half back, which
 * is fine for 5,000 lines and would mean a two-million-element array on the
 * main process here — a multi-second stall in the middle of a trading loop.
 */
const MAX_BYTES = 100 * 1024 * 1024;

/**
 * How far back to look on the very first poll.
 *
 * Kalshi pages newest-first, so asking for everything since the epoch would
 * spend a great many requests walking backwards through history that no
 * recorded scan can be joined to anyway. An hour is enough to bridge a restart.
 */
export const COLD_START_LOOKBACK_MS = 3_600_000;

/**
 * How far back past the last recorded trade each poll reaches.
 *
 * Kalshi filters by whole seconds, and a poll cycle can slip when the network
 * is slow, so asking from exactly where the last one ended drops anything that
 * printed in the gap. Overlapping costs a few duplicate rows, which `loadTape`
 * removes by trade id; not overlapping costs trades, which nothing can
 * recover.
 */
export const POLL_OVERLAP_MS = 10_000;

export interface TapeState {
  /** Epoch ms of the newest trade written. */
  lastTs: number;
}

function file(): string {
  return path.join(dataDir(), FILE);
}

function prevPath(): string {
  return path.join(dataDir(), PREV);
}

function statePath(): string {
  return path.join(dataDir(), STATE);
}

export function loadTapeState(): TapeState {
  try {
    const s = JSON.parse(fs.readFileSync(statePath(), "utf-8")) as TapeState;
    return { lastTs: Number.isFinite(s?.lastTs) ? s.lastTs : 0 };
  } catch {
    return { lastTs: 0 };
  }
}

export function saveTapeState(s: TapeState): void {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(s), "utf-8");
  } catch {
    // Instrumentation never interrupts trading.
  }
}

/** Where the next poll should start, in unix seconds. */
export function nextPollFrom(nowMs = Date.now()): number {
  const { lastTs } = loadTapeState();
  const from = lastTs > 0 ? lastTs - POLL_OVERLAP_MS : nowMs - COLD_START_LOOKBACK_MS;
  return Math.floor(from / 1000);
}

/**
 * Which of these trades are worth keeping.
 *
 * Block trades are dropped: they are negotiated off-book and never rested in
 * the order book, so they say nothing about whether a resting bid would have
 * filled — counting them would credit fills to orders that could not have
 * participated. Trades on markets outside the recorded universe are dropped
 * too, since there are no quotes to join them to.
 */
export function keepTrades(trades: KalshiTrade[], universe: Set<string>): KalshiTrade[] {
  return trades.filter(
    (t) =>
      !t.isBlock &&
      t.tradeId !== "" &&
      t.ticker !== "" &&
      t.price > 0 &&
      (universe.size === 0 || universe.has(t.ticker)),
  );
}

/**
 * Trade ids already appended, so the deliberate poll overlap costs a little
 * memory instead of a third of the file.
 *
 * Bounded and session-scoped. A restart can duplicate at most one overlap
 * window, which `loadTape` removes on read — belt and braces, because the
 * on-read guarantee has to hold for files this process did not write.
 */
const written = new Set<string>();
const WRITTEN_CAP = 20_000;

export function recordTrades(all: KalshiTrade[]): number {
  const trades = all.filter((t) => !written.has(t.tradeId));
  if (trades.length === 0) return 0;
  try {
    rotateIfHuge();
    if (written.size > WRITTEN_CAP) written.clear();
    for (const t of trades) written.add(t.tradeId);
    const lines = trades
      .map((t) =>
        JSON.stringify({
          i: t.tradeId,
          k: t.ticker,
          t: t.ts,
          p: t.price,
          c: t.count,
          s: t.takerSold ? 1 : 0,
        }),
      )
      .join("\n");
    fs.appendFileSync(file(), lines + "\n", "utf-8");
    const newest = Math.max(...trades.map((t) => t.ts));
    const state = loadTapeState();
    if (newest > state.lastTs) saveTapeState({ lastTs: newest });
    return trades.length;
  } catch {
    return 0;
  }
}

/**
 * Reads the tape back, newest write order preserved and duplicates removed.
 *
 * Kalshi filters by whole seconds, so a poll starting where the last one ended
 * re-delivers anything that traded inside that second. Deduplicating on read
 * rather than on write keeps the recorder a simple append and makes the
 * guarantee hold for files written by older versions too.
 */
export function loadTape(): KalshiTrade[] {
  const seen = new Set<string>();
  const out: KalshiTrade[] = [];
  // Archive first, so the result is in time order across a rotation.
  for (const p of [prevPath(), file()]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as {
          i: string;
          k: string;
          t: number;
          p: number;
          c: number;
          s: number;
        };
        if (!r.k || seen.has(r.i)) continue;
        seen.add(r.i);
        out.push({
          tradeId: r.i,
          ticker: r.k,
          ts: r.t,
          price: r.p,
          count: r.c,
          takerSold: r.s === 1,
          isBlock: false,
        });
      } catch {
        // torn final line
      }
    }
  }
  return out;
}

export interface TapeInfo {
  exists: boolean;
  trades: number;
  bytes: number;
  firstTs: number | null;
  lastTs: number | null;
}

export function tapeInfo(): TapeInfo {
  const files = [prevPath(), file()].filter((p) => fs.existsSync(p));
  if (files.length === 0) {
    return { exists: false, trades: 0, bytes: 0, firstTs: null, lastTs: null };
  }
  try {
    let trades = 0;
    let bytes = 0;
    let firstTs: number | null = null;
    let lastTs: number | null = null;
    for (const p of files) {
      // Line count rather than a parse of every line: this runs on the main
      // process against files that reach 100MB, and at most the final line of
      // the active one is ever bad. Reading them at all is the expensive part,
      // which is why rotation never does.
      const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean);
      trades += lines.length;
      bytes += fs.statSync(p).size;
      firstTs ??= edgeTs(lines, "start");
      const end = edgeTs(lines, "end");
      if (end !== null) lastTs = end;
    }
    return { exists: true, trades, bytes, firstTs, lastTs };
  } catch {
    return { exists: true, trades: 0, bytes: 0, firstTs: null, lastTs: null };
  }
}

function edgeTs(lines: string[], from: "start" | "end"): number | null {
  for (let i = 0; i < lines.length; i++) {
    const line = from === "start" ? lines[i] : lines[lines.length - 1 - i];
    try {
      const r = JSON.parse(line) as { t?: number };
      if (typeof r.t === "number" && Number.isFinite(r.t)) return r.t;
    } catch {
      // keep walking inwards past a torn line
    }
  }
  return null;
}

export function clearTape(): void {
  for (const p of [file(), prevPath(), statePath()]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // the caller only cares that it tried
    }
  }
}

/**
 * Rotates by renaming rather than by rewriting.
 *
 * The active file becomes the archive and a fresh one starts, so rotation
 * costs one rename however large the file is. The previous archive is dropped
 * at that moment, which is the whole retention policy: two files, oldest goes
 * first, and no read ever happens on the trading loop's thread.
 */
function rotateIfHuge(): void {
  const p = file();
  if (!fs.existsSync(p)) return;
  if (fs.statSync(p).size < MAX_BYTES) return;
  const prev = prevPath();
  try {
    if (fs.existsSync(prev)) fs.unlinkSync(prev);
    fs.renameSync(p, prev);
  } catch {
    // A locked file means the next append lands on the oversized one. Worse
    // than rotating, better than losing the tape to an exception here.
  }
}
