import { useEffect, useState } from "react";
import type { EngineState, EquityPoint } from "../types";
import { EquityChart, Stat, duration, money, pnlClass, signedMoney } from "../ui";

export default function Dashboard({
  state,
  onNavigate,
}: {
  state: EngineState | null;
  onNavigate: (page: string) => void;
}) {
  const [equity, setEquity] = useState<EquityPoint[]>([]);

  useEffect(() => {
    const load = () => void window.rom.equity.get().then(setEquity);
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  if (!state) return <div className="empty">Loading…</div>;

  const running = state.status === "running";

  return (
    <>
      {!state.authConfigured && (
        <div className="notice" role="status">
          <div>
            <strong>Paper-trading mode.</strong> No API keys yet, so the bot trades on live prices
            with virtual cash. Add keys to unlock live trading.
          </div>
          <button className="btn tiny" onClick={() => onNavigate("connection")}>
            Add keys
          </button>
        </div>
      )}
      {state.haltedReason && <div className="notice bad">{state.haltedReason}</div>}
      {state.lastError && !state.haltedReason && (
        <div className="notice warn">Last scan error: {state.lastError}</div>
      )}

      <div className="grid stats">
        <Stat
          label="Total Balance"
          value={money(state.equityUsd)}
          hint={`cash ${money(state.cashUsd)} · ${state.dryRun ? "paper" : "live"}`}
        />
        <Stat
          label="Session P&L"
          value={signedMoney(state.sessionPnlUsd)}
          tone={pnlClass(state.sessionPnlUsd)}
          hint="realized + unrealized"
        />
        <Stat
          label="Today"
          value={signedMoney(state.todayPnlUsd)}
          tone={pnlClass(state.todayPnlUsd)}
          hint="closed trades since midnight"
        />
        <Stat
          label="All-Time P&L"
          value={signedMoney(state.allTimePnlUsd)}
          tone={pnlClass(state.allTimePnlUsd)}
          hint={`${state.wins}W / ${state.losses}L`}
        />
        <Stat
          label="Win Rate"
          value={state.winRate === null ? "—" : `${(state.winRate * 100).toFixed(0)}%`}
          hint={state.winRate === null ? "no closed trades" : `${state.wins + state.losses} trades`}
        />
      </div>

      <div className="card">
        <div className="card-head">
          <div className="label">Equity Curve</div>
          <div className="hint">
            {running && state.startedAt ? `running for ${duration(Date.now() - state.startedAt)}` : "engine idle"}
          </div>
        </div>
        <EquityChart points={equity} />
      </div>

      <div className="two-col">
        <div className="card">
          <div className="card-head">
            <div className="label">Scanner</div>
            <button className="btn tiny quiet" onClick={() => onNavigate("signals")}>
              View signals →
            </button>
          </div>
          {state.scanner ? (
            <div className="mini-stats">
              <div>
                <span className="k">Markets</span>
                <span className="v">{state.scanner.marketsScanned}</span>
              </div>
              <div>
                <span className="k">Eligible</span>
                <span className="v pos">{state.scanner.eligible}</span>
              </div>
              <div>
                <span className="k">Wide spread</span>
                <span className="v">{state.scanner.skippedSpread}</span>
              </div>
              <div>
                <span className="k">Out of range</span>
                <span className="v">{state.scanner.skippedPrice}</span>
              </div>
              <div>
                <span className="k">Warming up</span>
                <span className="v">{state.scanner.skippedWarmup}</span>
              </div>
              <div>
                <span className="k">Scan time</span>
                <span className="v">{state.scanner.scanMs}ms</span>
              </div>
            </div>
          ) : (
            <div className="empty small">
              {running ? "Waiting for the first scan…" : "Start the engine to scan the market."}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <div className="label">Open Positions</div>
            <span className="hint">
              {state.positions.length} / {state.maxPositions}
            </span>
          </div>
          {state.positions.length === 0 ? (
            <div className="empty small">
              {running ? "No positions yet — scanning for momentum." : "Start the engine to begin."}
            </div>
          ) : (
            <table className="tight">
              <tbody>
                {state.positions.slice(0, 5).map((p) => (
                  <tr key={p.ticker}>
                    <td>
                      <strong>{p.ticker}</strong>
                    </td>
                    <td>{p.contracts}x</td>
                    <td className={pnlClass(p.unrealizedUsd)}>{signedMoney(p.unrealizedUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}
