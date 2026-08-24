import { useEffect, useState } from "react";
import type { Profile, Settings, Strategy } from "../types";
import { Confirm, useToast } from "../ui";

export default function Strategies() {
  const [strategies, setStrategies] = useState<Strategy[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [name, setName] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    void window.rom.strategies.list().then(setStrategies);
    void window.rom.profiles.list().then(setProfiles);
    void window.rom.settings.get().then(setSettings);
  }, []);

  async function applyStrategy(s: Strategy) {
    try {
      setSettings(await window.rom.strategies.apply(s.id));
      toast("ok", `Applied "${s.name}". Tune it further in Settings.`);
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  async function saveProfile() {
    try {
      setProfiles(await window.rom.profiles.save(name));
      toast("ok", `Saved "${name.trim()}".`);
      setName("");
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  async function applyProfile(p: Profile) {
    try {
      setSettings(await window.rom.profiles.apply(p.name));
      toast("ok", `Loaded "${p.name}".`);
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  async function deleteProfile() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      setProfiles(await window.rom.profiles.delete(target));
      toast("ok", `Deleted "${target}".`);
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  /** Highlights the preset whose knobs currently match, if any. */
  function isActive(s: Strategy): boolean {
    if (!settings) return false;
    return (Object.keys(s.params) as (keyof typeof s.params)[]).every(
      (k) => settings[k] === s.params[k],
    );
  }

  return (
    <>
      <div className="page-sub">
        Presets are starting points for the momentum rule, not proven edges — none has been
        forward-tested and each one still trades on your settings. Apply one, tweak it in Settings,
        then save the result below as your own.
      </div>

      <div className="strategy-grid">
        {strategies.map((s) => (
          <div key={s.id} className={`card strategy ${isActive(s) ? "active" : ""}`}>
            <div className="strategy-head">
              <div>
                <div className="strategy-name">{s.name}</div>
                <div className="strategy-tag">{s.tagline}</div>
              </div>
              <span className={`risk ${s.risk}`}>{s.risk} risk</span>
            </div>

            <p className="strategy-detail">{s.detail}</p>

            <div className="param-grid">
              <div>
                <span className="k">Trigger</span>
                <span className="v">{s.params.momentumThresholdCents}c</span>
              </div>
              <div>
                <span className="k">Target</span>
                <span className="v">{s.params.takeProfitCents}c</span>
              </div>
              <div>
                <span className="k">Stop</span>
                <span className="v">{s.params.stopLossCents}c</span>
              </div>
              <div>
                <span className="k">Size</span>
                <span className="v">${s.params.tradeSizeUsd}</span>
              </div>
              <div>
                <span className="k">Max open</span>
                <span className="v">{s.params.maxPositions}</span>
              </div>
              <div>
                <span className="k">Scan</span>
                <span className="v">{s.params.tickSeconds}s</span>
              </div>
              <div>
                <span className="k">Entry</span>
                <span className="v">{s.params.makerEntries ? "rests at bid" : "crosses to ask"}</span>
              </div>
            </div>

            <button
              className={`btn ${isActive(s) ? "quiet" : "primary"} wide`}
              onClick={() => applyStrategy(s)}
              disabled={isActive(s)}
            >
              {isActive(s) ? "Currently applied" : "Apply"}
            </button>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-head">
          <div className="label">Your saved setups</div>
          <span className="hint">Snapshots of your settings. Keys and live mode are never stored.</span>
        </div>

        <div className="save-row">
          <input
            type="text"
            placeholder="Name this setup, e.g. “evening crypto”"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && name.trim()) void saveProfile();
            }}
          />
          <button className="btn primary" onClick={saveProfile} disabled={!name.trim()}>
            Save current settings
          </button>
        </div>

        {profiles.length === 0 ? (
          <div className="empty small">
            Nothing saved yet. Apply a preset or tune Settings, then save it here to switch back
            any time.
          </div>
        ) : (
          <table className="tight">
            <tbody>
              {profiles.map((p) => (
                <tr key={p.name}>
                  <td>
                    <strong>{p.name}</strong>
                    <div className="sub">
                      {p.params.momentumThresholdCents}c trigger · {p.params.takeProfitCents}c target ·{" "}
                      {p.params.stopLossCents}c stop · ${p.params.tradeSizeUsd}/trade
                    </div>
                  </td>
                  <td className="muted">{new Date(p.savedAt).toLocaleDateString()}</td>
                  <td className="right">
                    <button className="btn tiny" onClick={() => applyProfile(p)}>
                      Load
                    </button>
                    <button className="btn tiny danger quiet" onClick={() => setPendingDelete(p.name)}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <Confirm
        open={pendingDelete !== null}
        title={`Delete "${pendingDelete}"?`}
        body="The saved setup is removed. Your current settings are not affected."
        confirmLabel="Delete"
        danger
        onConfirm={deleteProfile}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
