import { useEffect, useState } from "react";
import type { CredentialStatus, Settings, TestResult } from "../types";
import { Confirm, Field, Toggle, useToast } from "../ui";

export default function Connection({ onChanged }: { onChanged: () => void }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [cred, setCred] = useState<CredentialStatus | null>(null);
  const [keyId, setKeyId] = useState("");
  const [pem, setPem] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);
  const [confirmLive, setConfirmLive] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const toast = useToast();

  useEffect(() => {
    void window.rom.settings.get().then(setSettings);
    void window.rom.credentials.status().then((s) => {
      setCred(s);
      // Nothing saved yet, so open straight into the form.
      if (!s.configured) setEditing(true);
    });
  }, []);

  if (!settings || !cred) return <div className="empty">Loading…</div>;

  const hasKeys = cred.configured;
  const canSubmit = keyId.trim() !== "" && pem.trim() !== "";

  async function saveKeys() {
    if (!canSubmit) return;
    setSaving(true);
    setResult(null);
    try {
      const next = await window.rom.credentials.set({ apiKeyId: keyId, apiPrivateKeyPem: pem });
      setCred(next);
      // Drop the plaintext from renderer memory the moment it is stored.
      setKeyId("");
      setPem("");
      setEditing(false);
      onChanged();
      toast("ok", "Key saved and encrypted for this Windows account.");
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function clearKeys() {
    setConfirmClear(false);
    try {
      const next = await window.rom.credentials.clear();
      setCred(next);
      setSettings(await window.rom.settings.get());
      setEditing(true);
      setResult(null);
      onChanged();
      toast("info", "Key removed. Live mode was switched off.");
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      const r = await window.rom.kalshi.test();
      setResult(r);
      toast(r.ok ? "ok" : "bad", r.message);
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function onLiveToggle(v: boolean) {
    if (!v) {
      const next = { ...settings!, liveMode: false };
      setSettings(await window.rom.settings.set(next));
      onChanged();
      return;
    }
    setConfirmLive(true);
  }

  async function confirmLiveOn() {
    setConfirmLive(false);
    setSettings(await window.rom.settings.set({ ...settings!, liveMode: true }));
    onChanged();
    toast("info", "Live mode is on. The engine will place real orders when it next trades.");
  }

  return (
    <>
      <div className="page-sub">
        Your Kalshi API key is encrypted with your Windows account and stored on this PC. It is sent
        only to Kalshi's API, and never shown again once saved. Without it the bot still runs,
        paper-trading against live prices.
      </div>

      {!cred.encryptionAvailable && (
        <div className="notice bad">
          Windows did not offer a credential store, so no key can be saved. Live trading is
          unavailable until this is resolved.
        </div>
      )}
      {cred.error && <div className="notice warn">{cred.error}</div>}

      <div className="card">
        <div className="card-head">
          <div className="label">Kalshi credentials</div>
          <span className={`tag ${hasKeys ? "live" : ""}`}>
            {hasKeys ? "configured" : "not set"}
          </span>
        </div>

        {hasKeys && !editing ? (
          <>
            <div className="mini-stats">
              <div>
                <span className="k">Key ID</span>
                <span className="v mono">{cred.keyIdHint}</span>
              </div>
              <div>
                <span className="k">Private key</span>
                <span className="v">encrypted · not readable</span>
              </div>
            </div>
            <div className="row-actions">
              <button className="btn quiet" onClick={test} disabled={testing}>
                {testing ? "Testing…" : "Test connection"}
              </button>
              <button className="btn quiet" onClick={() => setEditing(true)}>
                Replace key
              </button>
              <button className="btn danger" onClick={() => setConfirmClear(true)}>
                Remove key
              </button>
            </div>
          </>
        ) : (
          <>
            <Field label="API Key ID" help="From Kalshi → Account → API Keys. Looks like a UUID.">
              <input
                type="text"
                value={keyId}
                onChange={(e) => setKeyId(e.target.value)}
                placeholder="00000000-0000-0000-0000-000000000000"
                spellCheck={false}
                autoComplete="off"
              />
            </Field>

            <Field
              label="RSA Private Key (PEM)"
              help="The whole block Kalshi gave you when you created the key, including the BEGIN and END lines. Kalshi shows it once, and so do we — after saving it cannot be read back out of this app."
            >
              <textarea
                value={pem}
                onChange={(e) => setPem(e.target.value)}
                placeholder={"-----BEGIN RSA PRIVATE KEY-----\n…\n-----END RSA PRIVATE KEY-----"}
                spellCheck={false}
                autoComplete="off"
                rows={7}
              />
            </Field>

            <div className="row-actions">
              <button
                className="btn primary"
                onClick={saveKeys}
                disabled={!canSubmit || saving || !cred.encryptionAvailable}
              >
                {saving ? "Saving…" : "Save key"}
              </button>
              {hasKeys && (
                <button
                  className="btn quiet"
                  onClick={() => {
                    setKeyId("");
                    setPem("");
                    setEditing(false);
                  }}
                >
                  Cancel
                </button>
              )}
            </div>
          </>
        )}

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
              : "Add and test your API key above before this can be switched on."
          }
          checked={settings.liveMode}
          onChange={onLiveToggle}
          disabled={!hasKeys && !settings.liveMode}
          danger
        />
        {!hasKeys && settings.liveMode && (
          <div className="notice warn">
            Live mode is on but no key is set, so the bot is still paper-trading.
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

      <Confirm
        open={confirmClear}
        title="Remove your Kalshi key?"
        body={
          <>
            The encrypted key is deleted from this PC and live mode is switched off. The bot keeps
            running as a paper trader.
            <br />
            <br />
            Kalshi only shows a private key once, so make sure you have it saved elsewhere — or be
            ready to create a new one.
          </>
        }
        confirmLabel="Remove it"
        danger
        onConfirm={clearKeys}
        onCancel={() => setConfirmClear(false)}
      />
    </>
  );
}
