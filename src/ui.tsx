import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { AiStatus, EquityPoint, NarrationResult } from "./types";
// Shared with the engine rather than reimplemented: the chart and the replay
// must agree on what counts as a continuous stretch of time.
import { splitAtGaps, sampledMs } from "../electron/engine/series";

/* ---------------- formatting ---------------- */

export function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

export function signedMoney(n: number): string {
  return `${n > 0 ? "+" : ""}${money(n)}`;
}

export function pnlClass(n: number): string {
  return n > 0 ? "pos" : n < 0 ? "neg" : "";
}

export function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/* ---------------- toasts ---------------- */

type Toast = { id: number; kind: "ok" | "bad" | "info"; text: string };
type ToastFn = (kind: Toast["kind"], text: string) => void;

const ToastCtx = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback<ToastFn>((kind, text) => {
    const id = nextId.current++;
    setItems((xs) => [...xs, { id, kind, text }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 4200);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span className="toast-mark">{t.kind === "ok" ? "✓" : t.kind === "bad" ? "!" : "i"}</span>
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ---------------- confirm dialog ---------------- */

export function Confirm({
  open,
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">{title}</div>
        <div className="modal-body">{body}</div>
        <div className="modal-actions">
          <button className="btn quiet" onClick={onCancel}>
            Cancel
          </button>
          <button className={`btn ${danger ? "danger" : "primary"}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- form field ---------------- */

/**
 * ROM's Kalshi sign-up card.
 *
 * Renders nothing at all when no referral code is configured, which is the
 * whole safety property: there is no state in which this ships a button that
 * goes nowhere or credits nobody. Kalshi accepts a referral code only before
 * the first deposit and within 72 hours of signup, so a link that quietly
 * fails cannot be repaired for the person who clicked it.
 *
 * The copy is Kalshi's own — "up to $500" — because the published distribution
 * is $15 for roughly seven claimants in ten, and a flat headline figure would
 * be a number most readers never see. The conditions are stated rather than
 * buried: this is a promotional claim about a regulated venue, and the trading
 * requirement, the verification and the seven-day expiry are the parts that
 * decide whether the offer is worth anything to the person reading it. That
 * ROM is paid for the referral is on the card for the same reason.
 */
export function KalshiSignup() {
  const [url, setUrl] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    void window.rom.app.referral().then(setUrl);
  }, []);

  if (!url) return null;

  async function open() {
    try {
      await window.rom.app.openReferral();
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  return (
    <div className="promo">
      <div className="promo-body">
        <div className="promo-title">No Kalshi account yet?</div>
        <div className="promo-text">
          ROM Trader needs one to trade. Sign up through this link and Kalshi adds a welcome
          bonus of <strong>up to $500</strong> in trading credit.
        </div>
        <div className="promo-fine">
          Kalshi's offer, not ROM's. Most people get $15 — the published split is $15 for 70% of
          claims, $35 for 24%, and larger amounts below that. Needs ID verification and a trading
          requirement Kalshi sets, and the credit expires 7 days after it lands. ROM earns a
          referral credit if you sign up.
        </div>
      </div>
      <button className="btn primary" onClick={() => void open()}>
        Open Kalshi sign-up ↗
      </button>
    </div>
  );
}

/**
 * The OpenRouter key form, shared by every place that offers to set one.
 *
 * One form rather than two: the Connection page is where keys belong and the
 * Backtest panel is where the need becomes obvious, and a copy in each would
 * drift the moment either changed.
 */
function AiKeySetup({ status, onChange }: { status: AiStatus; onChange: (s: AiStatus) => void }) {
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState(status.model);
  const [models, setModels] = useState<{ id: string; label: string }[]>([]);
  const toast = useToast();

  useEffect(() => {
    void window.rom.ai.models().then(setModels);
  }, []);

  const valid = /^sk-or-v1-[A-Za-z0-9._-]{16,}$/.test(draft.trim());

  async function save() {
    try {
      onChange(await window.rom.ai.save(draft.trim(), model));
      setDraft("");
      toast("ok", "Key saved and encrypted for this Windows account.");
    } catch (e) {
      toast("bad", (e as Error).message);
    }
  }

  if (status.configured) {
    return (
      <div className="row-actions">
        <span className="hint mono">key {status.keyHint}</span>
        <select
          value={status.model}
          onChange={(e) => {
            // Changing the model re-saves; the vault is the only copy of the key,
            // so the main process reuses what it already holds.
            void window.rom.ai.status().then(() => setModel(e.target.value));
          }}
          disabled
          title="Remove and re-add the key to change model"
        >
          <option>{models.find((m) => m.id === status.model)?.label ?? status.model}</option>
        </select>
        <button className="btn danger quiet" onClick={() => void window.rom.ai.clear().then(onChange)}>
          Remove key
        </button>
      </div>
    );
  }

  return (
    <>
      {!status.encryptionAvailable && (
        <div className="notice bad">
          Windows did not offer a credential store, so no key can be saved here.
        </div>
      )}
      <div className="row-actions">
        <input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="sk-or-v1-…"
          spellCheck={false}
          autoComplete="off"
        />
        <select value={model} onChange={(e) => setModel(e.target.value)}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button className="btn primary" disabled={!valid || !status.encryptionAvailable} onClick={() => void save()}>
          Save
        </button>
      </div>
      {draft !== "" && !valid && (
        <div className="hint warn">
          OpenRouter keys start with <span className="mono">sk-or-v1-</span> — check for surrounding
          quotes or a truncated paste.
        </div>
      )}
    </>
  );
}

/**
 * Key management on its own, for the Connection page.
 *
 * Separate from Narrate because a key is a setting and belongs with the other
 * one, not buried behind a result that only appears after a backtest has run.
 */
export function AiKeyCard() {
  const [status, setStatus] = useState<AiStatus | null>(null);
  useEffect(() => {
    void window.rom.ai.status().then(setStatus);
  }, []);
  if (!status) return null;

  return (
    <div className="card">
      <div className="card-head">
        <div className="label">Plain-English summaries</div>
        <span className={`tag ${status.configured ? "live" : ""}`}>
          {status.configured ? "configured" : "not set"}
        </span>
      </div>
      <p className="hint">
        Optional and free. With an OpenRouter key, ROM Trader can rewrite backtest results as a
        paragraph. The key is encrypted with your Windows account, is sent only to openrouter.ai,
        and is never readable by this screen again. Every number the model writes is checked against
        the measured results first — invented figures are discarded and the measured summary stands.
        The app never asks a model what to trade.
      </p>
      <AiKeySetup status={status} onChange={setStatus} />
      <div className="hint">
        Get a key free at <span className="mono">openrouter.ai/keys</span> — the models offered here
        cost nothing to use.
      </div>
      {status.error && <div className="notice warn">{status.error}</div>}
    </div>
  );
}

/**
 * Optional plain-English phrasing of results the app already computed.
 *
 * Renders the deterministic summary always, and the reworded version above it
 * only when a model produced one that passed the checks. Never replaces the
 * summary, because the summary is what the rewording was made from and the
 * reader should be able to compare the two.
 *
 * The key lives in the main process vault. This component can ask for a
 * narration and can write or clear a key; there is no path by which it can
 * read one back.
 */
export function Narrate({
  subject,
  summary,
  evidence,
}: {
  subject: string;
  summary: string;
  evidence: { label: string; value: string }[];
}) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<NarrationResult | null>(null);
  const toast = useToast();

  useEffect(() => {
    void window.rom.ai.status().then(setStatus);
  }, []);

  async function run() {
    setBusy(true);
    setResult(null);
    try {
      setResult(await window.rom.ai.narrate({ subject, summary, evidence }));
    } catch (e) {
      toast("bad", (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!status) return null;

  return (
    <div className="narrate">
      <div className="narrate-head">
        <span className="label">In plain English</span>
        {status.configured ? (
          <button className="btn quiet tiny" onClick={() => void run()} disabled={busy}>
            {busy ? "Writing…" : result ? "Rewrite" : "Explain these results"}
          </button>
        ) : (
          <button className="btn quiet tiny" onClick={() => setOpen((v) => !v)}>
            {open ? "Cancel" : "Set up"}
          </button>
        )}
      </div>

      {result?.ok && (
        <>
          <p className="narrate-text">{result.text}</p>
          <div className="hint">
            Reworded by {result.model}. Every figure in it was checked against the table above.
          </div>
        </>
      )}
      {result && !result.ok && (
        <div className="hint">Not reworded — {result.reason}. The measured summary stands.</div>
      )}

      {!status.configured && open && (
        <div className="narrate-setup">
          <p className="hint">
            Optional and free. An OpenRouter key lets a model rewrite these results as a paragraph —
            it rewords the measured numbers and is never asked what to trade. You can also set this
            on the Connection page.
          </p>
          <AiKeySetup status={status} onChange={setStatus} />
          <div className="hint">
            Get a key free at <span className="mono">openrouter.ai/keys</span>.
          </div>
        </div>
      )}
      {status.error && <div className="notice warn">{status.error}</div>}
    </div>
  );
}

export function Field({
  label,
  help,
  suffix,
  children,
}: {
  label: string;
  help?: string;
  suffix?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="field-input">
        {children}
        {suffix && <span className="field-suffix">{suffix}</span>}
      </span>
      {help && <span className="field-help">{help}</span>}
    </label>
  );
}

export function NumberField({
  label,
  help,
  suffix,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  help?: string;
  suffix?: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (n: number) => void;
}) {
  return (
    <Field label={label} help={help} suffix={suffix}>
      <input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
      />
    </Field>
  );
}

export function Toggle({
  label,
  help,
  checked,
  onChange,
  danger,
  disabled,
}: {
  label: string;
  help?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className={`toggle ${danger && checked ? "hot" : ""} ${disabled ? "locked" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-knob" />
      </span>
      <span className="toggle-text">
        <span className="toggle-label">{label}</span>
        {help && <span className="field-help">{help}</span>}
      </span>
    </label>
  );
}

/* ---------------- stat card ---------------- */

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: string;
}) {
  return (
    <div className="card stat">
      <div className="label">{label}</div>
      <div className={`value ${tone ?? ""}`}>{value}</div>
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

/* ---------------- equity chart ---------------- */

export function EquityChart({ points }: { points: EquityPoint[] }) {
  const W = 900;
  const H = 190;
  const PAD = 6;

  const path = useMemo(() => {
    if (points.length < 2) return null;
    const xs = points.map((p) => p.ts);
    const ys = points.map((p) => p.equityUsd);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    // A perfectly flat series would divide by zero; give it a nominal band.
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || Math.max(1, Math.abs(maxY) * 0.02);

    const px = (t: number) => PAD + ((t - minX) / spanX) * (W - PAD * 2);
    const py = (v: number) => H - PAD - ((v - minY) / spanY) * (H - PAD * 2);
    // One line per stretch the engine was actually running. Joining across a
    // pause draws equity through time nobody observed — see series.ts, which
    // holds the rule and the reasoning and is shared with the replay engine.
    const segments = splitAtGaps(points).map((run) => {
      const d = run
        .map((p, i) => `${i === 0 ? "M" : "L"}${px(p.ts).toFixed(1)},${py(p.equityUsd).toFixed(1)}`)
        .join(" ");
      // A lone point has no line; give it a hairline so the stretch is visible
      // rather than silently dropped.
      const line =
        run.length === 1
          ? `${d} L${(px(run[0].ts) + 0.6).toFixed(1)},${py(run[0].equityUsd).toFixed(1)}`
          : d;
      return {
        line,
        area: `${line} L${px(run[run.length - 1].ts).toFixed(1)},${H - PAD} L${px(run[0].ts).toFixed(1)},${H - PAD} Z`,
      };
    });

    return {
      segments,
      gaps: segments.length - 1,
      sampledMs: sampledMs(points),
      minY,
      maxY,
      first: ys[0],
      last: ys[ys.length - 1],
      spanMs: maxX - minX,
    };
  }, [points]);

  if (!path) {
    return (
      <div className="empty small">
        The equity curve appears once the engine has run a few scans.
      </div>
    );
  }

  const up = path.last >= path.first;
  const change = path.last - path.first;

  return (
    <div className="chart">
      {/* preserveAspectRatio was "none", which stretched the 900x190 viewBox to
          whatever width the card happened to be — so the same drawdown looked
          twice as steep on a narrow window. A slope that changes with the
          window is not reporting anything. */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Equity over time: ${money(path.first)} to ${money(path.last)}, ${signedMoney(change)}`}
      >
        <defs>
          <linearGradient id="eqFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={up ? "#22c55e" : "#ff4d6d"} stopOpacity="0.28" />
            <stop offset="100%" stopColor={up ? "#22c55e" : "#ff4d6d"} stopOpacity="0" />
          </linearGradient>
        </defs>
        {path.segments.map((seg, i) => (
          <Fragment key={i}>
            <path d={seg.area} fill="url(#eqFill)" />
            <path
              d={seg.line}
              fill="none"
              stroke={up ? "#22c55e" : "#ff4d6d"}
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          </Fragment>
        ))}
      </svg>
      {/* These two slots used to hold the minimum and the maximum. Position
          under a chart implies time, so "$91.31 … $99.67" read as a start and
          an end — i.e. up $8 — under a curve that was falling. The chart and
          its own caption told opposite stories. They are the actual endpoints
          now, with the change stated rather than left to be inferred. */}
      <div className="chart-axis">
        <span>
          {money(path.first)} <small>start</small>
        </span>
        <span className="chart-axis-end">
          <b className={pnlClass(change)}>{signedMoney(change)}</b>
          <small>
            {money(path.last)} now · low {money(path.minY)} · high {money(path.maxY)}
            {/* Time the engine was actually running, not the width of the
                chart. Those differed by a factor of thirteen on the file that
                prompted the gap fix, and only one of them is a fact about
                trading. */}
            {path.sampledMs > 0 ? ` · ${duration(path.sampledMs)} running` : ""}
            {path.gaps > 0
              ? ` · ${path.gaps} break${path.gaps === 1 ? "" : "s"} over ${duration(path.spanMs)}`
              : ""}
          </small>
        </span>
      </div>
    </div>
  );
}
