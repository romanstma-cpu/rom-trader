/**
 * The calibration study, as something the app can run rather than something a
 * developer can run.
 *
 * Everything this project learned lives in `scripts/` — clone the repo, install
 * esbuild, bundle, run node. Somebody who downloaded the installer gets none of
 * it. What ships is a bot whose strategies were measured and lost; what was
 * BUILT is the thing that measured them, and that is the more useful half.
 *
 * So this is the first study to move inside. It answers the question underneath
 * every strategy — is this book mispriced at all? — using only the two streams
 * the app already records for itself: quotes from the sweep, outcomes from the
 * settlement sweeper. No spot, no tape, no API key, no network.
 *
 * WHAT IT REFUSES TO DO
 *
 * One observation per market, at a fixed horizon before close. Using every
 * recorded quote would let a market that stayed liquid for six hours outvote
 * one that went quiet, and would count a single outcome hundreds of times.
 * Using the last quote before close biases toward the extremes, because a
 * market drifts toward 0 or 100 as it resolves.
 *
 * Intervals are event-clustered. It matters more here than anywhere else in the
 * app: the strikes of one event land in DIFFERENT price buckets, so one BTC
 * move fills the 90c bucket with winners and the 10c bucket with losers at the
 * same instant, and none of that is independent evidence.
 *
 * Expected value is computed per row at the price actually quoted and never
 * from a bucket average, because averaging the price and then pricing the
 * average smooths away exactly the fee non-linearity that decides whether a
 * deep favourite is worth buying.
 *
 * And a band is only ever called tradeable if its whole clustered interval
 * clears zero AND it rests on enough independent events to size against. The
 * sizer would refuse anything less, and a study that recommends what the sizer
 * refuses is a study arguing with itself.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { KalshiMarket } from "./kalshi";
import type { RecordedScan } from "./recorder";
import { oneLotFeeCents } from "./fairvalue";
import { clusterBootstrapCI, eventOf, groupByEvent } from "./skill";
import { MIN_EVENTS_TO_SIZE } from "./sizing";
import { dataDir } from "./store";
import { loadSettlements } from "./settlements";

/** How far from the requested horizon an observation may sit and still count. */
export const HORIZON_TOLERANCE_MS = 5 * 60_000;

/** Bootstrap resamples. Enough to be stable, few enough to stay interactive. */
const ITERATIONS = 2000;

/**
 * Price buckets, deliberately fine at both ends.
 *
 * The favourite-longshot bias lives in the tails, and a uniform grid would blur
 * 95-99c — where the fee is largest relative to the payout — into the same
 * bucket as 90c.
 */
export const CALIBRATION_BANDS: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  { label: "1-5c", lo: 1, hi: 5 },
  { label: "5-10c", lo: 5, hi: 10 },
  { label: "10-20c", lo: 10, hi: 20 },
  { label: "20-30c", lo: 20, hi: 30 },
  { label: "30-40c", lo: 30, hi: 40 },
  { label: "40-50c", lo: 40, hi: 50 },
  { label: "50-60c", lo: 50, hi: 60 },
  { label: "60-70c", lo: 60, hi: 70 },
  { label: "70-80c", lo: 70, hi: 80 },
  { label: "80-90c", lo: 80, hi: 90 },
  { label: "90-95c", lo: 90, hi: 95 },
  { label: "95-99c", lo: 95, hi: 100 },
];

/** One market's quote at the decision moment, and what it settled at. */
export interface CalibrationObs {
  ticker: string;
  event: string;
  bid: number;
  ask: number;
  mid: number;
  /** 1 if YES settled, 0 if NO. */
  outcome: 0 | 1;
}

export interface CalibrationBand {
  label: string;
  n: number;
  events: number;
  /** Mean quoted mid in the band, cents. */
  meanQuote: number;
  /** Fraction that actually settled YES. */
  realised: number;
  /** Realised minus quoted, in percentage points. */
  gapPp: number;
  realisedCI: [number, number];
  /** Net cents per contract from buying that side, fee included. */
  buyYes: number;
  buyYesCI: [number, number];
  buyNo: number;
  buyNoCI: [number, number];
}

export interface CalibrationReport {
  markets: number;
  events: number;
  horizonMinutes: number;
  /** Fraction of the sample that settled YES — the venue's structural tilt. */
  yesRate: number;
  bands: CalibrationBand[];
  /** Bands whose clustered interval clears zero on enough events to act on. */
  tradeable: string[];
  /** Bands that cleared zero on too few events to be worth naming as findings. */
  suppressed: string[];
  verdict: string;
}

const fee = (c: number): number => oneLotFeeCents(c, "cent");

/** Net cents from buying YES at the ask, one lot, fee included. */
export function yesPnlCents(o: CalibrationObs): number {
  return (o.outcome === 1 ? 100 : 0) - o.ask - fee(o.ask);
}

/** Net cents from buying NO at its own ask, one lot, fee included. */
export function noPnlCents(o: CalibrationObs): number {
  const cost = 100 - o.bid;
  return (o.outcome === 0 ? 100 : 0) - cost - fee(cost);
}

function clusteredMean(rows: CalibrationObs[], values: number[], seed: number): [number, number] {
  return clusterBootstrapCI(
    groupByEvent(rows, (r) => r.event),
    (idx) => {
      let s = 0;
      for (const i of idx) s += values[i];
      return s / idx.length;
    },
    ITERATIONS,
    0.05,
    seed,
  );
}

/**
 * The whole scorecard from a set of observations.
 *
 * Pure, so the suite can hand it a constructed book and assert the arithmetic
 * without touching a disk or a network.
 */
export function calibrate(
  obs: CalibrationObs[],
  horizonMinutes: number,
  seed = 12345,
): CalibrationReport {
  if (obs.length === 0) {
    return {
      markets: 0,
      events: 0,
      horizonMinutes,
      yesRate: 0,
      bands: [],
      tradeable: [],
      suppressed: [],
      verdict:
        "Nothing recorded yet at this horizon. Leave ROM Trader running with " +
        "recording on — a market has to close before it can tell you anything.",
    };
  }

  const bands: CalibrationBand[] = [];
  const tradeable: string[] = [];
  const suppressed: string[] = [];

  for (const b of CALIBRATION_BANDS) {
    const rows = obs.filter((o) => o.mid >= b.lo && o.mid < b.hi);
    if (rows.length === 0) continue;
    const events = new Set(rows.map((r) => r.event)).size;
    const outcomes = rows.map((r) => r.outcome as number);
    const yesV = rows.map(yesPnlCents);
    const noV = rows.map(noPnlCents);
    const meanQuote = rows.reduce((s, r) => s + r.mid, 0) / rows.length;
    const realised = outcomes.reduce((a, c) => a + c, 0) / rows.length;
    const buyYes = yesV.reduce((a, c) => a + c, 0) / rows.length;
    const buyNo = noV.reduce((a, c) => a + c, 0) / rows.length;
    const buyYesCI = clusteredMean(rows, yesV, seed);
    const buyNoCI = clusteredMean(rows, noV, seed);

    bands.push({
      label: b.label,
      n: rows.length,
      events,
      meanQuote,
      realised,
      gapPp: (realised - meanQuote / 100) * 100,
      realisedCI: clusteredMean(rows, outcomes, seed),
      buyYes,
      buyYesCI,
      buyNo,
      buyNoCI,
    });

    for (const [side, mean, ci] of [
      ["Buy YES", buyYes, buyYesCI],
      ["Buy NO", buyNo, buyNoCI],
    ] as const) {
      if (ci[0] <= 0) continue;
      const line = `${side} at ${b.label} — ${mean >= 0 ? "+" : ""}${mean.toFixed(2)}c per contract, worst case ${ci[0] >= 0 ? "+" : ""}${ci[0].toFixed(2)}c`;
      if (events < MIN_EVENTS_TO_SIZE) {
        suppressed.push(`${side} at ${b.label} cleared zero on only ${events} events`);
      } else {
        tradeable.push(line);
      }
    }
  }

  const events = new Set(obs.map((o) => o.event)).size;
  const yesRate = obs.filter((o) => o.outcome === 1).length / obs.length;

  let verdict: string;
  if (events < MIN_EVENTS_TO_SIZE) {
    verdict =
      `Only ${events} independent events so far. Sibling strikes of one ladder ` +
      `settle together, so they count once — keep recording and check back.`;
  } else if (tradeable.length === 0) {
    verdict =
      `No price band is profitable after fees. The book may be mispriced, but ` +
      `not by more than the spread and the fee cost to act on it — which is the ` +
      `ordinary condition of a market that works.`;
  } else {
    verdict =
      `${tradeable.length} band${tradeable.length === 1 ? "" : "s"} cleared zero on ` +
      `${MIN_EVENTS_TO_SIZE}+ events. Treat that as a hypothesis, not a finding: ` +
      `re-run at another horizon before believing it.`;
  }

  return { markets: obs.length, events, horizonMinutes, yesRate, bands, tradeable, suppressed, verdict };
}

// ------------------------------------------------------------------ collection

/** Progress while the recording is read, so a long pass is not a frozen window. */
export type CalibrationProgress = (p: { file: string; index: number; total: number }) => void;

interface Best {
  offBy: number;
  obs: CalibrationObs;
}

/**
 * One two-sided quote per settled market, nearest the requested horizon.
 *
 * Streamed line by line: the recording reaches tens of megabytes within days
 * and parsing it into one array would spike memory inside a process that is
 * also holding open positions.
 */
export async function collectObservations(
  horizonMinutes: number,
  onProgress?: CalibrationProgress,
): Promise<CalibrationObs[]> {
  const settled = new Map<string, 0 | 1>();
  for (const s of loadSettlements()) {
    const r = (s.result ?? "").trim().toLowerCase();
    // "void" and "scalar" are neither a win nor a loss; mapping either to a
    // side would corrupt the exact rate this study exists to measure.
    if (r === "yes") settled.set(s.ticker, 1);
    else if (r === "no") settled.set(s.ticker, 0);
  }
  if (settled.size === 0) return [];

  const horizonMs = horizonMinutes * 60_000;
  const best = new Map<string, Best>();

  let files: string[] = [];
  try {
    files = fs
      .readdirSync(dataDir())
      .filter((f) => f === "scans.jsonl" || /^scans-archive-.*\.jsonl$/.test(f))
      .map((f) => path.join(dataDir(), f));
  } catch {
    return [];
  }

  for (let i = 0; i < files.length; i++) {
    onProgress?.({ file: path.basename(files[i]), index: i, total: files.length });
    let rl: readline.Interface;
    try {
      rl = readline.createInterface({
        input: fs.createReadStream(files[i]),
        crlfDelay: Infinity,
      });
    } catch {
      continue;
    }
    for await (const line of rl) {
      if (!line.trim()) continue;
      let scan: RecordedScan;
      try {
        scan = JSON.parse(line) as RecordedScan;
      } catch {
        continue; // torn line from a killed process
      }
      if (!Array.isArray(scan.markets)) continue;
      for (const m of scan.markets as KalshiMarket[]) {
        const outcome = settled.get(m.ticker);
        if (outcome === undefined) continue;
        if (!m.close_ts || m.close_ts <= 0) continue;
        // A one-sided book is not a price. The sweep filters these out now, but
        // older recordings predate that guarantee.
        if (!(m.yes_bid > 0 && m.yes_ask > 0 && m.yes_ask < 100)) continue;
        const offBy = Math.abs(scan.ts - (m.close_ts * 1000 - horizonMs));
        if (offBy > HORIZON_TOLERANCE_MS) continue;
        const prev = best.get(m.ticker);
        if (prev && prev.offBy <= offBy) continue;
        best.set(m.ticker, {
          offBy,
          obs: {
            ticker: m.ticker,
            event: eventOf(m.ticker),
            bid: m.yes_bid,
            ask: m.yes_ask,
            mid: (m.yes_bid + m.yes_ask) / 2,
            outcome,
          },
        });
      }
    }
  }

  return [...best.values()].map((b) => b.obs);
}

/** Collect and score in one call — what the IPC handler wants. */
export async function runCalibration(
  horizonMinutes = 30,
  onProgress?: CalibrationProgress,
): Promise<CalibrationReport> {
  return calibrate(await collectObservations(horizonMinutes, onProgress), horizonMinutes);
}
