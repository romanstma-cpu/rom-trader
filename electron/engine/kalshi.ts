import * as crypto from "node:crypto";

const API_HOST = "https://api.elections.kalshi.com";
const API_BASE = "/trade-api/v2";

export interface KalshiMarket {
  ticker: string;
  title: string;
  yes_bid: number; // cents
  yes_ask: number; // cents
  last_price: number; // cents
  volume: number;
  volume_24h: number;
  status: string;
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
  is_provisional?: boolean;
  mve_collection_ticker?: string;
}

function toCents(dollars: string | undefined): number {
  const n = parseFloat(dollars ?? "0");
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export class KalshiClient {
  constructor(
    private apiKeyId: string = "",
    private privateKeyPem: string = "",
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

  private async request<T>(
    method: string,
    path: string,
    opts: { auth?: boolean; body?: unknown } = {},
  ): Promise<T> {
    const fullPath = API_BASE + path;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (opts.auth) Object.assign(headers, this.sign(method, fullPath));
    const res = await fetch(API_HOST + fullPath, {
      method,
      headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Kalshi ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as T;
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
      },
      status: m.status ?? "unknown",
      result: m.result ?? "",
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

  /** Auth: place a market order. Used only in live mode. */
  async placeOrder(params: {
    ticker: string;
    side: "yes" | "no";
    action: "buy" | "sell";
    count: number;
    buyMaxCostCents?: number;
  }): Promise<unknown> {
    const body: Record<string, unknown> = {
      ticker: params.ticker,
      client_order_id: crypto.randomUUID(),
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
  async placeLimitBuy(ticker: string, count: number, yesPriceCents: number): Promise<string> {
    const data = await this.request<{ order?: { order_id?: string } }>(
      "POST",
      "/portfolio/orders",
      {
        auth: true,
        body: {
          ticker,
          client_order_id: crypto.randomUUID(),
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
