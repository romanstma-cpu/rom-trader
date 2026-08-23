import { useEffect, useState } from "react";
import type { Settings, TestResult } from "../types";
import { Confirm, Field, Toggle, useToast } from "../ui";

export default function Connection({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [dirty, setDirty] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void window.rom.settings.get().then(setSettings);
  }, []);

  if (!settings) return <div className="empty">Loading…</div>;

  function update(patch: Partial<Settings>) {
    setSettings((s) => (s ? { ...s, ...patch } : s));
    setDirty(true);
    setResult(null);
  }

  async function save(next?: Settings) {
    const target = next ?? settings;
    if (!target) return;
    try {
      const saved = await window.rom.settings.set(target);
      setSettings(saved);
      setDirty(false);
      onChanged();
      toast("ok", "Connection settings saved.");
      return saved;
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      if (dirty) await save();
      const r = await window.rom.kalshi.test();
      setResult(r);
      toast(r.ok ? "ok" : "bad", r.message);
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  const hasKeys = settings.apiKeyId.trim() !== "" && settings.apiPrivateKeyPem.trim() !== "";

  async function onLiveToggle(v: boolean) {
    if (!v) {
      const next = { ...settings!, liveMode: false };
      setSettings(next);
      await save(next);
      return;
    }
    setConfirmLive(true);
  }

  async function confirmLiveOn() {
    setConfirmLive(false);
    const next = { ...settings!, liveMode: true };
    setSettings(next);
    await save(next);
    toast("info", "Live mode is on. The engine will place real orders when it next trades.");
  }

  return (
    <>
      <div className="page-sub">
        Your Kalshi API credentials. They are written to a file on this PC and sent only to
        Kalshi's API — never to anyone else. Without them the bot still runs, paper-trading against
        live prices.
      </div>

      <div className="card">
        <div className="card-head">
          <div className="label">Kalshi credentials</div>
          <span className={`tag ${hasKeys ? "live" : ""}`}>{hasKeys ? "configured" : "not set"}</span>
        </div>

        <Field
          label="API Key ID"
          help="From Kalshi → Account → API Keys. Looks like a UUID."
        >
          <input
            type="text"
            value={settings.apiKeyId}
            onChange={(e) => update({ apiKeyId: e.target.value })}
            placeholder="00000000-0000-0000-0000-000000000000"
            spellCheck={false}
          />
        </Field>

        <Field
          label="RSA Private Key (PEM)"
          help="The whole block Kalshi gave you when you created the key, including the BEGIN and END lines. Kalshi shows it once."
        >
          <textarea
            value={settings.apiPrivateKeyPem}
            onChange={(e) => update({ apiPrivateKeyPem: e.target.value })}
            placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----"}
            spellCheck={false}
            rows={7}
          />
        </Field>

        <div className="row-actions">
          <button className="btn primary" onClick={() => save()} disabled={!dirty}>
            {dirty ? "Save" : "Saved"}
          </button>
          <button className="btn quiet" onClick={test} disabled={testing || !hasKeys}>
            {testing ? "Testing…" : "Test connection"}
          </button>
        </div>

        {result && (
          <div className={`notice ${result.ok ? "good" : "bad"}`}>
            {result.ok ? "✓ " : "✕ "}
            {result.message}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div className="label">Trading mode</div>
        </div>
        <Toggle
          label="Live mode — place real orders with real money"
          help={
            hasKeys
              ? "Off means the bot paper-trades against live prices and places no orders. This is the safe default."
              : "Add and test your API keys above before this can be switched on."
          }
          checked={settings.liveMode}
          onChange={onLiveToggle}
          danger
        />
        {!hasKeys && settings.liveMode && (
          <div className="notice warn">
            Live mode is on but no keys are set, so the bot is still paper-trading.
          </div>
        )}
      </div>

      <Confirm
        open={confirmLive}
        title="Turn on live trading?"
        body={
          <>
            The engine will place <strong>real orders against real money</strong> in your Kalshi
            account, automatically and without asking again.
            <br />
            <br />
            Test your connection first, keep the trade size small, and set a daily loss limit in
            Settings. You are responsible for every order it places.
          </>
        }
        confirmLabel="Enable live trading"
        danger
        onConfirm={confirmLiveOn}
        onCancel={() => setConfirmLive(false)}
      />
    </>
  );
}
