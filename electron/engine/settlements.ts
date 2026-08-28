/**
 * What actually happened, as opposed to what was quoted.
 *
 * The scan recorder captures the top forty markets by volume every fifteen
 * seconds, which is enough to replay any strategy that trades the path — buy,
 * wait for a move, take a profit or a stop. It is not enough to answer the
 * simpler question underneath: when a contract was quoted at 85c, how often
 * did the thing actually happen?
 *
 * That question could not be answered from quotes alone, and the reason is
 * worth stating because it looked for a while like a market inefficiency. A
 * single Kalshi event carries something like 188 strikes; the recorder keeps
 * forty. A market drops out of the recording when its volume falls, not when
 * it resolves, so inferring outcomes from the last observed quote throws away
 * every market that went quiet before settling — a third of them, clustered
 * around 48c, which is precisely where the interesting answers live. A sample
 * that keeps only the markets that resolved loudly is not a sample of markets.
 *
 * The fix is small: remember every ticker seen, and once its close time has
 * passed, ask Kalshi what it settled at. `getMarket` has always returned
 * `result`; nothing was ever stored. One public GET per market, once, is
 * nothing against a 200-per-second read budget.
 *
 * Kept apart from the recorder because it is a different shape of data — one
 * row per market rather than one row per sweep — and because it must keep
 * working while the engine is parked. The stretch after a halt is exactly the
 * one worth studying later.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { KalshiMarket } from "./kalshi";
import { dataDir } from "./store";

const PENDING_FILE = "settle-pending.json";
const SETTLED_FILE = "settlements.jsonl";

/**
 * Where `scripts/backfill.ts` puts outcomes it collected for markets the
 * sweeper never saw.
 *
 * A separate file because the app is normally running and appending to
 * `settlements.jsonl` while the backfill runs; two processes appending to one
 * log is a torn line waiting to happen. Everything that reads the record reads
 * both, so the split is invisible downstream.
 */
export const BACKFILL_FILE = "settlements-backfill.jsonl";

/**
 * How long after the close to wait before the first lookup. Kalshi resolves a
 * market some minutes after trading ends, and asking too early spends a
 * request to be told nothing.
 */
export const SETTLE_GRACE_MS = 5 * 60_000;

/** Give up on a market that has refused to resolve for this long. */
export const ABANDON_AFTER_MS = 7 * 24 * 3_600_000;

/** And give up sooner if it keeps answering without a result. */
export const MAX_TRIES = 20;

/**
 * Requests per sweep, bounded so a backlog drains steadily rather than in a
 * burst.
 *
 * Ten was far too cautious and it became the limiting factor on every
 * measurement built on top: with markets closing faster than outcomes were
 * collected, a fair-value study found 1,015 of its 1,065 signals had no
 * recorded result — a 95% exclusion rate, which makes the surviving sample
 * evidence of nothing. Forty a minute against a documented budget of two
 * hundred reads a SECOND is still nothing, and it turns the outcome record
 * from the bottleneck back into a byproduct.
 */
export const LOOKUPS_PER_SWEEP = 40;

export interface PendingMarket {
  /** Unix seconds, as Kalshi reports it. */
  closeTs: number;
  /** Lookups spent so far, so a market that never resolves is eventually dropped. */
  tries: number;
  /** Epoch ms of the last attempt; 0 when never tried. */
  lastTry: number;
}

export type PendingMap = Record<string, PendingMarket>;

export interface Settlement {
  ticker: string;
  /** Unix seconds the market closed. */
  closeTs: number;
  /** "yes", "no", or "void" — whatever Kalshi called it. */
  result: string;
  /** Epoch ms the answer was recorded. */
  ts: number;
}

function pendingPath(): string {
  return path.join(dataDir(), PENDING_FILE);
}

function settledPath(): string {
  return path.join(dataDir(), SETTLED_FILE);
}

// ------------------------------------------------------------------ pure logic

/**
 * Whether a `result` string means the market is finished.
 *
 * An open market returns an empty string. Anything non-empty is Kalshi's
 * verdict and is stored verbatim rather than mapped to a boolean — "void"
 * is a real outcome that neither won nor lost, and flattening it to a
 * yes/no would quietly corrupt every calibration measurement built on top.
 */
export function isSettled(result: string): boolean {
  return result.trim() !== "";
}

/**
 * Which pending markets are worth a lookup right now.
 *
 * Sorted oldest close first so a backlog drains in the order the markets
 * resolved, and retries back off: a market that has already answered without a
 * result is asked again after `tries` minutes rather than on the next sweep.
 */
export function duePending(
  pending: PendingMap,
  nowMs: number,
  limit = LOOKUPS_PER_SWEEP,
): string[] {
  const due: { ticker: string; closeTs: number }[] = [];
  for (const [ticker, p] of Object.entries(pending)) {
    if (p.closeTs <= 0) continue;
    if (nowMs < p.closeTs * 1000 + SETTLE_GRACE_MS) continue;
    if (p.lastTry > 0 && nowMs - p.lastTry < p.tries * 60_000) continue;
    due.push({ ticker, closeTs: p.closeTs });
  }
  due.sort((a, b) => a.closeTs - b.closeTs);
  return due.slice(0, limit).map((d) => d.ticker);
}

/**
 * Drops markets that are never going to answer.
 *
 * Without this the pending map is append-only and grows for as long as the app
 * is installed. A market that has been asked twenty times, or whose close was a
 * week ago, is not coming back.
 */
export function prunePending(pending: PendingMap, nowMs: number): PendingMap {
  const out: PendingMap = {};
  for (const [ticker, p] of Object.entries(pending)) {
    if (p.tries >= MAX_TRIES) continue;
    if (p.closeTs > 0 && nowMs - p.closeTs * 1000 > ABANDON_AFTER_MS) continue;
    out[ticker] = p;
  }
  return out;
}

/**
 * Adds newly-seen markets to the pending map without disturbing what is
 * already there.
 *
 * A market seen on a hundred consecutive sweeps must not have its retry
 * counter reset a hundred times, so an existing entry is left exactly as it
 * is. Markets with no close time are skipped: nothing can decide when to ask
 * about them.
 */
export function addPending(pending: PendingMap, markets: KalshiMarket[]): PendingMap {
  const out = { ...pending };
  for (const m of markets) {
    if (!m.ticker || !m.close_ts || m.close_ts <= 0) continue;
    if (out[m.ticker]) continue;
    out[m.ticker] = { closeTs: m.close_ts, tries: 0, lastTry: 0 };
  }
  return out;
}

// ------------------------------------------------------------------ disk

export function loadPending(): PendingMap {
  try {
    const raw = fs.readFileSync(pendingPath(), "utf-8");
    const parsed = JSON.parse(raw) as PendingMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // Absent on first run, and a hand-mangled file should cost the outcome
    // history, not the trading session.
    return {};
  }
}

export function savePending(pending: PendingMap): void {
  try {
    fs.writeFileSync(pendingPath(), JSON.stringify(pending), "utf-8");
  } catch {
    // Same contract as the recorder: instrumentation never interrupts trading.
  }
}

export function appendSettlement(s: Settlement): void {
  try {
    fs.appendFileSync(settledPath(), JSON.stringify(s) + "\n", "utf-8");
  } catch {
    // as above
  }
}

/**
 * Every outcome recorded so far, from the live sweep and the backfill both.
 * Tolerates a torn final line, like the recorder.
 *
 * Deduped by ticker because the two files legitimately overlap: a market the
 * backfill answered can also be sitting in the pending map, and the sweeper
 * will happily record it a second time. Counting one market twice would
 * quietly double its weight in every rate the studies compute.
 */
export function loadSettlements(): Settlement[] {
  const out: Settlement[] = [];
  const seen = new Set<string>();
  for (const p of [settledPath(), path.join(dataDir(), BACKFILL_FILE)]) {
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const s = JSON.parse(line) as Settlement;
        if (typeof s.ticker !== "string" || typeof s.result !== "string") continue;
        if (seen.has(s.ticker)) continue;
        seen.add(s.ticker);
        out.push(s);
      } catch {
        // partial line from a killed process
      }
    }
  }
  return out;
}

export interface SettlementInfo {
  /** Outcomes recorded. */
  settled: number;
  /** Markets seen and still waiting for one. */
  pending: number;
  /** Of those, how many are past their close and being asked about. */
  due: number;
  firstTs: number | null;
  lastTs: number | null;
}

export function settlementInfo(nowMs = Date.now()): SettlementInfo {
  const rows = loadSettlements();
  const pending = loadPending();
  return {
    settled: rows.length,
    pending: Object.keys(pending).length,
    due: duePending(pending, nowMs, Number.MAX_SAFE_INTEGER).length,
    firstTs: rows.length > 0 ? rows[0].ts : null,
    lastTs: rows.length > 0 ? rows[rows.length - 1].ts : null,
  };
}

export function clearSettlements(): void {
  for (const p of [pendingPath(), settledPath()]) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // the caller only cares that it tried
    }
  }
}

// ------------------------------------------------------------------ the sweep

/** What the sweep needs from a client, so tests can hand it a fake. */
export type ResultLookup = (ticker: string) => Promise<{ status: string; result: string }>;

export interface SweepReport {
  asked: number;
  resolved: number;
  stillOpen: number;
  failed: number;
}

/**
 * Ask about a bounded batch of closed markets and record whatever comes back.
 *
 * Sequential rather than parallel on purpose. There is no hurry — these
 * markets have already closed and the answer will not change — and a burst of
 * concurrent requests against a shared rate budget is the kind of thing that
 * costs a trading request at the moment one matters.
 */
export async function sweepSettlements(
  lookup: ResultLookup,
  nowMs = Date.now(),
  limit = LOOKUPS_PER_SWEEP,
): Promise<SweepReport> {
  let pending = prunePending(loadPending(), nowMs);
  const due = duePending(pending, nowMs, limit);
  const report: SweepReport = { asked: 0, resolved: 0, stillOpen: 0, failed: 0 };

  for (const ticker of due) {
    const entry = pending[ticker];
    if (!entry) continue;
    report.asked++;
    try {
      const { result } = await lookup(ticker);
      if (isSettled(result)) {
        appendSettlement({ ticker, closeTs: entry.closeTs, result: result.trim(), ts: Date.now() });
        delete pending[ticker];
        report.resolved++;
      } else {
        pending[ticker] = { ...entry, tries: entry.tries + 1, lastTry: nowMs };
        report.stillOpen++;
      }
    } catch {
      // A 404 means the ticker is gone and a 5xx means try later; both are
      // handled the same way, by counting the attempt so it eventually ages
      // out rather than being retried until the heat death of the universe.
      pending[ticker] = { ...entry, tries: entry.tries + 1, lastTry: nowMs };
      report.failed++;
    }
  }

  savePending(prunePending(pending, nowMs));
  return report;
}

/** Records the markets a sweep saw, so their outcomes can be collected later. */
export function noteMarkets(markets: KalshiMarket[]): void {
  if (markets.length === 0) return;
  try {
    savePending(addPending(loadPending(), markets));
  } catch {
    // instrumentation never interrupts trading
  }
}
