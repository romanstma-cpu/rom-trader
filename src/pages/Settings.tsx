import { useEffect, useState } from "react";
import type { AppSettings, Settings, UpdateState } from "../types";
import { Confirm, NumberField, Toggle, useToast } from "../ui";
// Shared with the engine rather than reimplemented: a fee formula that drifts
// between what the UI promises and what the bot charges is worse than none.
import {
  breakEvenWinRate,
  roundTripFeeCentsPerContract,
  roundTripFeeUsd,
  takerFeeCentsPerContract,
  takerFeeUsd,
} from "../../electron/engine/fees";

/** Field names as they read on screen, for the empty-box warning. */
const FIELD_LABELS: Partial<Record<keyof Settings, string>> = {
  tradeSizeUsd: "Trade size",
  maxPositions: "Max open positions",
  dryRunCash: "Paper cash",
  dailyLossLimitUsd: "Daily loss limit",
  maxConsecutiveLosses: "Stop after losses in a row",
  maxDrawdownPct: "Max session drawdown",
  momentumThresholdCents: "Momentum trigger",
  takeProfitCents: "Take profit",
  stopLossCents: "Stop loss",
  tickSeconds: "Scan interval",
  reentryCooldownSeconds: "Re-entry cooldown",
  trailingStopCents: "Trailing stop",
  minNetEdgeCents: "Min net edge",
  makerTtlTicks: "Order lifetime",
  maxSpreadCents: "Max spread",
  minPriceCents: "Min price",
  maxPriceCents: "Max price",
  tradingStartHour: "From",
  tradingEndHour: "Until",
};

export default function SettingsPage({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [appState, setAppState] = useState<AppSettings | null>(null);
  const [dataDir, setDataDir] = useState("");
  const [dirty, setDirty] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [confirmTrading, setConfirmTrading] = useState(false);
  const [upd, setUpd] = useState<UpdateState | null>(null);
  const [installBlocked, setInstallBlocked] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    void window.rom.settings.get().then(setSettings);
    void window.rom.state.get().then(setAppState);
    void window.rom.app.dataDir().then(setDataDir);
    void window.rom.update.get().then(setUpd);
    return window.rom.update.onState(setUpd);
  }, []);

  if (!settings) return <div className="empty">Loading…</div>;

  function update(patch: Partial<Settings>) {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    setDirty(true);
  }

  async function save() {
    try {
      setSettings(await window.rom.settings.set(settings!));
      setDirty(false);
      onChanged();
      toast("ok", "Settings saved and applied to the running engine.");
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  /**
   * Number fields that have been emptied out.
   *
   * An empty box is NaN, and the settings sanitiser turns a non-finite number
   * back into its factory default — so clearing "Daily loss limit" to type a
   * new one and hitting Save silently restored 50, which looked exactly like
   * the app refusing to accept the change. Saving is blocked until the box has
   * a number in it again.
   */
  const blanks = settings
    ? (Object.keys(settings) as (keyof Settings)[]).filter(
        (k) => typeof settings[k] === "number" && !Number.isFinite(settings[k] as number),
      )
    : [];

  async function setApp(patch: Partial<AppSettings>) {
    try {
      setAppState(await window.rom.state.set(patch));
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  async function doResetTrading() {
    setConfirmTrading(false);
    try {
      await window.rom.app.resetTradingData();
      onChanged();
      toast("ok", "Trade history, equity curve and halts cleared. Keys and settings kept.");
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  async function doReset() {
    setConfirmReset(false);
    try {
      setSettings(await window.rom.app.factoryReset());
      setAppState(await window.rom.state.get());
      setDirty(false);
      onChanged();
      toast("ok", "Everything reset to defaults.");
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  async function checkUpdates() {
    try {
      setUpd(await window.rom.update.check());
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  async function install(force: boolean) {
    setInstallBlocked(null);
    try {
      const res = await window.rom.update.install(force);
      // A resolved value only comes back when the install was refused;
      // otherwise the app is already restarting.
      if (res && res.installed === false) {
        if (force) toast("bad", res.reason);
        else setInstallBlocked(res.reason);
      }
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  // Worked at the midpoint of the configured price band, which is where the
  // fee curve peaks and therefore where the numbers are least flattering.
  const refPrice = Math.round((settings.minPriceCents + settings.maxPriceCents) / 2);
  const contracts = Math.max(1, Math.floor((settings.tradeSizeUsd * 100) / refPrice));
  // A maker entry pays nothing to open; only the taker exit remains. Every
  // number below prices the trade the way the engine will actually do it.
  const maker = settings.makerEntries;
  const feeUsd = maker
    ? takerFeeUsd(contracts, refPrice)
    : roundTripFeeUsd(contracts, refPrice, refPrice);
  const feeCents = maker
    ? takerFeeCentsPerContract(refPrice)
    : roundTripFeeCentsPerContract(refPrice);

  // The old figure assumed $1 contracts and ignored fees, so it understated a
  // stop-out by more than half at mid prices.
  const riskPerTrade = (contracts * settings.stopLossCents) / 100 + feeUsd;
  const rewardPerTrade = (contracts * settings.takeProfitCents) / 100 - feeUsd;
  const maxExposure = settings.tradeSizeUsd * settings.maxPositions;
  const breakEven = breakEvenWinRate(
    settings.takeProfitCents,
    settings.stopLossCents,
    refPrice,
    maker,
  );

  return (
    <>
      <div className="page-sub">
        How the engine picks and manages trades. Changes apply to the running engine as soon as you
        save.
      </div>

      <div className="card">
        <div className="card-head">
          <div className="label">Position sizing</div>
        </div>
        <div className="field-grid">
          <NumberField
            label="Trade size"
            suffix="$"
            help="Budget per position. The bot buys as many contracts as this affords at the ask."
            value={settings.tradeSizeUsd}
            min={1}
            onChange={(v) => update({ tradeSizeUsd: v })}
          />
          <NumberField
            label="Max open positions"
            help="The bot stops opening new ones past this count."
            value={settings.maxPositions}
            min={1}
            max={50}
            onChange={(v) => update({ maxPositions: v })}
          />
          <NumberField
            label="Paper cash"
            suffix="$"
            help="Starting virtual balance for dry-run. Reset each time the engine starts."
            value={settings.dryRunCash}
            min={1}
            onChange={(v) => update({ dryRunCash: v })}
          />
          <NumberField
            label="Daily loss limit"
            suffix="$"
            help="The engine stops itself once today's closed trades lose this much. 0 disables it."
            value={settings.dailyLossLimitUsd}
            min={0}
            onChange={(v) => update({ dailyLossLimitUsd: v })}
          />
          <NumberField
            label="Stop after losses in a row"
            help="A losing streak usually means the market changed shape or the settings are wrong. 0 disables it."
            value={settings.maxConsecutiveLosses}
            min={0}
            onChange={(v) => update({ maxConsecutiveLosses: v })}
          />
          <NumberField
            label="Max session drawdown"
            suffix="%"
            help="The engine halts once equity falls this far below its session peak, and trade size shrinks as it approaches. 0 disables both."
            value={settings.maxDrawdownPct}
            min={0}
            max={95}
            onChange={(v) => update({ maxDrawdownPct: v })}
          />
        </div>
        <div className="callout">
          At these settings a stopped-out trade loses about{" "}
          <strong>${riskPerTrade.toFixed(2)}</strong> and a winner makes{" "}
          <strong>${rewardPerTrade.toFixed(2)}</strong>, both after Kalshi's fee. The most you can
          have at risk at once is <strong>${maxExposure.toFixed(2)}</strong>.
          <br />
          <br />
          {maker ? (
            <>
              Around {refPrice}c the taker exit costs{" "}
              <strong>{feeCents.toFixed(1)}c per contract</strong> — about ${feeUsd.toFixed(2)} on a
              ${settings.tradeSizeUsd} position. The resting entry pays no fee.{" "}
            </>
          ) : (
            <>
              Around {refPrice}c the round trip costs{" "}
              <strong>{feeCents.toFixed(1)}c per contract</strong> — about ${feeUsd.toFixed(2)} on a
              ${settings.tradeSizeUsd} position, paid whether the trade wins or loses.{" "}
            </>
          )}
          {breakEven === null ? (
            <strong className="neg">
              Your take-profit does not cover that, so this configuration loses money however often
              it is right.
            </strong>
          ) : (
            <>
              You need to win <strong>{(breakEven * 100).toFixed(0)}%</strong> of trades just to
              break even.
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <div className="label">Entry and exit</div>
        </div>
        <div className="field-grid">
          <NumberField
            label="Momentum trigger"
            suffix="c"
            help="Buy when the mid-price has risen this many cents over the last three scans."
            value={settings.momentumThresholdCents}
            min={1}
            onChange={(v) => update({ momentumThresholdCents: v })}
          />
          <NumberField
            label="Take profit"
            suffix="c"
            help="Close once the bid is this far above your entry."
            value={settings.takeProfitCents}
            min={1}
            onChange={(v) => update({ takeProfitCents: v })}
          />
          <NumberField
            label="Stop loss"
            suffix="c"
            help="Close once the bid falls this far below your entry."
            value={settings.stopLossCents}
            min={1}
            onChange={(v) => update({ stopLossCents: v })}
          />
          <NumberField
            label="Scan interval"
            suffix="s"
            help="How often to poll Kalshi. Shorter means more trades and more API traffic."
            value={settings.tickSeconds}
            min={5}
            max={600}
            onChange={(v) => update({ tickSeconds: v })}
          />
          <NumberField
            label="Re-entry cooldown"
            suffix="s"
            help="After closing a market, wait this long before buying it again. Without it a take-profit can re-buy at the ask on the very next scan and pay the spread twice. 0 disables."
            value={settings.reentryCooldownSeconds}
            min={0}
            max={3600}
            onChange={(v) => update({ reentryCooldownSeconds: v })}
          />
          <NumberField
            label="Trailing stop"
            suffix="c"
            help="Exit once the mid falls this far from its peak since entry. The simulations found tight values close winners before the take-profit can — leave at 0 unless you have measured otherwise."
            value={settings.trailingStopCents}
            min={0}
            max={90}
            onChange={(v) => update({ trailingStopCents: v })}
          />
          <NumberField
            label="Min net edge"
            suffix="c"
            help="Refuse entries whose take-profit clears the fees by less than this. An edge of half a cent is not worth the risk taken to collect it."
            value={settings.minNetEdgeCents}
            min={0}
            max={30}
            onChange={(v) => update({ minNetEdgeCents: v })}
          />
        </div>
        <Toggle
          label="Measure momentum on the bid"
          help="The mid-price rises when a seller pulls an ask — with nothing traded. The bid only rises when a buyer actually pays more. On real recordings most overnight 'momentum' was quote movement, not buying."
          checked={settings.momentumOnBid}
          onChange={(v) => update({ momentumOnBid: v })}
        />
        <Toggle
          label="Require traded volume"
          help="Skip entries when no contracts traded during the momentum window. A book that moved without a single print is a market maker repositioning, not a move."
          checked={settings.requireTradeActivity}
          onChange={(v) => update({ requireTradeActivity: v })}
        />
        {settings.takeProfitCents <= settings.stopLossCents && (
          <div className="notice warn">
            Your take-profit is not larger than your stop, so you need to win well over half your
            trades just to break even before fees.
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div className="label">Order type</div>
          <span className="hint">How entries reach the book</span>
        </div>
        <Toggle
          label="Enter with resting limit orders (maker)"
          help="Rest a buy at the bid instead of crossing to the ask. No taker fee and no spread paid on entry — the two costs that dominated every simulation. The trade-off: fills are not guaranteed, and the ones that arrive come when the price dips back to your bid."
          checked={settings.makerEntries}
          onChange={(v) => update({ makerEntries: v })}
        />
        {settings.makerEntries && (
          <>
            <div className="field-grid">
              <NumberField
                label="Order lifetime"
                suffix=" scans"
                help="How many scans a resting order waits before being cancelled unfilled. Longer catches more fills, but the momentum that justified the order goes stale."
                value={settings.makerTtlTicks}
                min={1}
                max={120}
                onChange={(v) => update({ makerTtlTicks: v })}
              />
            </div>
            <div className="callout">
              With a {settings.tickSeconds}s scan, an order rests for about{" "}
              <strong>{settings.makerTtlTicks * settings.tickSeconds}s</strong> before it is
              cancelled. Exits still cross the spread — a stop-loss that waits politely at the bid
              is not a stop-loss.
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div className="label">Trading hours</div>
          <span className="hint">When it is allowed to open anything</span>
        </div>
        <Toggle
          label="Only open positions during set hours"
          help="Prices are still tracked outside the window, so momentum history is warm when it opens. Positions already open are still managed to their exit — it will not abandon one at the bell."
          checked={settings.tradingHoursEnabled}
          onChange={(v) => update({ tradingHoursEnabled: v })}
        />
        {settings.tradingHoursEnabled && (
          <>
            <div className="field-grid">
              <NumberField
                label="From"
                suffix=":00"
                help="Local time, 24-hour."
                value={settings.tradingStartHour}
                min={0}
                max={23}
                onChange={(v) => update({ tradingStartHour: v })}
              />
              <NumberField
                label="Until"
                suffix=":00"
                help="Set this earlier than the start for an overnight window."
                value={settings.tradingEndHour}
                min={0}
                max={23}
                onChange={(v) => update({ tradingEndHour: v })}
              />
            </div>
            <div className="callout">
              {settings.tradingStartHour === settings.tradingEndHour ? (
                <>Start and end are the same hour, so the window is ignored and it trades all day.</>
              ) : settings.tradingStartHour < settings.tradingEndHour ? (
                <>
                  Entries allowed between <strong>{settings.tradingStartHour}:00</strong> and{" "}
                  <strong>{settings.tradingEndHour}:00</strong> each day.
                </>
              ) : (
                <>
                  Overnight window: entries allowed from{" "}
                  <strong>{settings.tradingStartHour}:00</strong> through midnight until{" "}
                  <strong>{settings.tradingEndHour}:00</strong> the next morning.
                </>
              )}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div className="label">Market filters</div>
          <span className="hint">Which markets are worth touching at all</span>
        </div>
        <div className="field-grid">
          <NumberField
            label="Max spread"
            suffix="c"
            help="Skip markets whose bid/ask gap is wider than this — you pay it immediately on entry."
            value={settings.maxSpreadCents}
            min={1}
            max={20}
            onChange={(v) => update({ maxSpreadCents: v })}
          />
          <NumberField
            label="Min price"
            suffix="c"
            help="Ignore long shots below this price."
            value={settings.minPriceCents}
            min={1}
            max={98}
            onChange={(v) => update({ minPriceCents: v })}
          />
          <NumberField
            label="Max price"
            suffix="c"
            help="Ignore near-certainties above this price — little room left to run."
            value={settings.maxPriceCents}
            min={2}
            max={99}
            onChange={(v) => update({ maxPriceCents: v })}
          />
          <NumberField
            label="Min time to close"
            suffix="min"
            help="Skip markets closing within this many minutes. Near the close, strikes snap toward 0 or 100 and a momentum entry becomes a bet on the resolution itself. 0 disables."
            value={settings.minMinutesToClose}
            min={0}
            max={115}
            onChange={(v) => update({ minMinutesToClose: v })}
          />
        </div>
        <Toggle
          label="Skip mean-reverting markets (regime filter)"
          help="Momentum assumes the last move predicts the next one. This checks whether a market's recent moves have actually been continuing, and skips it while they have been reversing instead."
          checked={settings.regimeFilterEnabled}
          onChange={(v) => update({ regimeFilterEnabled: v })}
        />
      </div>

      <div className="sticky-save">
        <button className="btn primary" onClick={save} disabled={!dirty || blanks.length > 0}>
          {dirty ? "Save changes" : "All changes saved"}
        </button>
        {blanks.length > 0 ? (
          <span className="hint neg">
            {blanks.map((k) => FIELD_LABELS[k] ?? k).join(", ")}{" "}
            {blanks.length === 1 ? "is" : "are"} empty — type a number to save.
          </span>
        ) : (
          dirty && <span className="hint">Unsaved changes</span>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div className="label">Updates</div>
          <span className="hint">
            {upd ? `You have v${upd.currentVersion}` : ""}
          </span>
        </div>

        {upd?.status === "unsupported" ? (
          <div className="field-help">{upd.message}</div>
        ) : (
          <>
            <div className="update-row">
              <span className={`update-dot ${upd?.status ?? "idle"}`} />
              <span className="update-text">
                {upd?.status === "checking" && "Checking for updates…"}
                {upd?.status === "downloading" &&
                  `Downloading v${upd.newVersion} — ${upd.percent}%`}
                {upd?.status === "available" && upd.message}
                {upd?.status === "ready" && upd.message}
                {upd?.status === "current" && upd.message}
                {upd?.status === "error" && upd.message}
                {(!upd || upd.status === "idle") && "No update check yet."}
              </span>
            </div>

            {upd?.status === "downloading" && (
              <div className="progress" role="progressbar" aria-valuenow={upd.percent} aria-valuemin={0} aria-valuemax={100}>
                <div className="progress-fill" style={{ width: `${upd.percent}%` }} />
              </div>
            )}

            <div className="field-help" style={{ marginTop: 8 }}>
              Updates download in the background but never install on their own — restarting mid-session
              would abandon any open position, so installing is always your call.
            </div>

            <div className="row-actions">
              <button
                className="btn quiet"
                onClick={checkUpdates}
                disabled={upd?.status === "checking" || upd?.status === "downloading"}
              >
                {upd?.status === "checking" ? "Checking…" : "Check for updates"}
              </button>
              {upd?.status === "ready" && (
                <button className="btn primary" onClick={() => install(false)}>
                  Restart and install v{upd.newVersion}
                </button>
              )}
            </div>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div className="label">Application</div>
        </div>
        {appState && (
          <>
            <Toggle
              label="Start with Windows"
              help="Launch ROM Trader when you sign in. The engine still waits for you to press Start."
              checked={appState.startWithWindows}
              onChange={(v) => setApp({ startWithWindows: v })}
            />
            <Toggle
              label="Start minimized"
              help="Open to the taskbar instead of the foreground."
              checked={appState.startMinimized}
              onChange={(v) => setApp({ startMinimized: v })}
            />
            <Toggle
              label="Keep running in the tray when closed"
              help="Closing the window leaves the engine trading in the background. Reopen it from the tray icon, which is also where Stop and Close all positions live."
              checked={appState.closeToTray}
              onChange={(v) => setApp({ closeToTray: v })}
            />
            <Toggle
              label="Desktop notifications"
              help="A Windows toast when a position opens or closes, and whenever the engine stops itself. Only the halts make a sound."
              checked={appState.notifications}
              onChange={(v) => setApp({ notifications: v })}
            />
            <Toggle
              label="Record market data while idle"
              help="Save a market sweep every 30 seconds even when the engine is stopped, so the Backtest page always has real data to replay. Public prices only; nothing is traded and no keys are used."
              checked={appState.passiveRecording}
              onChange={(v) => setApp({ passiveRecording: v })}
            />
          </>
        )}
        <div className="row-actions">
          <button className="btn quiet" onClick={() => void window.rom.app.openDataFolder()}>
            Open data folder
          </button>
          <button className="btn quiet" onClick={() => setConfirmTrading(true)}>
            Reset trading data
          </button>
          <button className="btn danger quiet" onClick={() => setConfirmReset(true)}>
            Reset everything
          </button>
        </div>
        <div className="field-help">
          <strong>Reset trading data</strong> clears trade history, the equity curve and any
          self-imposed halt — your API keys, settings, saved setups and recorded market data all
          stay. <strong>Reset everything</strong> wipes the lot, keys included.
        </div>
        {dataDir && <div className="path-hint">{dataDir}</div>}
      </div>

      <Confirm
        open={installBlocked !== null}
        title="Stop trading and install?"
        body={
          <>
            {installBlocked}
            <br />
            <br />
            Continuing closes every open position at the current bid, records them to history, and
            restarts into the new version.
          </>
        }
        confirmLabel="Close positions and install"
        danger
        onConfirm={async () => {
          try {
            await window.rom.engine.stop();
            onChanged();
          } catch {
            // fall through — the guard below is what actually matters
          }
          void install(true);
        }}
        onCancel={() => setInstallBlocked(null)}
      />

      <Confirm
        open={confirmTrading}
        title="Reset trading data?"
        body={
          <>
            Clears your trade history, the equity curve, and any halt the engine has imposed on
            itself.
            <br />
            <br />
            <strong>Kept:</strong> API keys, all settings, saved setups, and recorded market data.
            <br />
            <br />
            Export your history from the History page first if you want to keep it — this cannot be
            undone.
          </>
        }
        confirmLabel="Clear trading data"
        onConfirm={doResetTrading}
        onCancel={() => setConfirmTrading(false)}
      />

      <Confirm
        open={confirmReset}
        title="Reset everything to defaults?"
        body={
          <>
            This deletes your settings, API keys, saved setups, trade history and equity curve from
            this PC. It cannot be undone.
          </>
        }
        confirmLabel="Reset everything"
        danger
        onConfirm={doReset}
        onCancel={() => setConfirmReset(false)}
      />
    </>
  );
}
