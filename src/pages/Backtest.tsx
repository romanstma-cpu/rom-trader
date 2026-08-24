import { useEffect, useState } from "react";
import type { BacktestResult, RecordingInfo, SweepProgress, SweepReport } from "../types";
import { Confirm, money, pnlClass, signedMoney, useToast } from "../ui";

function bytes(n: number): string {
  if (n <= 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

function span(from: number | null, to: number | null): string {
  if (from === null || to === null) return "—";
  const hours = (to - from) / 3_600_000;
  if (hours < 1) return `${Math.round(hours * 60)} minutes`;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

export default function Backtest() {
  const [info, setInfo] = useState<RecordingInfo | null>(null);
  const [results, setResults] = useState<BacktestResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [sweep, setSweep] = useState<SweepReport | null>(null);
  const [sweeping, setSweeping] = useState(false);
  const [sweepProgress, setSweepProgress] = useState<SweepProgress | null>(null);
  const toast = useToast();

  useEffect(() => {
    void window.rom.backtest.info().then(setInfo);
    const t = setInterval(() => void window.rom.backtest.info().then(setInfo), 15000);
    const off = window.rom.backtest.onSweepProgress(setSweepProgress);
    return () => {
      clearInterval(t);
      off();
    };
  }, []);

  async function runSweep() {
    setSweeping(true);
    setSweep(null);
    setSweepProgress(null);
    try {
      setSweep(await window.rom.backtest.sweep());
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setSweeping(false);
    }
  }

  async function run() {
    setRunning(true);
    setResults(null);
    try {
      // Replaying thousands of scans blocks the main process for a moment;
      // the button is disabled meanwhile rather than pretending otherwise.
      setResults(await window.rom.backtest.run());
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function clear() {
    setConfirmClear(false);
    setInfo(await window.rom.backtest.clear());
    setResults(null);
    toast("info", "Recording cleared. It starts again on the next scan.");
  }

  if (!info) return <div className="empty">Loading…</div>;

  const enough = info.scans >= 10;
  // Deliberately no "winner" highlight. One recording cannot establish an edge,
  // and crowning a row would quietly invite tuning until this table looks good
  // — which is how a backtest turns into a way of fooling yourself.

  return (
    <>
      <div className="page-sub">
        Every market sweep is saved while the engine runs. Replaying it puts your settings and each
        shipped preset through exactly the same data, using the same code that trades live — so the
        comparison is measured rather than argued.
      </div>

      <div className="card">
        <div className="card-head">
          <div className="label">Recorded data</div>
          {info.scans > 0 && (
            <button className="btn tiny quiet" onClick={() => setConfirmClear(true)}>
              Clear recording
            </button>
          )}
        </div>

        <div className="mini-stats">
          <div>
            <span className="k">Scans</span>
            <span className="v">{info.scans.toLocaleString()}</span>
          </div>
          <div>
            <span className="k">Covering</span>
            <span className="v">{span(info.firstTs, info.lastTs)}</span>
          </div>
          <div>
            <span className="k">On disk</span>
            <span className="v">{bytes(info.bytes)}</span>
          </div>
        </div>

        {!enough && (
          <div className="notice" role="status">
            <div>
              {info.scans === 0
                ? "Nothing recorded yet. Start the engine and leave it running — recording happens on every scan, in dry-run as well as live."
                : `Only ${info.scans} scans so far. A replay over a handful of sweeps says nothing; leave the engine running longer.`}
            </div>
          </div>
        )}

        <div className="row-actions">
          <button className="btn primary" onClick={() => void run()} disabled={!enough || running}>
            {running ? "Replaying…" : "Compare strategies"}
          </button>
          <button
            className="btn quiet"
            onClick={() => void runSweep()}
            disabled={info.scans < 60 || sweeping || running}
            title="Tries a coarse grid of settings, fitted on the first 60% of the recording and scored on the last 40% it never saw."
          >
            {sweeping
              ? sweepProgress
                ? `Sweeping… ${sweepProgress.done}/${sweepProgress.total}`
                : "Sweeping…"
              : "Parameter sweep"}
          </button>
        </div>
        {sweeping && sweepProgress && (
          <div className="progress" role="progressbar" aria-valuenow={sweepProgress.done} aria-valuemin={0} aria-valuemax={sweepProgress.total}>
            <div
              className="progress-fill"
              style={{ width: `${(sweepProgress.done / sweepProgress.total) * 100}%` }}
            />
          </div>
        )}
      </div>

      {sweep && (
        <div className="card">
          <div className="card-head">
            <div className="label">Parameter sweep</div>
            <span className="hint">
              fitted on {sweep.scansTrain.toLocaleString()} scans · scored on{" "}
              {sweep.scansTest.toLocaleString()} it never saw
            </span>
          </div>

          {/* The verdict leads. A ranking table without it invites adopting
              whichever row is on top, which is the failure mode this page
              exists to prevent. */}
          <div className={`notice ${sweep.nothingWorked ? "warn" : ""}`} role="status">
            {sweep.nothingWorked
              ? "No candidate made money on the held-out data. That is the honest result: on this recording, nothing in the grid had an edge, and the ranking below only orders degrees of losing."
              : "The top rows made money on data they never saw. That is one recording's worth of evidence — not an edge — but it earns a longer look."}
          </div>

          <table className="tight">
            <thead>
              <tr>
                <th>Configuration</th>
                <th title="Result on the 60% the search was allowed to fit.">Fitted</th>
                <th title="Result on the held-out 40%. The only column that matters.">Unseen</th>
                <th>Trades</th>
                <th>Win rate</th>
              </tr>
            </thead>
            <tbody>
              {[
                ...(sweep.baseline ? [sweep.baseline] : []),
                ...sweep.candidates.slice(0, 10),
              ].map((c, i) => (
                <tr key={`${c.label}-${i}`}>
                  <td>
                    <strong>{c.label}</strong>
                    {sweep.baseline && c === sweep.baseline && (
                      <span className="hint"> · yours</span>
                    )}
                  </td>
                  <td className={pnlClass(c.trainPnlUsd)}>{signedMoney(c.trainPnlUsd)}</td>
                  <td className={pnlClass(c.testPnlUsd)}>{signedMoney(c.testPnlUsd)}</td>
                  <td>{c.testTrades}</td>
                  <td>{c.testWinRate === null ? "—" : `${(c.testWinRate * 100).toFixed(0)}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {sweep.notes.length > 0 && (
            <div className="callout">
              {sweep.notes.map((n, i) => (
                <div key={i}>{n}</div>
              ))}
            </div>
          )}
        </div>
      )}

      {results && (
        <div className="card">
          <div className="card-head">
            <div className="label">Results over {info.scans.toLocaleString()} scans</div>
            <span className="hint">{span(info.firstTs, info.lastTs)} of market data</span>
          </div>

          <table className="tight">
            <thead>
              <tr>
                <th>Configuration</th>
                <th>Trades</th>
                <th>Win rate</th>
                <th>P&amp;L</th>
                <th title="Average P&L per closed trade — the sign of this is the whole question.">
                  Per trade
                </th>
                <th title="Gross winnings over gross losses. Above 1 is profitable.">PF</th>
                <th title="Mean over standard deviation of per-trade P&L. Per trade, not annualised.">
                  Sharpe
                </th>
                <th title="Resting maker orders: filled / placed. A maker config with few fills traded on luck, not intent.">
                  Orders
                </th>
                <th>Worst drawdown</th>
                <th>Best / worst trade</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={r.label}>
                  <td>
                    <strong>{r.label}</strong>
                    {r.halted && (
                      <span className="hint" title={r.haltedReason ?? ""}>
                        {" "}
                        · stopped early
                      </span>
                    )}
                  </td>
                  <td>{r.trades}</td>
                  <td>
                    {r.winRate === null ? "—" : `${(r.winRate * 100).toFixed(0)}%`}
                    {r.trades > 0 && (
                      <span className="hint">
                        {" "}
                        {r.wins}W/{r.losses}L
                      </span>
                    )}
                  </td>
                  <td className={pnlClass(r.pnlUsd)}>{signedMoney(r.pnlUsd)}</td>
                  <td className={r.metrics.expectancyUsd === null ? "" : pnlClass(r.metrics.expectancyUsd)}>
                    {r.metrics.expectancyUsd === null ? "—" : signedMoney(r.metrics.expectancyUsd)}
                  </td>
                  <td>{r.metrics.profitFactor === null ? "—" : r.metrics.profitFactor.toFixed(2)}</td>
                  <td>
                    {r.metrics.sharpePerTrade === null ? "—" : r.metrics.sharpePerTrade.toFixed(2)}
                  </td>
                  <td>{r.maker ? `${r.ordersFilled}/${r.ordersPlaced}` : "—"}</td>
                  <td>{r.maxDrawdownUsd > 0 ? `−${money(r.maxDrawdownUsd)}` : "—"}</td>
                  <td>
                    <span className="pos">{signedMoney(r.bestUsd)}</span>{" "}
                    <span className="neg">{signedMoney(r.worstUsd)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="callout">
            {results.every((r) => r.trades === 0) ? (
              <>
                Nothing traded on this data under any configuration. That usually means the filters
                are tighter than the recorded market ever got — widen the spread limit or lower the
                momentum trigger and record more.
              </>
            ) : (
              <>
                This is one stretch of market, replayed. It says how these settings would have
                behaved over the hours you recorded — not what they will do next. A configuration
                that wins here has not been shown to have an edge; it has been shown not to be
                obviously worse.
              </>
            )}
          </div>
        </div>
      )}

      {results && results.some((r) => r.trades > 0) && (
        <div className="card">
          <div className="card-head">
            <div className="label">Why trades closed</div>
          </div>
          <table className="tight">
            <tbody>
              {results
                .filter((r) => r.trades > 0)
                .map((r) => (
                  <tr key={r.label}>
                    <td>
                      <strong>{r.label}</strong>
                    </td>
                    <td>
                      {Object.entries(r.exitReasons)
                        .sort((a, b) => b[1] - a[1])
                        .map(([reason, n]) => `${n} ${reason}`)
                        .join(" · ")}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      <Confirm
        open={confirmClear}
        title="Clear the recording?"
        body={
          <>
            Deletes every saved market sweep. Recording restarts on the next scan, but the history
            you have collected so far cannot be recovered.
          </>
        }
        confirmLabel="Clear it"
        danger
        onConfirm={() => void clear()}
        onCancel={() => setConfirmClear(false)}
      />
    </>
  );
}
