import { useCallback, useEffect, useState } from "react";
import type { AppSettings, EngineState, UpdateState } from "./types";
import Dashboard from "./pages/Dashboard";
import Positions from "./pages/Positions";
import Signals from "./pages/Signals";
import History from "./pages/History";
import Strategies from "./pages/Strategies";
import Backtest from "./pages/Backtest";
import Connection from "./pages/Connection";
import SettingsPage from "./pages/Settings";
import Logs from "./pages/Logs";
import Welcome from "./pages/Welcome";
import { Confirm, money, pnlClass, signedMoney, useToast } from "./ui";
import appIcon from "../assets/icon-256.png";

type Page =
  | "dashboard"
  | "positions"
  | "signals"
  | "history"
  | "strategies"
  | "backtest"
  | "connection"
  | "settings"
  | "logs";

const NAV: { id: Page; icon: string; label: string }[] = [
  { id: "dashboard", icon: "▦", label: "Dashboard" },
  { id: "positions", icon: "◈", label: "Positions" },
  { id: "signals", icon: "∿", label: "Signals" },
  { id: "history", icon: "◷", label: "History" },
  { id: "strategies", icon: "◆", label: "Strategies" },
  { id: "backtest", icon: "⟲", label: "Backtest" },
  { id: "connection", icon: "⚿", label: "Connection" },
  { id: "settings", icon: "⚙", label: "Settings" },
  { id: "logs", icon: "≡", label: "Logs" },
];

export default function App() {
  const [page, setPage] = useState<Page>("dashboard");
  const [state, setState] = useState<EngineState | null>(null);
  const [appState, setAppState] = useState<AppSettings | null>(null);
  const [version, setVersion] = useState("");
  const [busy, setBusy] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [update, setUpdate] = useState<UpdateState | null>(null);
  const [accountUsd, setAccountUsd] = useState<number | null>(null);
  const [confirmFlatten, setConfirmFlatten] = useState(false);
  const toast = useToast();

  const refresh = useCallback(async () => {
    setState(await window.rom.engine.getState());
  }, []);

  useEffect(() => {
    void refresh();
    void window.rom.app.version().then(setVersion);
    void window.rom.state.get().then(setAppState);
    void window.rom.window.isMaximized().then(setMaximized);
    void window.rom.update.get().then(setUpdate);
    const offState = window.rom.engine.onState(setState);
    const offMax = window.rom.window.onMaximizeChange(setMaximized);
    const offUpdate = window.rom.update.onState(setUpdate);
    const poll = setInterval(() => void refresh(), 5000);
    const bal = setInterval(() => {
      void window.rom.engine.getState().then((s) => {
        if (s.authConfigured && !s.dryRun) void window.rom.kalshi.balance().then(setAccountUsd);
        else setAccountUsd(null);
      });
    }, 30000);
    return () => {
      offState();
      offMax();
      offUpdate();
      clearInterval(poll);
      clearInterval(bal);
    };
  }, [refresh]);

  const running = state?.status === "running";
  const positions = state?.positions.length ?? 0;
  const live = state ? state.authConfigured && !state.dryRun : false;

  async function toggleEngine() {
    setBusy(true);
    try {
      if (running) {
        await window.rom.engine.stop();
        toast("info", "Engine stopped. Open positions were closed at the current bid.");
      } else {
        await window.rom.engine.start();
        toast("ok", state?.dryRun ? "Engine started in dry-run mode." : "Engine started in LIVE mode.");
      }
      await refresh();
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function doFlatten() {
    setConfirmFlatten(false);
    try {
      const n = await window.rom.engine.flatten();
      toast(n > 0 ? "ok" : "info", n > 0 ? `Closed ${n} position${n === 1 ? "" : "s"}.` : "Nothing was open.");
      await refresh();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  if (appState && !appState.disclaimerAccepted) {
    return (
      <Welcome
        onAccept={async () => {
          setAppState(await window.rom.state.set({ disclaimerAccepted: true }));
        }}
      />
    );
  }

  const roi =
    state && state.dryRun && state.cashUsd >= 0 && state.equityUsd > 0 && state.sessionPnlUsd !== 0
      ? (state.sessionPnlUsd / Math.max(1, state.equityUsd - state.sessionPnlUsd)) * 100
      : 0;

  return (
    <>
      <div className="titlebar">
        <div className="tb-drag">
          <img src={appIcon} alt="" />
          <span className="tb-name">ROM TRADER</span>
          <span className="tb-ver">v{version || "1.0.0"}</span>
          <span className={`dot ${running ? "on" : "off"}`} />
          <span className="tb-status">{running ? "Running" : "Idle"}</span>
          {state && !state.dryRun && <span className="pill live">LIVE</span>}
          {update?.status === "ready" && (
            <button className="tb-update" onClick={() => setPage("settings")}>
              Update to v{update.newVersion}
            </button>
          )}
        </div>
        <div className="tb-controls">
          <button onClick={() => window.rom.window.minimize()} aria-label="Minimize">
            ─
          </button>
          <button onClick={() => window.rom.window.maximize()} aria-label="Maximize">
            {maximized ? "❐" : "▢"}
          </button>
          <button className="x" onClick={() => window.rom.window.close()} aria-label="Close">
            ✕
          </button>
        </div>
      </div>

      <div className="shell">
        <aside className="sidebar">
          {NAV.map((n) => (
            <button
              key={n.id}
              className={`nav-item ${page === n.id ? "active" : ""}`}
              onClick={() => setPage(n.id)}
            >
              <span className="nav-icon">{n.icon}</span>
              <span>{n.label}</span>
              {n.id === "positions" && positions > 0 && <span className="badge">{positions}</span>}
            </button>
          ))}
          <div className="sidebar-foot">
            <div className="wallet">
              <div className="wallet-top">
                <span>Balance</span>
                <span className={`tag ${state?.dryRun ? "" : "live"}`}>
                  {state?.dryRun ? "PAPER" : "LIVE"}
                </span>
              </div>
              <div className="wallet-value">
                {live && accountUsd !== null ? money(accountUsd) : money(state?.equityUsd ?? 0)}
              </div>
              <div className="wallet-sub">
                cash {money(state?.cashUsd ?? 0)} · {positions} open
              </div>
            </div>
          </div>
        </aside>

        <div className="main">
          <div className="topbar">
            <div className="topbar-title">
              <span className="title">{NAV.find((n) => n.id === page)?.label}</span>
              <span className="topbar-sub">
                {running
                  ? state?.lastTickAt
                    ? `scanning · last sweep ${new Date(state.lastTickAt).toLocaleTimeString()}`
                    : "starting first scan…"
                  : "engine idle"}
              </span>
            </div>

            <div className="topbar-stats">
              <div className="tstat">
                <span className="k">Session</span>
                <span className={`v ${pnlClass(state?.sessionPnlUsd ?? 0)}`}>
                  {signedMoney(state?.sessionPnlUsd ?? 0)}
                </span>
              </div>
              <div className="tstat">
                <span className="k">Today</span>
                <span className={`v ${pnlClass(state?.todayPnlUsd ?? 0)}`}>
                  {signedMoney(state?.todayPnlUsd ?? 0)}
                </span>
              </div>
              <div className="tstat">
                <span className="k">ROI</span>
                <span className={`v ${pnlClass(roi)}`}>
                  {roi >= 0 ? "+" : ""}
                  {roi.toFixed(1)}%
                </span>
              </div>
            </div>

            <button
              className="btn quiet"
              onClick={() => setConfirmFlatten(true)}
              disabled={positions === 0}
              title="Close every open position right now"
            >
              Flatten
            </button>
            <button
              className={`btn ${running ? "danger" : "primary"}`}
              onClick={toggleEngine}
              disabled={busy}
            >
              {busy ? "…" : running ? "Stop Trading" : "Start Trading"}
            </button>
          </div>

          <div className="content">
            {page === "dashboard" && <Dashboard state={state} onNavigate={(p) => setPage(p as Page)} />}
            {page === "positions" && <Positions state={state} />}
            {page === "signals" && <Signals running={running} idleHint={state?.idleHint ?? null} />}
            {page === "history" && <History onChanged={refresh} />}
            {page === "strategies" && <Strategies />}
            {page === "backtest" && <Backtest />}
            {page === "connection" && <Connection onChanged={refresh} />}
            {page === "settings" && <SettingsPage onChanged={refresh} />}
            {page === "logs" && <Logs />}
          </div>
        </div>
      </div>

      <Confirm
        open={confirmFlatten}
        title="Close all open positions?"
        body={
          <>
            This sells all {positions} open position{positions === 1 ? "" : "s"} at the current bid
            and records them to history.
            {state && !state.dryRun && (
              <>
                {" "}
                <strong>Live mode is on, so these are real orders.</strong>
              </>
            )}
          </>
        }
        confirmLabel="Close them"
        danger
        onConfirm={doFlatten}
        onCancel={() => setConfirmFlatten(false)}
      />
    </>
  );
}
