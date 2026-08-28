/**
 * What the underlying is actually doing.
 *
 * ROM Trader has never recorded this, and its absence is why every strategy so
 * far has been a bet about the CONTRACT rather than about the thing the
 * contract resolves on. A Kalshi crypto ladder settles on BTC, and without
 * BTC's price there is no way to ask the only question with a computable
 * answer: given spot, realized volatility and the minutes left, what should
 * this strike be worth?
 *
 * Coinbase's one-minute candles are keyless and return roughly 350 minutes per
 * request, so a fresh install can compute a stable sigma immediately rather
 * than after half an hour of watching — and a study can backfill history it
 * never recorded live. Both properties matter more than they look: the first
 * means the model is usable from a cold start, the second means the model can
 * be MEASURED against settlements that have already happened.
 *
 * Kalshi settles its crypto markets on a CF Benchmarks index rather than on
 * Coinbase, so this is a close proxy and not the settlement source. For
 * judging whether a strike two hundred dollars away is reachable, a few
 * dollars of basis between venues is far below the noise; for pricing the
 * final seconds it would not be, and nothing here should be trusted that far.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { dataDir } from "./store";
import { sigma1m } from "./fairvalue";

const FILE = "spot.jsonl";
/** Well under the scan recorder's cap: four assets a minute is tiny. */
const MAX_BYTES = 20 * 1024 * 1024;

const CANDLES = "https://api.exchange.coinbase.com/products";

/**
 * The underlyings ROM's recorded universe actually contains, mapped from the
 * Kalshi series prefix to a Coinbase product.
 */
export const TRACKED: { asset: string; product: string; series: string[] }[] = [
  { asset: "BTC", product: "BTC-USD", series: ["KXBTCD", "KXBTC", "KXBTC15M"] },
  { asset: "ETH", product: "ETH-USD", series: ["KXETHD", "KXETH", "KXETH15M"] },
  { asset: "SOL", product: "SOL-USD", series: ["KXSOLD", "KXSOL", "KXSOL15M"] },
  { asset: "XRP", product: "XRP-USD", series: ["KXXRPD", "KXXRP", "KXXRP15M"] },
];

/** Which tracked asset a Kalshi ticker resolves on, or null. */
export function assetForTicker(ticker: string): string | null {
  const series = (ticker.split("-")[0] ?? "").toUpperCase();
  for (const t of TRACKED) if (t.series.includes(series)) return t.asset;
  // Fall back to a substring match so a new series variant is still recognised
  // rather than silently dropping out of the study.
  for (const t of TRACKED) if (series.includes(t.asset)) return t.asset;
  return null;
}

export interface SpotPoint {
  /** Epoch ms of the candle close. */
  ts: number;
  asset: string;
  close: number;
  /** Realized 1-minute vol at that moment, when enough history existed. */
  sigma: number | null;
}

function file(): string {
  return path.join(dataDir(), FILE);
}

/**
 * One request per asset: up to 350 one-minute candles, oldest last.
 *
 * Returns points oldest-first with a rolling sigma attached to each, so the
 * caller can append them directly and a study reading the file back gets the
 * sigma that was knowable AT that minute rather than one computed with
 * hindsight.
 */
export async function fetchCandles(product: string, asset: string): Promise<SpotPoint[]> {
  const res = await fetch(`${CANDLES}/${product}/candles?granularity=60`, {
    headers: { accept: "application/json", "user-agent": "rom-trader" },
  });
  if (!res.ok) throw new Error(`Coinbase ${product} -> ${res.status}`);
  const rows = (await res.json()) as number[][];
  // [ time, low, high, open, close, volume ], newest first.
  const asc = rows
    .filter((r) => Array.isArray(r) && r.length >= 5 && Number.isFinite(r[4]))
    .map((r) => ({ ts: r[0] * 1000, close: r[4] }))
    .sort((a, b) => a.ts - b.ts);

  const out: SpotPoint[] = [];
  for (let i = 0; i < asc.length; i++) {
    // Sigma from the closes available up to and including this minute — never
    // from later ones. A study that used future candles to price a past
    // decision would be measuring hindsight.
    const window = asc.slice(Math.max(0, i - 60), i + 1).map((p) => p.close);
    out.push({ ts: asc[i].ts, asset, close: asc[i].close, sigma: sigma1m(window) });
  }
  return out;
}

/** Newest recorded timestamp per asset, so a poll only appends what is new. */
export function lastSeen(): Map<string, number> {
  const seen = new Map<string, number>();
  for (const p of loadSpot()) {
    const cur = seen.get(p.asset) ?? 0;
    if (p.ts > cur) seen.set(p.asset, p.ts);
  }
  return seen;
}

export function recordSpot(points: SpotPoint[]): number {
  if (points.length === 0) return 0;
  try {
    rotateIfHuge();
    const lines = points.map((p) => JSON.stringify({ t: p.ts, a: p.asset, c: p.close, s: p.sigma }));
    fs.appendFileSync(file(), lines.join("\n") + "\n", "utf-8");
    return points.length;
  } catch {
    // Instrumentation never interrupts trading.
    return 0;
  }
}

export function loadSpot(): SpotPoint[] {
  const p = file();
  if (!fs.existsSync(p)) return [];
  const out: SpotPoint[] = [];
  const seen = new Set<string>();
  for (const line of fs.readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as { t: number; a: string; c: number; s: number | null };
      // Overlapping polls re-deliver the same minute; keep one per asset-minute.
      const key = `${r.a}:${r.t}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ts: r.t, asset: r.a, close: r.c, sigma: r.s ?? null });
    } catch {
      // torn final line
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export interface SpotInfo {
  exists: boolean;
  points: number;
  assets: number;
  firstTs: number | null;
  lastTs: number | null;
}

export function spotInfo(): SpotInfo {
  const p = file();
  if (!fs.existsSync(p)) return { exists: false, points: 0, assets: 0, firstTs: null, lastTs: null };
  const rows = loadSpot();
  return {
    exists: true,
    points: rows.length,
    assets: new Set(rows.map((r) => r.asset)).size,
    firstTs: rows.length ? rows[0].ts : null,
    lastTs: rows.length ? rows[rows.length - 1].ts : null,
  };
}

export function clearSpot(): void {
  try {
    const p = file();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    // the caller only cares that it tried
  }
}

/**
 * Polls every tracked asset and appends whatever is newer than what is stored.
 *
 * Injected fetcher so the suite can drive it without a network, and sequential
 * so four assets cannot become four simultaneous sockets on a shared budget.
 */
export async function sweepSpot(
  fetcher: (product: string, asset: string) => Promise<SpotPoint[]> = fetchCandles,
): Promise<number> {
  const seen = lastSeen();
  let written = 0;
  for (const t of TRACKED) {
    try {
      const points = await fetcher(t.product, t.asset);
      const since = seen.get(t.asset) ?? 0;
      written += recordSpot(points.filter((p) => p.ts > since));
    } catch {
      // One asset being unreachable must not cost the other three.
    }
  }
  return written;
}

function rotateIfHuge(): void {
  const p = file();
  if (!fs.existsSync(p)) return;
  if (fs.statSync(p).size < MAX_BYTES) return;
  const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean);
  fs.writeFileSync(p, lines.slice(Math.floor(lines.length / 2)).join("\n") + "\n", "utf-8");
}
