// Headless engine smoke test: runs the real TradingEngine (dry-run) for ~35s
// against live Kalshi market data, printing state and logs, then exits.
import { TradingEngine } from "../electron/engine/engine";
import { DEFAULT_SETTINGS } from "../electron/engine/store";

const engine = new TradingEngine({ ...DEFAULT_SETTINGS, tickSeconds: 5 });
engine.subscribe({
  onState: (s) => {
    if (s.lastTickAt) {
      console.log(
        `[state] status=${s.status} equity=$${s.equityUsd} positions=${s.positions.length} lastError=${s.lastError ?? "none"}`,
      );
    }
  },
  onLog: (l) => console.log(`[${l.level}] ${l.msg}`),
});

engine.start();

setTimeout(() => {
  const s = engine.getState();
  console.log("--- FINAL ---");
  console.log(
    JSON.stringify(
      {
        status: s.status,
        ticked: s.lastTickAt !== null,
        lastError: s.lastError,
        equityUsd: s.equityUsd,
        positions: s.positions.map((p) => `${p.ticker} ${p.contracts}x @${p.entryCents}c`),
      },
      null,
      2,
    ),
  );
  engine.stop();
  process.exit(s.lastTickAt !== null && s.lastError === null ? 0 : 1);
}, 35000);
