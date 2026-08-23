import { useEffect, useState } from "react";
import type { Signal } from "../types";
import { timeAgo, useToast } from "../ui";

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

  const shown = onlyEligible ? signals.filter((s) => s.eligible) : signals;

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
        Every market the last sweep looked at, strongest movers first, with the reason it did or
        didn't qualify. This is the bot showing its work.
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
          {signals.filter((s) => s.eligible).length} of {signals.length} qualified ·{" "}
          {signals[0] ? timeAgo(signals[0].ts) : ""}
        </span>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Market</th>
              <th>Bid / Ask</th>
              <th>Spread</th>
              <th>Momentum</th>
              <th>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.ticker} className={s.eligible ? "row-hot" : ""}>
                <td>
                  <button className="linkish" onClick={() => open(s.ticker)} title="Open on Kalshi">
                    {s.ticker} ↗
                  </button>
                  <div className="sub">{s.title.slice(0, 70)}</div>
                </td>
                <td>
                  {s.bidCents}c / {s.askCents}c
                </td>
                <td className={s.spreadCents > 2 ? "muted" : ""}>{s.spreadCents}c</td>
                <td className={s.changeCents === null ? "muted" : s.changeCents > 0 ? "pos" : s.changeCents < 0 ? "neg" : ""}>
                  {s.changeCents === null
                    ? "—"
                    : `${s.changeCents > 0 ? "+" : ""}${s.changeCents.toFixed(1)}c`}
                </td>
                <td>
                  <span className={`verdict ${s.eligible ? "yes" : "no"}`}>
                    {s.eligible ? "TRIGGER" : "skip"}
                  </span>
                  <div className="sub">{s.reason}</div>
                </td>
              </tr>
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
