import * as crypto from "node:crypto";

const API_HOST = "https://api.elections.kalshi.com";
const API_BASE = "/trade-api/v2";

/**
 * Node's fetch has no default timeout. A socket that connects and then goes
 * quiet — a provider stall, a wedged proxy, a laptop that slept mid-flight —
 * leaves the promise pending forever, and the scan awaiting it never returns.
 * That matters more here than in most apps: a tick that never finishes is a
 * tick that stops running stop-losses, take-profits and settlement checks
 * while real positions are still open. Ten seconds is far longer than a
 * healthy Kalshi response and far shorter than a stuck one.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/** Reads only. Writes are never retried — see `request`. */
const MAX_READ_RETRIES = 2;
const RETRY_BASE_MS = 400;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * An HTTP error from Kalshi, with the status kept rather than only formatted
 * into the message.
 *
 * 409 is the one the engine has to act on: Kalshi returns it when an order
 * with that `client_order_id` already exists, which on a retry means the first
 * attempt landed. Told apart from a real rejection it is a success; parsed out
 * of a message string it is a substring match waiting to be wrong.
 */
export class KalshiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "KalshiApiError";
  }

  /** The order already exists at Kalshi — this submission was a duplicate. */
  get isDuplicate(): boolean {
    return this.status === 409;
  }
}

/** Retry-After is seconds or an HTTP date; fall back to exponential backoff. */
function retryDelayMs(res: Response, attempt: number): number {
  const header = res.headers.get("retry-after");
  if (header) {
    const secs = Number(header);
    if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 15_000);
    const at = Date.parse(header);
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 15_000);
  }
  return RETRY_BASE_MS * 2 ** attempt;
}

export interface KalshiMarket {
  ticker: string;
  title: string;
  yes_bid: number; // cents
  yes_ask: number; // cents
  last_price: number; // cents
  volume: number;
  volume_24h: number;
  status: string;
  /** Unix seconds when trading ends; 0 when the API did not say. */
  close_ts: number;
}

/** Raw market shape from the current Kalshi API (dollar-string prices). */
interface RawMarket {
  ticker: string;
  title: string;
  yes_bid_dollars: string;
  yes_ask_dollars: string;
  last_price_dollars: string;
  volume_fp: string;
  volume_24h_fp: string;
  status: string;
  close_time?: string; // ISO timestamp
  close_ts?: number; // unix seconds, on older API shapes
  is_provisional?: boolean;
  mve_collection_ticker?: string;
}

/**
 * One completed trade, slimmed to what a fill study needs.
 *
 * `takerSold` is the whole point of the record: true when the aggressor was
 * getting NO exposure, which on this book means selling YES into the resting
 * bids. A resting YES buy at or above this price would have been the other
 * side of it.
 */
export interface KalshiTrade {
  tradeId: string;
  ticker: string;
  /** Epoch ms. */
  ts: number;
  /** YES price in cents. */
  price: number;
  count: number;
  takerSold: boolean;
  /** Block trades matched off-book; they never touched the order book. */
  isBlock: boolean;
}

/** One price level of resting size, denominated in YES cents. */
export interface BookLevel {
  priceCents: number;
  size: number;
}

/**
 * A resting book, best-first on both sides and always in YES terms.
 *
 * `asks` is derived from Kalshi's NO bid ladder, so an ask here is what it
 * would cost to buy YES rather than a price anyone literally posted.
 */
export interface KalshiBook {
  ticker: string;
  bids: BookLevel[];
  asks: BookLevel[];
}

interface RawTrade {
  trade_id?: string;
  ticker?: string;
  count_fp?: string;
  yes_price_dollars?: string;
  taker_outcome_side?: string;
  taker_book_side?: string;
  taker_side?: string;
  created_time?: string;
  is_block_trade?: boolean;
}

function toTrade(t: RawTrade): KalshiTrade {
  // Kalshi is mid-migration here: taker_outcome_side and taker_book_side are
  // canonical, taker_side is deprecated but still sent. Read the new fields
  // first and fall back, so this keeps working through the removal rather than
  // silently reporting every trade as a buy.
  const outcome = (t.taker_outcome_side ?? t.taker_side ?? "").toLowerCase();
  const book = (t.taker_book_side ?? "").toLowerCase();
  const takerSold = outcome === "no" || book === "ask";
  return {
    tradeId: t.trade_id ?? "",
    ticker: t.ticker ?? "",
    ts: Date.parse(t.created_time ?? "") || 0,
    price: toCents(t.yes_price_dollars),
    count: parseFloat(t.count_fp ?? "0") || 0,
    takerSold,
    isBlock: t.is_block_trade === true,
  };
}

function toCents(dollars: string | undefined): number {
  const n = parseFloat(dollars ?? "0");
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Close time in unix seconds from whichever field the API offered; 0 if neither. */
function toCloseTs(m: RawMarket): number {
  if (typeof m.close_ts === "number" && Number.isFinite(m.close_ts)) return m.close_ts;
  const parsed = Date.parse(m.close_time ?? "");
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

export class KalshiClient {
  constructor(
    private apiKeyId: string = "",
    private privateKeyPem: string = "",
    /** Overridable so the suite can assert the timeout without waiting for it. */
    private timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {}

  get hasAuth(): boolean {
    return this.apiKeyId.trim() !== "" && this.privateKeyPem.trim() !== "";
  }

  private sign(method: string, path: string): Record<string, string> {
    const ts = Date.now().toString();
    const msg = ts + method + path;
    const signature = crypto
      .sign("sha256", Buffer.from(msg, "utf-8"), {
        key: this.privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
        saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
      })
      .toString("base64");
    return {
      "KALSHI-ACCESS-KEY": this.apiKeyId,
      "KALSHI-ACCESS-TIMESTAMP": ts,
      "KALSHI-ACCESS-SIGNATURE": signature,
    };
  }

  /**
   * One API call, with a hard timeout and — for reads only — bounded retry.
   *
   * Only GETs are retried. A POST here places or cancels an order, and a
   * request that timed out may still have been executed at the exchange: the
   * silence is ambiguous, not a failure. Retrying it risks a second live
   * position, which is a far worse outcome than surfacing the error and
   * letting the next scan reconcile from actual exchange state.
   */
  private async request<T>(
    method: string,
    path: string,
    opts: { auth?: boolean; body?: unknown } = {},
  ): Promise<T> {
    const fullPath = API_BASE + path;
    const retries = method === "GET" ? MAX_READ_RETRIES : 0;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= retries; attempt++) {
      // Re-sign every attempt: the signature covers a timestamp that Kalshi
      // rejects once stale, so a replayed header would fail auth on retry.
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (opts.auth) Object.assign(headers, this.sign(method, fullPath));

      let res: Response;
      try {
        res = await fetch(API_HOST + fullPath, {
          method,
          headers,
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (e) {
        // Timeout or transport failure. Both are safe to repeat for a read.
        const err = e as Error;
        lastError =
          err.name === "TimeoutError" || err.name === "AbortError"
            ? new Error(`Kalshi ${method} ${path} timed out after ${this.timeoutMs}ms`)
            : new Error(`Kalshi ${method} ${path} failed: ${err.message}`);
        if (attempt < retries) {
          await sleep(RETRY_BASE_MS * 2 ** attempt);
          continue;
        }
        throw lastError;
      }

      // Rate limiting and server faults are transient by definition.
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        await sleep(retryDelayMs(res, attempt));
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new KalshiApiError(
          `Kalshi ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`,
          res.status,
        );
      }
      return (await res.json()) as T;
    }

    throw lastError ?? new Error(`Kalshi ${method} ${path} failed`);
  }

  /**
   * Public: liquid open markets closing within the next 2 hours (the actively
   * quoted universe — crypto price ladders, weather, etc.), sorted by 24h volume.
   */
  async getActiveMarkets(limit = 40): Promise<KalshiMarket[]> {
    const now = Math.floor(Date.now() / 1000);
    // The API caps a page at 1000 rows in whatever order it prefers, so a
    // single page made "top forty by volume" really mean "top forty of
    // whichever thousand came back first". A few cursor-follows make the
    // sort honest; the cap keeps a busy day from turning one scan into six
    // requests.
    const raw: RawMarket[] = [];
    let cursor = "";
    for (let page = 0; page < 3; page++) {
      const data = await this.request<{ markets: RawMarket[]; cursor?: string }>(
        "GET",
        `/markets?limit=1000&status=open&min_close_ts=${now}&max_close_ts=${now + 7200}` +
          (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""),
      );
      const batch = data.markets ?? [];
      raw.push(...batch);
      cursor = data.cursor ?? "";
      if (cursor === "" || batch.length < 1000) break;
    }
    return raw
      .filter((m) => !m.is_provisional && !m.mve_collection_ticker)
      .map(
        (m): KalshiMarket => ({
          ticker: m.ticker,
          title: m.title,
          yes_bid: toCents(m.yes_bid_dollars),
          yes_ask: toCents(m.yes_ask_dollars),
          last_price: toCents(m.last_price_dollars),
          volume: parseFloat(m.volume_fp ?? "0") || 0,
          volume_24h: parseFloat(m.volume_24h_fp ?? "0") || 0,
          status: m.status,
          close_ts: toCloseTs(m),
        }),
      )
      .filter((m) => m.yes_bid > 0 && m.yes_ask > 0 && m.yes_ask < 100)
      .sort((a, b) => b.volume_24h - a.volume_24h)
      .slice(0, limit);
  }

  /**
   * Public: one market by ticker, whatever its status.
   *
   * The sweep only sees the top of the volume table, but a held position's
   * market can slide off it — or close and settle — while the position is
   * still open. This is how the engine keeps eyes on what it holds.
   */
  async getMarket(
    ticker: string,
  ): Promise<{ market: KalshiMarket; status: string; result: string }> {
    const data = await this.request<{ market: RawMarket & { result?: string } }>(
      "GET",
      `/markets/${encodeURIComponent(ticker)}`,
    );
    const m = data.market ?? ({} as RawMarket & { result?: string });
    return {
      market: {
        ticker: m.ticker ?? ticker,
        title: m.title ?? ticker,
        yes_bid: toCents(m.yes_bid_dollars),
        yes_ask: toCents(m.yes_ask_dollars),
        last_price: toCents(m.last_price_dollars),
        volume: parseFloat(m.volume_fp ?? "0") || 0,
        volume_24h: parseFloat(m.volume_24h_fp ?? "0") || 0,
        status: m.status ?? "unknown",
        close_ts: toCloseTs(m),
      },
      status: m.status ?? "unknown",
      result: m.result ?? "",
    };
  }

  /**
   * Public: completed trades across every market, newest-first, from `minTs`.
   *
   * Quotes say what a market was offered at; only the tape says what actually
   * changed hands. That distinction decides whether a resting order strategy
   * is measurable at all. A top-of-book snapshot showing the bid drop from 85c
   * to 84c is consistent with two opposite worlds — somebody sold into the 85c
   * bid, or everybody resting at 85c simply cancelled — and those worlds have
   * opposite meanings for a bid resting there. `taker_outcome_side` settles it:
   * "no" means the aggressor was positioned for NO, which on a YES-priced book
   * is a seller hitting the bid, which is the trade that would have filled us.
   *
   * Filtered per ticker, which is not the obvious choice and is the right one.
   * The unfiltered feed looked cheaper — one request instead of forty — until
   * it was measured: a full thousand-row page covered ten seconds of exchange
   * time, so Kalshi prints on the order of a hundred trades a second across
   * everything it lists. Keeping up unfiltered means paging continuously and
   * discarding almost all of it, on the order of a gigabyte a day to keep a
   * few megabytes. Forty small requests every thirty seconds is 1.3 a second
   * against a budget of two hundred.
   */
  async getTrades(
    ticker: string,
    minTs: number,
    limit = 1000,
  ): Promise<{ trades: KalshiTrade[]; cursor: string }> {
    const data = await this.request<{ trades?: RawTrade[]; cursor?: string }>(
      "GET",
      `/markets/trades?limit=${limit}&min_ts=${Math.floor(minTs)}` +
        `&ticker=${encodeURIComponent(ticker)}`,
    );
    return {
      trades: (data.trades ?? []).map(toTrade),
      cursor: data.cursor ?? "",
    };
  }

  /**
   * Public: the resting order book, normalised to YES cents.
   *
   * The app has only ever recorded the touch — one bid, one ask — which says
   * what a trade would cost but nothing about what is standing behind it. A 1c
   * spread with 60 contracts resting and a 1c spread with 6,000 are the same
   * quote and very different markets, and the difference is invisible to every
   * study run so far.
   *
   * Kalshi returns two BID ladders, not a bid side and an ask side:
   * `yes_dollars` is people bidding for YES, `no_dollars` is people bidding for
   * NO, both ascending so the touch is the LAST element. A NO bid at 21c is
   * somebody offering YES at 79c, so the NO ladder is mirrored to give a single
   * book denominated in YES cents. Getting that backwards would invert the
   * imbalance the whole study is meant to measure, which is the kind of error
   * that produces a confident, meaningless answer.
   */
  async getOrderbook(ticker: string, depth = 10): Promise<KalshiBook> {
    const data = await this.request<{
      orderbook_fp?: { yes_dollars?: [string, string][]; no_dollars?: [string, string][] };
      orderbook?: { yes?: [number, number][]; no?: [number, number][] };
    }>("GET", `/markets/${encodeURIComponent(ticker)}/orderbook?depth=${depth}`);

    const fp = data.orderbook_fp;
    const legacy = data.orderbook;
    // Dollar strings are canonical; the integer-cent shape is still served to
    // older clients and costs three lines to keep working.
    const yesRaw: BookLevel[] = fp?.yes_dollars
      ? fp.yes_dollars.map(([p, s]) => ({ priceCents: toCents(p), size: parseFloat(s) || 0 }))
      : (legacy?.yes ?? []).map(([p, s]) => ({ priceCents: p, size: s }));
    const noRaw: BookLevel[] = fp?.no_dollars
      ? fp.no_dollars.map(([p, s]) => ({ priceCents: toCents(p), size: parseFloat(s) || 0 }))
      : (legacy?.no ?? []).map(([p, s]) => ({ priceCents: p, size: s }));

    const clean = (l: BookLevel): boolean =>
      Number.isFinite(l.priceCents) && l.priceCents > 0 && l.priceCents < 100 && l.size > 0;

    return {
      ticker,
      // Best first on both sides: highest bid, lowest ask.
      bids: yesRaw.filter(clean).sort((a, b) => b.priceCents - a.priceCents),
      asks: noRaw
        .filter(clean)
        .map((l) => ({ priceCents: 100 - l.priceCents, size: l.size }))
        .sort((a, b) => a.priceCents - b.priceCents),
    };
  }

  /** Auth: account balance in USD. */
  async getBalance(): Promise<number> {
    const data = await this.request<{ balance: number }>("GET", "/portfolio/balance", {
      auth: true,
    });
    return (data.balance ?? 0) / 100;
  }

  /**
   * Round-trips one authenticated call so the user can confirm their keys work
   * before switching on live mode. Never throws — the failure text is the point.
   */
  async testConnection(): Promise<{ ok: boolean; balanceUsd?: number; message: string }> {
    if (!this.hasAuth) {
      return { ok: false, message: "Enter both an API key ID and a private key first." };
    }
    try {
      crypto.createPrivateKey(this.privateKeyPem);
    } catch {
      return {
        ok: false,
        message:
          "That private key could not be parsed. Paste the whole PEM block, including the " +
          "BEGIN and END lines.",
      };
    }
    try {
      const balanceUsd = await this.getBalance();
      return {
        ok: true,
        balanceUsd,
        message: `Connected. Kalshi reports a balance of $${balanceUsd.toFixed(2)}.`,
      };
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("401") || msg.includes("403")) {
        return {
          ok: false,
          message: "Kalshi rejected these credentials. Check the key ID matches the private key.",
        };
      }
      return { ok: false, message: msg };
    }
  }

  /**
   * Auth: place a market order. Used only in live mode.
   *
   * `clientOrderId` is Kalshi's deduplication key: submitting the same one
   * twice is refused with a 409 instead of opening a second position. A caller
   * that may have to re-send an order — because the first attempt's answer was
   * lost rather than refused — must mint the id once for the *intent* and pass
   * the same one every attempt. Left out, each call gets a fresh id, which is
   * right for a one-shot order and useless for a retry.
   */
  async placeOrder(params: {
    ticker: string;
    side: "yes" | "no";
    action: "buy" | "sell";
    count: number;
    buyMaxCostCents?: number;
    clientOrderId?: string;
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      ticker: params.ticker,
      client_order_id: params.clientOrderId ?? crypto.randomUUID(),
      side: params.side,
      action: params.action,
      count: params.count,
      type: "market",
    };
    if (params.action === "buy" && params.buyMaxCostCents !== undefined) {
      body.buy_max_cost = params.buyMaxCostCents;
    }
    return this.request("POST", "/portfolio/orders", { auth: true, body });
  }

  /**
   * Auth: rest a YES buy at a limit price and return the order id.
   *
   * post_only makes Kalshi reject the order outright if it would cross the
   * book: the entire point of a maker entry is not paying the taker fee, and
   * an order that fills instantly at the ask has quietly become the thing it
   * was meant to avoid.
   */
  async placeLimitBuy(
    ticker: string,
    count: number,
    yesPriceCents: number,
    clientOrderId?: string,
  ): Promise<string> {
    const data = await this.request<{ order?: { order_id?: string } }>(
      "POST",
      "/portfolio/orders",
      {
        auth: true,
        body: {
          ticker,
          client_order_id: clientOrderId ?? crypto.randomUUID(),
          side: "yes",
          action: "buy",
          count,
          type: "limit",
          yes_price: yesPriceCents,
          post_only: true,
        },
      },
    );
    const id = data.order?.order_id;
    if (!id) throw new Error("Kalshi accepted the order but returned no order id.");
    return id;
  }

  /**
   * Auth: rest a YES sell at a limit price and return the order id.
   *
   * The maker take-profit: post_only for the same reason as the entry side —
   * an exit that crosses the book has become the taker fee it existed to
   * avoid, and the caller would rather fall back to its market exit.
   */
  async placeLimitSell(
    ticker: string,
    count: number,
    yesPriceCents: number,
    clientOrderId?: string,
  ): Promise<string> {
    const data = await this.request<{ order?: { order_id?: string } }>(
      "POST",
      "/portfolio/orders",
      {
        auth: true,
        body: {
          ticker,
          client_order_id: clientOrderId ?? crypto.randomUUID(),
          side: "yes",
          action: "sell",
          count,
          type: "limit",
          yes_price: yesPriceCents,
          post_only: true,
        },
      },
    );
    const id = data.order?.order_id;
    if (!id) throw new Error("Kalshi accepted the order but returned no order id.");
    return id;
  }

  /**
   * Auth: how a resting order is doing. Parsed defensively — the count fields
   * have shifted names across API revisions, and a fill mistaken for a
   * cancellation would strand a real position untracked.
   */
  async getOrder(orderId: string): Promise<{ status: string; filledCount: number }> {
    const data = await this.request<{
      order?: {
        status?: string;
        initial_count?: number;
        remaining_count?: number;
        count?: number;
        fill_count?: number;
      };
    }>("GET", `/portfolio/orders/${orderId}`, { auth: true });
    const o = data.order ?? {};
    const status = o.status ?? "unknown";
    const initial = o.initial_count ?? o.count ?? 0;
    let filled = o.fill_count ?? (o.remaining_count !== undefined ? initial - o.remaining_count : 0);
    if (status === "executed" && filled <= 0) filled = initial;
    return { status, filledCount: Math.max(0, filled) };
  }

  /** Auth: cancel a resting order. Throws if Kalshi refuses (e.g. already filled). */
  async cancelOrder(orderId: string): Promise<void> {
    await this.request("DELETE", `/portfolio/orders/${orderId}`, { auth: true });
  }
}
