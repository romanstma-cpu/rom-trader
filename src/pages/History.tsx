import { useEffect, useMemo, useState } from "react";
import type { TradeRecord } from "../types";
import { Confirm, money, pnlClass, signedMoney, useToast } from "../ui";
// Shared with the engine rather than reimplemented, so the numbers here are
// the same ones the backtester reports for the same trades.
import { computeMetrics } from "../../electron/engine/metrics";

type Filter = "all" | "wins" | "losses";

export default function History({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<TradeRecord[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  const [confirmClear, setConfirmClear] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void window.rom.history.get().then(setRows);
  }, []);

  const stats = useMemo(() => {
    const total = rows.reduce((s, r) => s + r.pnlUsd, 0);
    const wins = rows.filter((r) => r.pnlUsd > 0);
    const losses = rows.filter((r) => r.pnlUsd < 0);
    const best = rows.reduce((m, r) => (r.pnlUsd > m ? r.pnlUsd : m), 0);
    const worst = rows.reduce((m, r) => (r.pnlUsd < m ? r.pnlUsd : m), 0);
    const avgHoldMs =
      rows.length > 0 ? rows.reduce((s, r) => s + (r.closedAt - r.openedAt), 0) / rows.length : 0;
    return { total, wins: wins.length, losses: losses.length, best, worst, avgHoldMs };
  }, [rows]);

  // No equity curve here: drawdown belongs to a session, and this page pools
  // trades across many. The per-trade numbers are what carry over.
  const metrics = useMemo(() => computeMetrics(rows, []), [rows]);

  const shown = useMemo(() => {
    const f =
      filter === "wins"
        ? rows.filter((r) => r.pnlUsd > 0)
        : filter === "losses"
          ? rows.filter((r) => r.pnlUsd < 0)
          : rows;
    return [...f].sort((a, b) => b.closedAt - a.closedAt);
  }, [rows, filter]);

  async function doExport() {
    try {
      const res = await window.rom.history.export();
      toast(res.saved ? "ok" : "info", res.message);
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  async function doClear() {
    setConfirmClear(false);
    try {
      setRows(await window.rom.history.clear());
      onChanged();
      toast("ok", "History and equity curve cleared.");
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="empty">
        <div className="empty-title">No closed trades yet</div>
        <p>Every position the engine closes is recorded here with its exit reason and P&L.</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid stats">
        <div className="card stat">
          <div className="label">Net P&L</div>
          <div className={`value ${pnlClass(stats.total)}`}>{signedMoney(stats.total)}</div>
          <div className="hint">{rows.length} closed trades</div>
        </div>
        <div className="card stat">
          <div className="label">Record</div>
          <div className="value">
            {stats.wins}W / {stats.losses}L
          </div>
          <div className="hint">
            {rows.length > 0 ? `${((stats.wins / rows.length) * 100).toFixed(0)}% win rate` : "—"}
          </div>
        </div>
        <div className="card stat">
          <div className="label">Best / Worst</div>
          <div className="value">
            <span className="pos">{signedMoney(stats.best)}</span>
            <span className="muted"> / </span>
            <span className="neg">{signedMoney(stats.worst)}</span>
          </div>
          <div className="hint">single trade</div>
        </div>
        <div className="card stat">
          <div className="label">Avg Hold</div>
          <div className="value">{Math.round(stats.avgHoldMs / 1000)}s</div>
          <div className="hint">open to close</div>
        </div>
        <div className="card stat">
          <div className="label">Profit factor</div>
          <div
            className={`value ${
              metrics.profitFactor === null ? "" : metrics.profitFactor >= 1 ? "pos" : "neg"
            }`}
          >
            {metrics.profitFactor === null ? "—" : metrics.profitFactor.toFixed(2)}
          </div>
          <div className="hint">winnings ÷ losses · above 1 is profitable</div>
        </div>
        <div className="card stat">
          <div className="label">Per trade</div>
          <div className={`value ${metrics.expectancyUsd === null ? "" : pnlClass(metrics.expectancyUsd)}`}>
            {metrics.expectancyUsd === null ? "—" : signedMoney(metrics.expectancyUsd)}
          </div>
          <div className="hint">average result of one trade</div>
        </div>
        <div className="card stat">
          <div className="label">Payoff</div>
          <div className="value">
            {metrics.payoffRatio === null ? "—" : `${metrics.payoffRatio.toFixed(2)}×`}
          </div>
          <div className="hint">average win vs average loss</div>
        </div>
        <div className="card stat">
          <div className="label">Streaks</div>
          <div className="value">
            <span className="pos">{metrics.longestWinStreak}W</span>
            <span className="muted"> / </span>
            <span className="neg">{metrics.longestLossStreak}L</span>
          </div>
          <div className="hint">longest runs</div>
        </div>
      </div>

      <div className="toolbar">
        <div className="segmented">
          {(["all", "wins", "losses"] as Filter[]).map((f) => (
            <button
              key={f}
              className={filter === f ? "active" : ""}
              onClick={() => setFilter(f)}
            >
              {f === "all" ? "All" : f === "wins" ? "Wins" : "Losses"}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="btn quiet" onClick={doExport}>
          Export CSV
        </button>
        <button className="btn danger quiet" onClick={() => setConfirmClear(true)}>
          Clear history
        </button>
      </div>

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Closed</th>
              <th>Market</th>
              <th>Size</th>
              <th>Entry → Exit</th>
              <th>P&L</th>
              <th>Reason</th>
              <th>Mode</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, i) => (
              <tr key={`${r.ticker}-${r.closedAt}-${i}`}>
                <td className="muted">{new Date(r.closedAt).toLocaleString()}</td>
                <td>
                  <strong>{r.ticker}</strong>
                  <div className="sub">{r.title.slice(0, 60)}</div>
                </td>
                <td>{r.contracts}x</td>
                <td>
                  {r.entryCents}c → {r.exitCents}c
                </td>
                <td className={pnlClass(r.pnlUsd)}>{signedMoney(r.pnlUsd)}</td>
                <td className="muted">{r.reason}</td>
                <td>
                  <span className={`tag ${r.dryRun ? "" : "live"}`}>{r.dryRun ? "paper" : "live"}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Confirm
        open={confirmClear}
        title="Clear all trade history?"
        body={
          <>
            This permanently deletes all {rows.length} recorded trades and resets the equity curve.
            Export a CSV first if you want to keep them — this cannot be undone.
          </>
        }
        confirmLabel="Delete history"
        danger
        onConfirm={doClear}
        onCancel={() => setConfirmClear(false)}
      />
    </>
  );
}
