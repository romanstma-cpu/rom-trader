import type { EngineState } from "../types";
import { money, pnlClass, signedMoney, timeAgo, useToast } from "../ui";

export default function Positions({ state }: { state: EngineState | null }) {
  const toast = useToast();
  if (!state) return <div className="empty">Loading…</div>;

  async function open(ticker: string) {
    try {
      await window.rom.app.openMarket(ticker);
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  const pending = state.pendingOrders ?? [];

  if (state.positions.length === 0 && pending.length === 0) {
    return (
      <div className="empty">
        <div className="empty-title">No open positions</div>
        <p>
          {state.status === "running"
            ? "The engine is scanning. A position opens when a market's mid-price climbs past your momentum trigger."
            : "Start the engine and positions will appear here as they open."}
        </p>
      </div>
    );
  }

  const totalCost = state.positions.reduce((s, p) => s + (p.entryCents * p.contracts) / 100, 0);
  const totalNow = state.positions.reduce((s, p) => s + (p.currentBidCents * p.contracts) / 100, 0);

  return (
    <>
      <div className="page-sub">
        {state.positions.length} open · {money(totalCost)} at cost · {money(totalNow)} at current bid
        {pending.length > 0 && <> · {pending.length} resting order{pending.length === 1 ? "" : "s"}</>}.
        Click a ticker to open it on Kalshi.
      </div>

      {state.positions.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Size</th>
                <th>Entry</th>
                <th>Bid</th>
                <th>Peak</th>
                <th>Unrealized</th>
                <th>Age</th>
              </tr>
            </thead>
            <tbody>
              {state.positions.map((p) => {
                const move = p.currentBidCents - p.entryCents;
                return (
                  <tr key={p.ticker}>
                    <td>
                      <button className="linkish" onClick={() => open(p.ticker)} title="Open on Kalshi">
                        {p.ticker} ↗
                      </button>
                      <div className="sub">{p.title.slice(0, 70)}</div>
                    </td>
                    <td>{p.contracts}x YES</td>
                    <td>{p.entryCents}c</td>
                    <td>
                      {p.currentBidCents}c
                      <span className={`delta ${pnlClass(move)}`}>
                        {move > 0 ? "+" : ""}
                        {move}c
                      </span>
                    </td>
                    <td className="muted">
                      {Math.round(p.peakMidCents)}c
                      {p.tpRestingCents !== null && (
                        <div className="sub" title="A sell is resting at your target — it fills there fee-free.">
                          sell resting @ {p.tpRestingCents}c
                        </div>
                      )}
                    </td>
                    <td className={pnlClass(p.unrealizedUsd)}>{signedMoney(p.unrealizedUsd)}</td>
                    <td className="muted">{timeAgo(p.openedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {pending.length > 0 && (
        <div className="card">
          <div className="card-head">
            <div className="label">Resting orders</div>
            <span className="hint">Waiting at the bid — cash reserved, no fee paid yet</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Size</th>
                <th>Limit</th>
                <th>Reserved</th>
                <th>Expires in</th>
                <th>Placed</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((o) => (
                <tr key={o.ticker}>
                  <td>
                    <button className="linkish" onClick={() => open(o.ticker)} title="Open on Kalshi">
                      {o.ticker} ↗
                    </button>
                    <div className="sub">{o.title.slice(0, 70)}</div>
                  </td>
                  <td>{o.contracts}x YES</td>
                  <td>{o.limitCents}c</td>
                  <td>{money(o.costUsd)}</td>
                  <td className="muted">
                    {o.ticksLeft} scan{o.ticksLeft === 1 ? "" : "s"}
                  </td>
                  <td className="muted">{timeAgo(o.placedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
