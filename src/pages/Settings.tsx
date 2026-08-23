import { useEffect, useState } from "react";
import type { AppSettings, Settings } from "../types";
import { Confirm, NumberField, Toggle, useToast } from "../ui";

export default function SettingsPage({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [appState, setAppState] = useState<AppSettings | null>(null);
  const [dataDir, setDataDir] = useState("");
  const [dirty, setDirty] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void window.rom.settings.get().then(setSettings);
    void window.rom.state.get().then(setAppState);
    void window.rom.app.dataDir().then(setDataDir);
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

  async function setApp(patch: Partial<AppSettings>) {
    try {
      setAppState(await window.rom.state.set(patch));
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

  const riskPerTrade = (settings.tradeSizeUsd * settings.stopLossCents) / 100;
  const maxExposure = settings.tradeSizeUsd * settings.maxPositions;

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
        </div>
        <div className="callout">
          At these settings a stopped-out trade loses about{" "}
          <strong>${riskPerTrade.toFixed(2)}</strong>, and the most you can have at risk at once is{" "}
          <strong>${maxExposure.toFixed(2)}</strong>.
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
        </div>
        {settings.takeProfitCents <= settings.stopLossCents && (
          <div className="notice warn">
            Your take-profit is not larger than your stop, so you need to win well over half your
            trades just to break even before fees.
          </div>
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
        </div>
      </div>

      <div className="sticky-save">
        <button className="btn primary" onClick={save} disabled={!dirty}>
          {dirty ? "Save changes" : "All changes saved"}
        </button>
        {dirty && <span className="hint">Unsaved changes</span>}
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
          </>
        )}
        <div className="row-actions">
          <button className="btn quiet" onClick={() => void window.rom.app.openDataFolder()}>
            Open data folder
          </button>
          <button className="btn danger quiet" onClick={() => setConfirmReset(true)}>
            Reset everything
          </button>
        </div>
        {dataDir && <div className="path-hint">{dataDir}</div>}
      </div>

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
