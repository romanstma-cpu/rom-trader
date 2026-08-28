import { useEffect, useState } from "react";
import type {
  CalibrationProgressEvent,
  CalibrationReport,
  DepthInfo,
  RecordingInfo,
  SettlementInfo,
  SpotInfo,
  TapeInfo,
} from "../types";

/**
 * The measuring instrument, made visible.
 *
 * Every strategy this app has shipped was measured against its own recordings
 * and lost. Until now that work lived in developer scripts — clone the repo,
 * install a bundler, run node — so the person who downloaded the installer got
 * the losing bot and none of the apparatus that proved it was losing.
 *
 * This page inverts that. It shows what the app has collected, and it runs the
 * study that sits underneath every strategy question — does a price on this
 * venue mean what it says, and is any error large enough to trade — on the
 * user's own data, with no key and no network.
 *
 * The result is allowed to be discouraging. That is the feature.
 */

const nf = new Intl.NumberFormat();

function ago(ts: number | null): string {
  if (!ts) return "—";
  const mins = Math.max(0, Math.round((Date.now() - ts) / 60_000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = mins / 60;
  if (hrs < 48) return `${hrs.toFixed(1)}h ago`;
  return `${(hrs / 24).toFixed(1)}d ago`;
}

function span(first: number | null, last: number | null): string {
  if (!first || !last || last <= first) return "—";
  const hrs = (last - first) / 3_600_000;
  return hrs < 48 ? `${hrs.toFixed(1)}h` : `${(hrs / 24).toFixed(1)}d`;
}

function cents(x: number): string {
  return `${x >= 0 ? "+" : ""}${x.toFixed(2)}c`;
}

function Stream(props: {
  label: string;
  value: string;
  hint: string;
  ok: boolean;
}): JSX.Element {
  return (
    <div className="card stat">
      <div className="label">{props.label}</div>
      <div className={`value ${props.ok ? "" : "muted"}`}>{props.value}</div>
      <div className="hint">{props.hint}</div>
    </div>
  );
}

export default function Research(): JSX.Element {
  const [info, setInfo] = useState<RecordingInfo | null>(null);
  const [settle, setSettle] = useState<SettlementInfo | null>(null);
  const [tape, setTape] = useState<TapeInfo | null>(null);
  const [spot, setSpot] = useState<SpotInfo | null>(null);
  const [depth, setDepth] = useState<DepthInfo | null>(null);

  const [horizon, setHorizon] = useState(30);
  const [report, setReport] = useState<CalibrationReport | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<CalibrationProgressEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.rom.backtest.info().then(setInfo);
    void window.rom.backtest.settlements().then(setSettle);
    void window.rom.backtest.tape().then(setTape);
    void window.rom.backtest.spot().then(setSpot);
    void window.rom.backtest.depth().then(setDepth);
  }, []);

  useEffect(() => window.rom.research.onProgress(setProgress), []);

  async function run(): Promise<void> {
    setRunning(true);
    setError(null);
    setProgress(null);
    try {
      setReport(await window.rom.research.calibrate(horizon));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  return (
    <>
      <div className="card">
        <div className="card-title">What this app has actually measured</div>
        <p className="hint" style={{ marginTop: 6 }}>
          Seven strategies have been tested against recordings like the one below — momentum,
          ladder arbitrage, resting orders, the favourite band, liquidity provision, a
          fair-value model and order flow — and every one lost after fees. Rather than ask you
          to take that on trust, this page runs the study underneath all of them on{" "}
          <b>your</b> data: does a price on this venue mean what it says, and is any error big
          enough to trade through the spread and the fee?
        </p>
      </div>

      <div className="grid stats">
        <Stream
          label="Quotes"
          value={info ? nf.format(info.scans) : "—"}
          hint={info ? `sweeps recorded · ${span(info.firstTs, info.lastTs)} of history` : "loading"}
          ok={!!info && info.scans > 0}
        />
        <Stream
          label="Outcomes"
          value={settle ? nf.format(settle.settled) : "—"}
          hint={settle ? `${nf.format(settle.pending)} awaiting settlement` : "loading"}
          ok={!!settle && settle.settled > 0}
        />
        <Stream
          label="Trade tape"
          value={tape?.exists ? nf.format(tape.trades) : "off"}
          hint={tape?.exists ? `real prints · last ${ago(tape.lastTs)}` : "no prints recorded"}
          ok={!!tape?.exists}
        />
        <Stream
          label="Spot"
          value={spot?.exists ? nf.format(spot.points) : "off"}
          hint={spot?.exists ? `minutes across ${spot.assets} assets` : "no underlying recorded"}
          ok={!!spot?.exists}
        />
        <Stream
          label="Order book"
          value={depth?.exists ? nf.format(depth.points) : "off"}
          hint={depth?.exists ? `snapshots · ${nf.format(depth.markets)} markets` : "no depth recorded"}
          ok={!!depth?.exists}
        />
      </div>

      <div className="card">
        <div className="card-title">Is this book mispriced?</div>
        <p className="hint" style={{ marginTop: 6 }}>
          One quote per settled market, taken a fixed time before it closed, bucketed by price
          and compared against what actually happened. Confidence intervals count{" "}
          <b>events, not contracts</b> — a ladder of strikes over one hour settles on a single
          move, so twelve rows there are one observation, not twelve.
        </p>

        <div className="row-controls" style={{ marginTop: 12, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <label className="hint" htmlFor="horizon">
            Price the market
          </label>
          <select
            id="horizon"
            value={horizon}
            disabled={running}
            onChange={(e) => setHorizon(Number(e.target.value))}
          >
            {[5, 10, 15, 30, 60].map((h) => (
              <option key={h} value={h}>
                {h} min before close
              </option>
            ))}
          </select>
          <button className="btn primary" disabled={running} onClick={() => void run()}>
            {running ? "Measuring…" : "Run the study"}
          </button>
          {running && progress && (
            <span className="hint">
              reading {progress.file} ({progress.index + 1}/{progress.total})
            </span>
          )}
        </div>

        {error && (
          <div className="hint neg" style={{ marginTop: 10 }}>
            {error}
          </div>
        )}
      </div>

      {report && (
        <>
          <div className="card">
            <div className="card-title">Verdict</div>
            <p style={{ marginTop: 6 }}>{report.verdict}</p>
            <div className="hint" style={{ marginTop: 8 }}>
              {nf.format(report.markets)} settled markets ·{" "}
              <b>{nf.format(report.events)} independent events</b> ·{" "}
              {(report.yesRate * 100).toFixed(1)}% settled YES
              {report.yesRate < 0.45 && (
                <>
                  {" "}
                  — most markets resolve NO, so anything that leans NO wins by structure
                  alone. That is why the table below compares against buying each side
                  outright rather than against a coin flip.
                </>
              )}
            </div>

            {report.tradeable.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="hint">
                  Bands whose entire clustered interval clears zero:
                </div>
                <ul className="hint" style={{ marginTop: 6 }}>
                  {report.tradeable.map((t) => (
                    <li key={t} className="pos">
                      {t}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {report.suppressed.length > 0 && (
              <div className="hint" style={{ marginTop: 12 }}>
                Not shown as findings, because they rest on too few independent events for the
                position sizer to act on:
                <ul style={{ marginTop: 6 }}>
                  {report.suppressed.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>

          {report.bands.length > 0 && (
            <div className="card">
              <div className="card-title">By entry price</div>
              <table className="compact">
                <thead>
                  <tr>
                    <th>Quoted</th>
                    <th>Markets</th>
                    <th>Events</th>
                    <th>Settled YES</th>
                    <th>Gap</th>
                    <th>Buy YES</th>
                    <th>Buy NO</th>
                  </tr>
                </thead>
                <tbody>
                  {report.bands.map((b) => (
                    <tr key={b.label}>
                      <td>{b.label}</td>
                      <td className="muted">{b.n}</td>
                      <td className="muted">{b.events}</td>
                      <td>{(b.realised * 100).toFixed(0)}%</td>
                      <td className={b.gapPp >= 0 ? "pos" : "neg"}>
                        {b.gapPp >= 0 ? "+" : ""}
                        {b.gapPp.toFixed(1)}pp
                      </td>
                      <td className={b.buyYesCI[0] > 0 ? "pos" : b.buyYesCI[1] < 0 ? "neg" : ""}>
                        {cents(b.buyYes)}
                        <span className="muted">
                          {" "}
                          [{cents(b.buyYesCI[0])}, {cents(b.buyYesCI[1])}]
                        </span>
                      </td>
                      <td className={b.buyNoCI[0] > 0 ? "pos" : b.buyNoCI[1] < 0 ? "neg" : ""}>
                        {cents(b.buyNo)}
                        <span className="muted">
                          {" "}
                          [{cents(b.buyNoCI[0])}, {cents(b.buyNoCI[1])}]
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="hint" style={{ marginTop: 10 }}>
                <b>Gap</b> is what settled minus what was quoted: positive means YES was cheap
                in that band. A gap only matters if the two right-hand columns survive it —
                they are net of the spread and the one-lot fee, so they are what buying that
                band would actually have paid. A band counts only when its whole interval sits
                above zero; a positive average with an interval straddling zero is noise
                wearing a good result.
              </div>
            </div>
          )}
        </>
      )}

      {!report && (
        <div className="card">
          <div className="hint">
            Nothing measured yet this session. The study reads only what ROM Trader has already
            recorded, so it needs no API key and touches no network — and it can return an
            answer you would rather not hear, which is the point of running it.
          </div>
        </div>
      )}
    </>
  );
}
