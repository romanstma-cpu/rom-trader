import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { EquityPoint } from "./types";

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

    const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${px(p.ts).toFixed(1)},${py(p.equityUsd).toFixed(1)}`).join(" ");
    const area = `${line} L${px(maxX).toFixed(1)},${H - PAD} L${px(minX).toFixed(1)},${H - PAD} Z`;
    return {
      line,
      area,
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
        <path d={path.area} fill="url(#eqFill)" />
        <path
          d={path.line}
          fill="none"
          stroke={up ? "#22c55e" : "#ff4d6d"}
          strokeWidth="2"
          vectorEffect="non-scaling-stroke"
          strokeLinejoin="round"
        />
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
            {path.spanMs > 0 ? ` · ${duration(path.spanMs)}` : ""}
          </small>
        </span>
      </div>
    </div>
  );
}
