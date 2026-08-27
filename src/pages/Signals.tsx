import { Fragment, useEffect, useMemo, useState } from "react";
import type { Signal } from "../types";
import { timeAgo, useToast } from "../ui";

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
 */
function splitTicker(ticker: string): { event: string; strike: string } {
  const i = ticker.lastIndexOf("-");
  if (i <= 0) return { event: ticker, strike: "" };
  return { event: ticker.slice(0, i), strike: ticker.slice(i + 1) };
}

/** T78899.99 -> "T 78,899.99". The prefix is Kalshi's, so it is shown rather
 *  than translated into a claim about what the strike means. */
function formatStrike(strike: string): string {
  const m = strike.match(/^([A-Za-z]*)([\d.]+)$/);
  if (!m) return strike || "—";
  const n = Number(m[2]);
  if (!Number.isFinite(n)) return strike;
  const num = n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return m[1] ? `${m[1].toUpperCase()} ${num}` : num;
}

/** Numeric where possible, so strikes ladder in order rather than lexically —
 *  otherwise 79099.99 sorts above 78899.99 because "9" precedes "8". */
function strikeValue(strike: string): number {
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
      const { event } = splitTicker(s.ticker);
      let g = by.get(event);
      if (!g) {
        g = { event, title: s.title, rows: [], qualified: 0, rank: i };
        by.set(event, g);
      }
      g.rows.push(s);
      if (s.eligible) g.qualified++;
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
                      {g.event} · {g.rows.length} strike{g.rows.length === 1 ? "" : "s"} ·{" "}
                      {g.qualified > 0 ? (
                        <span className="pos">{g.qualified} qualified</span>
                      ) : (
                        "none qualified"
                      )}
                    </span>
                  </td>
                </tr>
                {g.rows.map((s) => {
                  const { strike } = splitTicker(s.ticker);
                  return (
                    <tr key={s.ticker} className={s.eligible ? "row-hot" : ""}>
                      <td>
                        <button
                          className="linkish strike"
                          onClick={() => open(s.ticker)}
                          title={`Open ${s.ticker} on Kalshi`}
                        >
                          {formatStrike(strike)} ↗
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
