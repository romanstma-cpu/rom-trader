import { Fragment, useEffect, useMemo, useState } from "react";
import type { Signal } from "../types";
import { Narrate, timeAgo, useToast } from "../ui";

/**
 * A Kalshi market ticker is SERIES-EVENTCODE-STRIKE, e.g.
 * KXBTCD-26AUG2621-T78899.99. Everything up to the last dash identifies the
 * event; what follows is the strike.
 *
 * That last part is the only thing that differs between sibling rows, and it
 * used to be buried in the middle of a 24-character monospace string whose
 * first 22 characters were identical to the row above — with a human-readable
 * subtitle that was identical too. Eight strikes of one Bitcoin ladder read as
 * eight indistinguishable rows on the screen the site calls "the bot showing
 * its work".
 *
 * The `event` half must stay identical to `skill.eventOf`, because the groups
 * drawn here are the ladders `maxPositionsPerEvent` and the loss lockout act
 * on — a group heading that says "5 markets · 2 qualified" is a claim about
 * which rows compete for one slot. Kept as its own function rather than
 * imported because the renderer does not reach into `electron/`, and because
 * this one needs the outcome half too. The engine's copy is what drifted:
 * it read the event out of a `-T…`/`-B…` strike suffix until 1.13.2, so this
 * page grouped five KXCRYPTOLEAD15M outcomes under one heading while the
 * engine happily held positions in several of them. The page was right.
 */
function splitTicker(ticker: string): { event: string; strike: string } {
  const i = ticker.lastIndexOf("-");
  if (i <= 0) return { event: ticker, strike: "" };
  return { event: ticker.slice(0, i), strike: ticker.slice(i + 1) };
}

/**
 * A market with only one outcome carries a `00` placeholder where a ladder
 * carries its strike: KXETH15M-26AUG240600-00 is "ETH price up in next 15
 * mins?", which has no strike at all. Formatted as a number that read as a
 * strike of zero — a price this market will never trade at, sitting in the
 * column a trader scans for the line being bet on. Second most common ticker
 * shape in the recording, so it is not a corner case.
 */
function isPlaceholder(strike: string): boolean {
  return strike === "" || /^0+$/.test(strike);
}

/**
 * T78899.99 -> "T 78,899.99". The prefix is Kalshi's, so it is shown rather
 * than translated into a claim about what the strike means.
 *
 * Returns null when the segment is not a strike. Plenty are not: match markets
 * end in a team code (NEG, KUA, TIE) and "highest return this week" markets end
 * in a ticker symbol (BTC, ETH). Those are passed through untouched — they are
 * the one thing that distinguishes sibling rows, which is exactly what this
 * column is for.
 */
function formatStrike(strike: string): string | null {
  if (isPlaceholder(strike)) return null;
  const m = strike.match(/^([A-Za-z]*)([\d.]+)$/);
  if (!m) return strike;
  const n = Number(m[2]);
  if (!Number.isFinite(n)) return strike;
  const num = n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return m[1] ? `${m[1].toUpperCase()} ${num}` : num;
}

/** Numeric where possible, so strikes ladder in order rather than lexically —
 *  otherwise 79099.99 sorts above 78899.99 because "9" precedes "8". */
function strikeValue(strike: string): number {
  if (isPlaceholder(strike)) return Number.POSITIVE_INFINITY;
  const m = strike.match(/[\d.]+/);
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

interface Group {
  event: string;
  title: string;
  rows: Signal[];
  qualified: number;
  /** Best position in the incoming order, which is already strongest-first. */
  rank: number;
  /** How many rows actually carry a strike — a one-outcome market has none. */
  strikes: number;
}

/**
 * What the last sweep actually decided, in one paragraph.
 *
 * The table below it is complete and, at forty rows across a dozen refusal
 * reasons, answers "why is nothing trading" only to someone willing to count.
 * That is the question this page exists for, so it gets answered in words —
 * computed from the same rows, and phrased to name the ONE gate doing most of
 * the work rather than listing all of them evenly.
 */
function summariseScan(signals: Signal[]): { summary: string; evidence: { label: string; value: string }[] } {
  const total = signals.length;
  const eligible = signals.filter((s) => s.eligible);
  const refused = signals.filter((s) => !s.eligible);

  // Reasons carry per-market numbers ("spread 7c > 2c limit"), so they are
  // grouped on a digit-blind key — but the KEY is never shown. Blanking the
  // digits produces "price Nc outside NNc band", which is unreadable; a real
  // example from the group says the same thing and can be checked against the
  // table below.
  const byReason = new Map<string, { count: number; example: string }>();
  for (const s of refused) {
    const key = s.reason.replace(/-?\d+(\.\d+)?/g, "#").trim();
    const seen = byReason.get(key);
    if (seen) seen.count++;
    else byReason.set(key, { count: 1, example: s.reason });
  }
  const ranked = [...byReason.values()].sort((a, b) => b.count - a.count);
  const spreads = signals.map((s) => s.spreadCents).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const medianSpread = spreads.length ? spreads[Math.floor(spreads.length / 2)] : 0;

  const parts: string[] = [
    `The last sweep looked at ${total} markets and ${eligible.length} qualified.`,
  ];
  if (ranked.length > 0) {
    const top = ranked[0];
    const share = Math.round((top.count / Math.max(refused.length, 1)) * 100);
    parts.push(
      `The gate doing most of the work was the one behind "${top.example}" — ${top.count} of ${refused.length} rejections, ${share}%.`,
    );
  }
  parts.push(`Median spread across the book was ${medianSpread}c.`);
  if (eligible.length === 0 && total > 0) {
    parts.push("Nothing qualified, so the engine will not open a position on this sweep.");
  }

  return {
    summary: parts.join(" "),
    evidence: [
      { label: "Markets scanned", value: `${total}` },
      { label: "Qualified", value: `${eligible.length}` },
      { label: "Median spread", value: `${medianSpread}c` },
      ...ranked.slice(0, 6).map((r) => ({ label: r.example, value: `${r.count} markets` })),
    ],
  };
}

export default function Signals({ running, idleHint }: { running: boolean; idleHint: string | null }) {
  const [signals, setSignals] = useState<Signal[]>([]);
  const [onlyEligible, setOnlyEligible] = useState(false);
  const toast = useToast();

  useEffect(() => {
    const load = () => void window.rom.engine.getSignals().then(setSignals);
    load();
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, []);

  async function open(ticker: string) {
    try {
      await window.rom.app.openMarket(ticker);
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  const shown = useMemo(
    () => (onlyEligible ? signals.filter((s) => s.eligible) : signals),
    [signals, onlyEligible],
  );

  const groups = useMemo(() => {
    const by = new Map<string, Group>();
    shown.forEach((s, i) => {
      const { event, strike } = splitTicker(s.ticker);
      let g = by.get(event);
      if (!g) {
        g = { event, title: s.title, rows: [], qualified: 0, rank: i, strikes: 0 };
        by.set(event, g);
      }
      g.rows.push(s);
      if (s.eligible) g.qualified++;
      if (!isPlaceholder(strike)) g.strikes++;
    });
    const out = [...by.values()];
    // Events keep the order the engine sent — strongest mover first — and the
    // strikes inside each ladder climb, which is how a ladder is read.
    out.sort((a, b) => a.rank - b.rank);
    for (const g of out) {
      g.rows.sort((x, y) => strikeValue(splitTicker(x.ticker).strike) - strikeValue(splitTicker(y.ticker).strike));
    }
    return out;
  }, [shown]);

  // A column that is empty for every visible row during the whole warm-up
  // period is teaching the eye to skip a region of the table.
  const anyMomentum = shown.some((s) => s.changeCents !== null);

  // Computed from every signal, not the filtered view — "why is nothing
  // trading" is a question about the whole sweep, and answering it from a
  // list the user has narrowed to eligible-only would always say "all of them
  // qualified".
  const scan = useMemo(() => summariseScan(signals), [signals]);

  if (signals.length === 0) {
    return (
      <div className="empty">
        <div className="empty-title">No scan data yet</div>
        <p>
          {running
            ? "The first sweep is in flight — markets will appear here within a scan interval."
            : "Start the engine to watch what the scanner sees on every sweep."}
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="page-sub">
        Every market the last sweep looked at, grouped by event with the strongest movers first, and
        the reason each strike did or didn&apos;t qualify. This is the bot showing its work.
      </div>

      {idleHint && <div className="notice">{idleHint}</div>}

      <Narrate
        subject="what ROM Trader's last market sweep decided and why"
        summary={scan.summary}
        evidence={scan.evidence}
      />


      <div className="toolbar">
        <label className="check">
          <input
            type="checkbox"
            checked={onlyEligible}
            onChange={(e) => setOnlyEligible(e.target.checked)}
          />
          Only markets that met the trigger
        </label>
        <span className="spacer" />
        <span className="hint">
          {signals.filter((s) => s.eligible).length} of {signals.length} qualified across{" "}
          {groups.length} event{groups.length === 1 ? "" : "s"} ·{" "}
          {signals[0] ? timeAgo(signals[0].ts) : ""}
        </span>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Strike</th>
              <th>Bid / Ask</th>
              <th>Spread</th>
              {anyMomentum && <th>Momentum</th>}
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.event}>
                <tr className="group-head">
                  <td colSpan={anyMomentum ? 5 : 4}>
                    <span className="group-title">{g.title}</span>
                    <span className="group-meta">
                      {g.event} · {g.rows.length}{" "}
                      {g.strikes > 0
                        ? `strike${g.rows.length === 1 ? "" : "s"}`
                        : `market${g.rows.length === 1 ? "" : "s"}`}{" "}
                      ·{" "}
                      {g.qualified > 0 ? (
                        <span className="pos">{g.qualified} qualified</span>
                      ) : (
                        "none qualified"
                      )}
                    </span>
                  </td>
                </tr>
                {g.rows.map((s) => {
                  const label = formatStrike(splitTicker(s.ticker).strike);
                  return (
                    <tr key={s.ticker} className={s.eligible ? "row-hot" : ""}>
                      <td>
                        <button
                          className={`linkish strike${label === null ? " muted" : ""}`}
                          onClick={() => open(s.ticker)}
                          title={`Open ${s.ticker} on Kalshi`}
                        >
                          {label ?? "open"} ↗
                        </button>
                      </td>
                      <td>
                        {s.bidCents}c / {s.askCents}c
                      </td>
                      <td className={s.spreadCents > 2 ? "muted" : ""}>{s.spreadCents}c</td>
                      {anyMomentum && (
                        <td
                          className={
                            s.changeCents === null
                              ? "muted"
                              : s.changeCents > 0
                                ? "pos"
                                : s.changeCents < 0
                                  ? "neg"
                                  : ""
                          }
                        >
                          {s.changeCents === null
                            ? "—"
                            : `${s.changeCents > 0 ? "+" : ""}${s.changeCents.toFixed(1)}c`}
                        </td>
                      )}
                      <td>
                        <span className={`verdict ${s.eligible ? "yes" : "no"}`}>
                          {s.eligible ? "TRIGGER" : "skip"}
                        </span>
                        <div className="sub">{s.reason}</div>
                      </td>
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <div className="empty small">Nothing met the trigger on the last sweep.</div>
        )}
      </div>
    </>
  );
}
