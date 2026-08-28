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
  return closesToPoints(parseCandles(await res.json()), asset);
}

/** [ time, low, high, open, close, volume ], newest first, to ascending closes. */
function parseCandles(body: unknown): { ts: number; close: number }[] {
  const rows = Array.isArray(body) ? (body as number[][]) : [];
  return rows
    .filter((r) => Array.isArray(r) && r.length >= 5 && Number.isFinite(r[4]))
    .map((r) => ({ ts: r[0] * 1000, close: r[4] }))
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Attach the sigma that was knowable AT each minute.
 *
 * Computed over the merged series rather than per request, which is the whole
 * reason the paging function collects raw closes before calling this. Slicing
 * a long history into chunks and computing sigma inside each one would leave
 * the first hour of every chunk with a truncated window — a sawtooth of
 * artificially low volatility, recurring every 300 minutes, that would make
 * the model most confident exactly where it knew least.
 */
function closesToPoints(asc: { ts: number; close: number }[], asset: string): SpotPoint[] {
  const out: SpotPoint[] = [];
  for (let i = 0; i < asc.length; i++) {
    // Never from later closes. A study that used future candles to price a
    // past decision would be measuring hindsight.
    const window = asc.slice(Math.max(0, i - 60), i + 1).map((p) => p.close);
    out.push({ ts: asc[i].ts, asset, close: asc[i].close, sigma: sigma1m(window) });
  }
  return out;
}

/** Coinbase caps a start/end candle request at 300 rows. */
const PAGE_MINUTES = 300;

/** Public endpoint allows ~10 req/s; this stays an order of magnitude under. */
const PAGE_DELAY_MS = 120;

/** Refuse to page forever if the endpoint starts returning overlapping windows. */
const MAX_PAGES = 60;

/**
 * Spot history reaching as far back as asked, by walking the endpoint
 * backwards.
 *
 * The single-request version returns 350 minutes, which is under six hours —
 * and that turned out to be the binding constraint on every measurement built
 * on it. The fair-value study could only price markets from the last six
 * hours, which are precisely the markets that have NOT settled yet, so 97.6%
 * of its population had no outcome and the eight events that survived could
 * not answer anything. Meanwhile five days of recorded scans sat in the
 * archive, every one of them long since resolved.
 *
 * Paging turns that around: the further back the history reaches, the more of
 * the sample has a known outcome. The exclusion rate and the sample size move
 * in opposite directions for once.
 */
export async function fetchCandleHistory(
  product: string,
  asset: string,
  sinceMs: number,
  now = Date.now(),
): Promise<SpotPoint[]> {
  const merged = new Map<number, number>();
  let end = now;

  for (let page = 0; page < MAX_PAGES && end > sinceMs; page++) {
    const start = Math.max(sinceMs, end - PAGE_MINUTES * 60_000);
    const url =
      `${CANDLES}/${product}/candles?granularity=60` +
      `&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "rom-trader" },
    });
    if (!res.ok) {
      // A failed page mid-walk still leaves usable history behind it; throwing
      // away four days because the fifth rate-limited would be worse than
      // returning what arrived.
      if (merged.size === 0) throw new Error(`Coinbase ${product} -> ${res.status}`);
      break;
    }
    const rows = parseCandles(await res.json());
    if (rows.length === 0) break;

    const before = merged.size;
    for (const r of rows) merged.set(r.ts, r.close);
    // No new minutes means the endpoint is clamping the window; walking
    // further would spend requests to receive the same rows again.
    if (merged.size === before) break;

    end = rows[0].ts - 60_000;
    if (PAGE_DELAY_MS > 0) await new Promise((r) => setTimeout(r, PAGE_DELAY_MS));
  }

  const asc = [...merged.entries()]
    .map(([ts, close]) => ({ ts, close }))
    .sort((a, b) => a.ts - b.ts);
  return closesToPoints(asc, asset);
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
