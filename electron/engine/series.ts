/**
 * Time-series helpers shared by the engine and the renderer.
 *
 * Pure arithmetic with no imports, so the chart in `src/ui.tsx` can use the
 * same rule the replay engine does rather than a second copy of it that drifts
 * — the same reason `fees.ts` is shared rather than reimplemented.
 */

/**
 * The longest pause that still counts as continuous.
 *
 * Equity is appended once per scan, so points are seconds apart while the
 * engine runs. Three minutes is many missed scans at any configurable
 * interval, and it is the same threshold `segmentScans` uses to cut a
 * recording into stretches that actually happened.
 */
export const CONTINUOUS_GAP_MS = 180_000;

/**
 * Splits a series wherever it stops for longer than `gapMs`.
 *
 * A chart that joins the last point before a pause to the first point after it
 * draws a line through time nobody observed. On the author's own equity file
 * that produced a confident diagonal climbing $91.31 to $100 across a
 * thirty-hour gap — a 9.5% profit invented by linear interpolation over a
 * night the bot spent switched off. Every stretch gets its own line instead.
 */
export function splitAtGaps<T extends { ts: number }>(
  points: T[],
  gapMs = CONTINUOUS_GAP_MS,
): T[][] {
  const out: T[][] = [];
  let run: T[] = [];
  for (const p of points) {
    if (run.length > 0 && p.ts - run[run.length - 1].ts > gapMs) {
      out.push(run);
      run = [];
    }
    run.push(p);
  }
  if (run.length > 0) out.push(run);
  return out;
}

/**
 * How much time the series actually covers, ignoring the holes.
 *
 * The difference between this and (last − first) is the difference between
 * "the engine traded for three hours" and "the chart is forty-one hours wide",
 * and only the first is a fact about trading.
 */
export function sampledMs<T extends { ts: number }>(
  points: T[],
  gapMs = CONTINUOUS_GAP_MS,
): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.min(points[i].ts - points[i - 1].ts, gapMs);
  }
  return total;
}
