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

  if (state.positions.length === 0) {
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
        {state.positions.length} open · {money(totalCost)} at cost · {money(totalNow)} at current bid.
        Click a ticker to open it on Kalshi.
      </div>

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
                  <td className="muted">{Math.round(p.peakMidCents)}c</td>
                  <td className={pnlClass(p.unrealizedUsd)}>{signedMoney(p.unrealizedUsd)}</td>
                  <td className="muted">{timeAgo(p.openedAt)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
