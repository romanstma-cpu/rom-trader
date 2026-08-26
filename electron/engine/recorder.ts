import * as fs from "node:fs";
import * as path from "node:path";
import type { KalshiMarket } from "./kalshi";
import { dataDir } from "./store";

/**
 * Writes every market sweep to disk so strategies can be replayed later.
 *
 * The presets ship as reasoned starting points, not measured edges. Without a
 * recording the only way to compare two settings is to run each for days with
 * real money and hope the market behaved comparably — which it will not have.
 * One line of JSON per scan makes that comparison free and repeatable.
 */

const FILE = "scans.jsonl";
/** Roughly a week of 15-second scans over 40 markets. */
const MAX_BYTES = 40 * 1024 * 1024;

export interface RecordedScan {
  ts: number;
  markets: KalshiMarket[];
}

function file(): string {
  return path.join(dataDir(), FILE);
}

/** Only the fields the engine actually reads, so the file stays small. */
function slim(m: KalshiMarket): KalshiMarket {
  return {
    ticker: m.ticker,
    title: m.title,
    yes_bid: m.yes_bid,
    yes_ask: m.yes_ask,
    volume: m.volume,
    status: m.status,
    // Older recordings lack this; the close-time entry gate treats a missing
    // close as unknown and lets the market through.
    close_ts: m.close_ts,
  } as KalshiMarket;
}

export function recordScan(markets: KalshiMarket[]): void {
  if (markets.length === 0) return;
  try {
    rotateIfHuge();
    const line = JSON.stringify({ ts: Date.now(), markets: markets.map(slim) });
    fs.appendFileSync(file(), line + "\n", "utf-8");
  } catch {
    // Recording is for later analysis. Never let it interrupt trading.
  }
}

/**
 * Keeps the newest half when the file gets large.
 *
 * Truncating to the newest data rather than deleting outright means a
 * long-running bot still has something to replay, and dropping whole lines
 * avoids leaving a half-written record that would fail to parse.
 */
function rotateIfHuge(): void {
  const p = file();
  if (!fs.existsSync(p)) return;
  if (fs.statSync(p).size < MAX_BYTES) return;

  const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean);
  const keep = lines.slice(Math.floor(lines.length / 2));
  fs.writeFileSync(p, keep.join("\n") + "\n", "utf-8");
}

export interface RecordingInfo {
  exists: boolean;
  scans: number;
  bytes: number;
  firstTs: number | null;
  lastTs: number | null;
}

/**
 * Timestamp of the first parseable line walking in from one end.
 *
 * Not just `lines[0]` / `lines.at(-1)`: a killed process leaves a torn final
 * line, which loadRecording is explicitly built to tolerate. Parsing it blind
 * here threw, and the catch below reported the entire recording as empty — so
 * the one condition the format is designed to survive was the condition that
 * made a week of scans disappear from the Backtest page.
 */
function edgeTs(lines: string[], from: "start" | "end"): number | null {
  for (let i = 0; i < lines.length; i++) {
    const line = from === "start" ? lines[i] : lines[lines.length - 1 - i];
    try {
      const s = JSON.parse(line) as RecordedScan;
      if (typeof s.ts === "number" && Number.isFinite(s.ts)) return s.ts;
    } catch {
      // torn or partial; keep walking inwards
    }
  }
  return null;
}

export function recordingInfo(): RecordingInfo {
  const p = file();
  if (!fs.existsSync(p)) {
    return { exists: false, scans: 0, bytes: 0, firstTs: null, lastTs: null };
  }
  try {
    const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean);
    return {
      exists: true,
      // Line count, not a parse of every line: this runs on the main process
      // for a file that can reach 40MB, and at most the final line is ever bad.
      scans: lines.length,
      bytes: fs.statSync(p).size,
      firstTs: edgeTs(lines, "start"),
      lastTs: edgeTs(lines, "end"),
    };
  } catch {
    // The file exists but could not be read at all — a lock, a permissions
    // change. Report it as present but unmeasured rather than as absent.
    return { exists: true, scans: 0, bytes: 0, firstTs: null, lastTs: null };
  }
}

/**
 * Reads the recording back.
 *
 * A truncated final line is normal — the process can be killed mid-append — so
 * unparseable lines are skipped rather than failing the whole replay.
 */
export function loadRecording(): RecordedScan[] {
  const p = file();
  if (!fs.existsSync(p)) return [];
  const out: RecordedScan[] = [];
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const scan = JSON.parse(line) as RecordedScan;
      if (Array.isArray(scan.markets) && typeof scan.ts === "number") out.push(scan);
    } catch {
      // skip a partial line
    }
  }
  return out;
}

export function clearRecording(): void {
  try {
    const p = file();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // nothing to do; the caller only cares that it tried
  }
}

/**
 * Splits a recording at gaps in time.
 *
 * A recording pauses whenever its source does — the engine stopped, the app
 * closed overnight — and prices keep moving while nothing is written. Replayed
 * naively, the seam moves prices an hour in one "step", which reads as
 * enormous momentum and manufactures entries no live engine would ever have
 * seen. Every replay must run each contiguous stretch through its own fresh
 * engine instead.
 *
 * Segments too short to warm the momentum window are dropped: five scans is
 * the minimum from which the engine can even compute a signal.
 */
export function segmentScans(
  scans: RecordedScan[],
  maxGapMs = 180_000,
  minScans = 5,
): RecordedScan[][] {
  const out: RecordedScan[][] = [];
  let cur: RecordedScan[] = [];
  for (const s of scans) {
    if (cur.length > 0 && s.ts - cur[cur.length - 1].ts > maxGapMs) {
      out.push(cur);
      cur = [];
    }
    cur.push(s);
  }
  if (cur.length > 0) out.push(cur);
  return out.filter((seg) => seg.length >= minScans);
}
