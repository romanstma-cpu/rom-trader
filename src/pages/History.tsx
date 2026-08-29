import { useEffect, useMemo, useState } from "react";
import type { TradeRecord } from "../types";
import { Confirm, money, pnlClass, signedMoney, useToast } from "../ui";
// Shared with the engine rather than reimplemented, so the numbers here are
// the same ones the backtester reports for the same trades.
import { computeMetrics } from "../../electron/engine/metrics";

type Filter = "all" | "wins" | "losses";
type Mode = "all" | "paper" | "live";

export default function History({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<TradeRecord[]>([]);
  const [filter, setFilter] = useState<Filter>("all");
  // Paper and live are separate accounts of separate money; the stats above
  // the table are meaningless when they are blended.
  const [mode, setMode] = useState<Mode>("all");
  const [confirmClear, setConfirmClear] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void window.rom.history.get().then(setRows);
  }, []);

  const scoped = useMemo(
    () => (mode === "all" ? rows : rows.filter((r) => (mode === "paper" ? r.dryRun : !r.dryRun))),
    [rows, mode],
  );

  const stats = useMemo(() => {
    const total = scoped.reduce((s, r) => s + r.pnlUsd, 0);
    const wins = scoped.filter((r) => r.pnlUsd > 0);
    const losses = scoped.filter((r) => r.pnlUsd < 0);
    const best = scoped.reduce((m, r) => (r.pnlUsd > m ? r.pnlUsd : m), 0);
    const worst = scoped.reduce((m, r) => (r.pnlUsd < m ? r.pnlUsd : m), 0);
    const avgHoldMs =
      scoped.length > 0
        ? scoped.reduce((s, r) => s + (r.closedAt - r.openedAt), 0) / scoped.length
        : 0;
    return { total, wins: wins.length, losses: losses.length, best, worst, avgHoldMs };
  }, [scoped]);

  // No equity curve here: drawdown belongs to a session, and this page pools
  // trades across many. The per-trade numbers are what carry over.
  const metrics = useMemo(() => computeMetrics(scoped, []), [scoped]);

  // How trades ended, and what each way of ending cost. The same cut every
  // session autopsy starts with, so it belongs on the page rather than in a
  // spreadsheet: a strategy whose stop-losses dwarf its take-profits is
  // telling you something the win rate hides.
  const byReason = useMemo(() => {
    const acc = new Map<string, { n: number; pnl: number }>();
    for (const r of scoped) {
      const key = r.reason.startsWith("settled") ? "settled" : r.reason;
      const e = acc.get(key) ?? { n: 0, pnl: 0 };
      e.n += 1;
      e.pnl += r.pnlUsd;
      acc.set(key, e);
    }
    return [...acc.entries()].sort((a, b) => a[1].pnl - b[1].pnl);
  }, [scoped]);

  const quickStops = useMemo(() => {
    const q = scoped.filter((r) => r.pnlUsd < 0 && r.closedAt - r.openedAt < 120_000);
    return { n: q.length, pnl: q.reduce((s, r) => s + r.pnlUsd, 0) };
  }, [scoped]);

  const shown = useMemo(() => {
    const f =
      filter === "wins"
        ? scoped.filter((r) => r.pnlUsd > 0)
        : filter === "losses"
          ? scoped.filter((r) => r.pnlUsd < 0)
          : scoped;
    return [...f].sort((a, b) => b.closedAt - a.closedAt);
  }, [scoped, filter]);

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
      setRows(await window.rom.history.clear(mode));
      onChanged();
      toast(
        "ok",
        mode === "all"
          ? "History and equity curve cleared."
          : `${mode === "paper" ? "Paper" : "Live"} trades cleared. The others were kept.`,
      );
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
            {rows.length > 0
              ? `${((stats.wins / rows.length) * 100).toFixed(0)}% win rate · ` +
                `${metrics.events} ${metrics.events === 1 ? "event" : "events"}`
              : "—"}
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
          <div className="hint">
            {metrics.expectancyCI === null
              ? "average result of one trade"
              : `95% CI ${signedMoney(metrics.expectancyCI[0])} to ${signedMoney(metrics.expectancyCI[1])}`}
          </div>
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
          <div className="hint">longest runs · one ladder counts once</div>
        </div>
      </div>

      {metrics.events > 0 && metrics.trades >= metrics.events * 2 && (
        <div className="card">
          <div className="hint">
            These {metrics.trades} trades came from {metrics.events} event
            {metrics.events === 1 ? "" : "s"}. Sibling strikes of one ladder settle on the same
            move, so they win and lose together — the interval above counts events, not trades,
            which is why it is wider than {metrics.trades} results would suggest.
          </div>
        </div>
      )}

      {byReason.length > 1 && (
        <div className="card">
          <div className="card-title">How trades closed</div>
          <table className="compact">
            <thead>
              <tr>
                <th>Exit</th>
                <th>Trades</th>
                <th>P&L</th>
              </tr>
            </thead>
            <tbody>
              {byReason.map(([reason, e]) => (
                <tr key={reason}>
                  <td>{reason}</td>
                  <td className="muted">{e.n}</td>
                  <td className={pnlClass(e.pnl)}>{signedMoney(e.pnl)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {quickStops.n > 0 && (
            <div className="hint" style={{ marginTop: 8 }}>
              {quickStops.n} stop{quickStops.n === 1 ? "" : "s"} hit within two minutes of entry
              ({signedMoney(quickStops.pnl)}) — entries that were wrong almost immediately, the
              shape the entry gates exist to reduce.
            </div>
          )}
        </div>
      )}

      <div className="toolbar">
        <div className="segmented">
          {(["all", "paper", "live"] as Mode[]).map((m) => (
            <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
              {m === "all" ? "Both" : m === "paper" ? "Paper" : "Live"}
            </button>
          ))}
        </div>
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
          {mode === "all" ? "Clear history" : `Clear ${mode} trades`}
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
        title={mode === "all" ? "Clear all trade history?" : `Clear ${mode} trades?`}
        body={
          mode === "all" ? (
            <>
              This permanently deletes all {rows.length} recorded trades and resets the equity
              curve. Export a CSV first if you want to keep them — this cannot be undone.
            </>
          ) : (
            <>
              This permanently deletes the {scoped.length} {mode} trade
              {scoped.length === 1 ? "" : "s"}. Your {mode === "paper" ? "live" : "paper"} trades
              and the equity curve are kept. Export a CSV first if you want them — this cannot be
              undone.
            </>
          )
        }
        confirmLabel={mode === "all" ? "Delete history" : `Delete ${mode} trades`}
        danger
        onConfirm={doClear}
        onCancel={() => setConfirmClear(false)}
      />
    </>
  );
}
