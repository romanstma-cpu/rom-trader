import { useEffect, useMemo, useRef, useState } from "react";
import type { LogLine } from "../types";

type Level = "all" | "trade" | "warn" | "error";

export default function Logs() {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [level, setLevel] = useState<Level>("all");
  const [follow, setFollow] = useState(true);
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void window.rom.engine.getLogs().then(setLines);
    return window.rom.engine.onLog((l) => setLines((xs) => [...xs.slice(-499), l]));
  }, []);

  const shown = useMemo(() => {
    if (level === "all") return lines;
    if (level === "warn") return lines.filter((l) => l.level === "warn" || l.level === "error");
    return lines.filter((l) => l.level === level);
  }, [lines, level]);

  useEffect(() => {
    if (follow) endRef.current?.scrollIntoView({ block: "end" });
  }, [shown, follow]);

  return (
    <>
      <div className="toolbar">
        <div className="segmented">
          {(["all", "trade", "warn", "error"] as Level[]).map((l) => (
            <button key={l} className={level === l ? "active" : ""} onClick={() => setLevel(l)}>
              {l === "all" ? "Everything" : l === "trade" ? "Trades" : l === "warn" ? "Warnings" : "Errors"}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Follow
        </label>
        <button className="btn quiet" onClick={() => void window.rom.app.openDataFolder()}>
          Open data folder
        </button>
      </div>

      <div className="card log-card">
        {shown.length === 0 ? (
          <div className="empty small">
            Nothing logged yet. Start the engine and its activity appears here in real time.
          </div>
        ) : (
          <div className="logs">
            {shown.map((l, i) => (
              <div key={`${l.ts}-${i}`} className={`log ${l.level}`}>
                <span className="log-ts">{new Date(l.ts).toLocaleTimeString()}</span>
                <span className={`log-lvl ${l.level}`}>{l.level}</span>
                <span className="log-msg">{l.msg}</span>
              </div>
            ))}
            <div ref={endRef} />
          </div>
        )}
      </div>
    </>
  );
}
