import { useEffect, useState } from "react";
import type { EngineState, EquityPoint, Settings, TradeRecord } from "../types";
import { breakEvenWinRate } from "../../electron/engine/fees";
import { EquityChart, Stat, duration, money, pnlClass, signedMoney } from "../ui";

/** Mid of the default price band — the fee curve is flattest here, so it is the
 *  fair single point to quote a break-even at before there is history to
 *  measure a real median entry from. */
const NOMINAL_ENTRY_CENTS = 48;

export default function Dashboard({
  state,
  onNavigate,
}: {
  state: EngineState | null;
  onNavigate: (page: string) => void;
}) {
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [accountUsd, setAccountUsd] = useState<number | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [history, setHistory] = useState<TradeRecord[]>([]);

  const live = state ? state.authConfigured && !state.dryRun : false;

  useEffect(() => {
    const load = () => void window.rom.equity.get().then(setEquity);
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, []);

  // Settings decide the break-even win rate; history gives the expectancy that
  // has actually been achieved against it. Neither changes fast enough to need
  // the 5s cadence above.
  useEffect(() => {
    const load = () => {
      void window.rom.settings.get().then(setSettings);
      void window.rom.history.get().then(setHistory);
    };
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, []);

  // The real Kalshi balance, polled only once live orders are actually
  // possible — in dry-run there is nothing at the exchange to report.
  useEffect(() => {
    if (!live) {
      setAccountUsd(null);
      return;
    }
    const load = () => void window.rom.kalshi.balance().then(setAccountUsd);
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [live]);

  if (!state) return <div className="empty">Loading…</div>;

  const running = state.status === "running";

  // The whole question this app exists to answer, in two numbers that used to
  // live on different screens: what the fees demand, and what is being managed.
  const need = settings
    ? breakEvenWinRate(
        settings.takeProfitCents,
        settings.stopLossCents,
        NOMINAL_ENTRY_CENTS,
        settings.makerEntries,
      )
    : null;
  const gapPts = need !== null && state.winRate !== null ? (state.winRate - need) * 100 : null;

  // Mean P&L per closed trade in the mode being shown, so the headline is not a
  // paper result quoted at someone trading live, or the reverse.
  const closed = history.filter((t) => t.dryRun === !live);
  const expectancy =
    closed.length > 0 ? closed.reduce((a, t) => a + t.pnlUsd, 0) / closed.length : null;

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
      {state.haltedReason && (
        <div className="notice bad">
          <div>{state.haltedReason}</div>
          <button
            className="btn tiny"
            onClick={async () => {
              try {
                await window.rom.engine.clearHalt();
              } catch {
                // The banner is refreshed by engine state either way.
              }
            }}
            title="Keeps your limits exactly as they are, and starts their allowance again from now."
          >
            Resume
          </button>
        </div>
      )}
      {state.lastError && !state.haltedReason && (
        <div className="notice warn">Last scan error: {state.lastError}</div>
      )}
      {state.idleHint && !state.haltedReason && !state.lastError && (
        <div className="notice" role="status">
          <div>{state.idleHint}</div>
          <button className="btn tiny" onClick={() => onNavigate("settings")}>
            Open Settings
          </button>
        </div>
      )}

      <div className="grid stats">
        <Stat
          label={live ? "Kalshi Balance" : "Total Balance"}
          value={live ? (accountUsd === null ? "—" : money(accountUsd)) : money(state.equityUsd)}
          hint={
            live
              ? accountUsd === null
                ? "couldn't reach Kalshi — check Connection"
                : `settled at the exchange · engine equity ${money(state.equityUsd)}`
              : `cash ${money(state.cashUsd)} · paper`
          }
        />
        {/* Session P&L and Today used to sit here as well as in the header bar
            two inches above, so three of five cards were repeating a number
            already on screen. The freed slots carry the two figures that
            appeared nowhere on this page: what the fees demand, and what a
            trade is actually worth on average. */}
        <Stat
          label="All-Time P&L"
          value={signedMoney(state.allTimePnlUsd)}
          tone={pnlClass(state.allTimePnlUsd)}
          hint={`${state.wins}W / ${state.losses}L · ${live ? "live" : "paper"} only`}
        />
        <Stat
          label="Win Rate"
          value={state.winRate === null ? "—" : `${(state.winRate * 100).toFixed(0)}%`}
          tone={gapPts === null ? undefined : gapPts >= 0 ? "pos" : "neg"}
          hint={
            need === null ? (
              `${state.wins + state.losses} ${live ? "live" : "paper"} trades`
            ) : state.winRate === null ? (
              `need ${(need * 100).toFixed(0)}% to break even at these settings`
            ) : (
              <>
                need <strong>{(need * 100).toFixed(0)}%</strong> to break even ·{" "}
                <span className={gapPts! >= 0 ? "pos" : "neg"}>
                  {gapPts! >= 0 ? "+" : ""}
                  {gapPts!.toFixed(0)}pt {gapPts! >= 0 ? "clear" : "short"}
                </span>
              </>
            )
          }
        />
        <Stat
          label="Per Trade"
          value={expectancy === null ? "—" : signedMoney(expectancy)}
          tone={expectancy === null ? undefined : pnlClass(expectancy)}
          hint={
            expectancy === null
              ? `no closed ${live ? "live" : "paper"} trades yet`
              : `average over ${closed.length} closed ${live ? "live" : "paper"} trades, after fees`
          }
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
                <span className="k">Cooling down</span>
                <span className="v">{state.scanner.skippedCooldown}</span>
              </div>
              {state.scanner.skippedClock > 0 && (
                <div>
                  <span className="k">Outside hours</span>
                  <span className="v">{state.scanner.skippedClock}</span>
                </div>
              )}
              {state.scanner.skippedRegime > 0 && (
                <div>
                  <span className="k">Wrong regime</span>
                  <span className="v">{state.scanner.skippedRegime}</span>
                </div>
              )}
              {state.scanner.skippedQuiet > 0 && (
                <div>
                  <span className="k">No trades printed</span>
                  <span className="v">{state.scanner.skippedQuiet}</span>
                </div>
              )}
              {state.scanner.skippedClosing > 0 && (
                <div>
                  <span className="k">Closing soon</span>
                  <span className="v">{state.scanner.skippedClosing}</span>
                </div>
              )}
              {state.scanner.skippedEvent > 0 && (
                <div>
                  <span className="k">Ladder held/locked</span>
                  <span className="v">{state.scanner.skippedEvent}</span>
                </div>
              )}
              {state.scanner.skippedJumpy > 0 && (
                <div>
                  <span className="k">One jump, not a climb</span>
                  <span className="v">{state.scanner.skippedJumpy}</span>
                </div>
              )}
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
