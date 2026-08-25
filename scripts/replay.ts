/**
 * Replays a recorded scans.jsonl through the real engine, comparing taker and
 * maker entries on the same real market data.
 *
 * This is the experiment the synthetic worlds cannot run: docs/
 * STRATEGY-FINDINGS.md shows the maker's fee savings being eaten by adverse
 * selection under a conservative fill model, but only real order books can
 * say how often a resting bid actually gets filled on Kalshi. The engine is
 * driven directly rather than through runBacktest so its log can be read —
 * placed/filled/expired counts are the numbers maker mode lives or dies by.
 *
 *   npx esbuild scripts/replay.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/replay.js
 *   node scripts/replay.js [--in <path to scans.jsonl>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { TradingEngine, memoryStore } from "../electron/engine/engine";
import type { KalshiMarket } from "../electron/engine/kalshi";
import { computeMetrics, type PerformanceMetrics } from "../electron/engine/metrics";
import { segmentScans } from "../electron/engine/recorder";
import { STRATEGIES } from "../electron/engine/strategies";
import { DEFAULT_SETTINGS, type Settings, type TradeRecord } from "../electron/engine/store";
import { runSweep } from "../electron/engine/sweep";

interface Scan {
  ts: number;
  markets: KalshiMarket[];
}

function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}

/** Same tolerance as the app's loader: a torn line is skipped, not fatal. */
function loadScans(file: string): Scan[] {
  const out: Scan[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const s = JSON.parse(line) as Scan;
      if (Array.isArray(s.markets) && s.markets.length > 0) out.push(s);
    } catch {
      // half-written final line from a killed recorder
    }
  }
  return out;
}

interface SegmentResult {
  history: TradeRecord[];
  equity: { ts: number; equityUsd: number }[];
  ordersPlaced: number;
  ordersFilled: number;
  ordersExpired: number;
  halted: string | null;
}

interface ReplayResult {
  label: string;
  maker: boolean;
  metrics: PerformanceMetrics;
  pnlUsd: number;
  ordersPlaced: number;
  ordersFilled: number;
  ordersExpired: number;
  exitReasons: Record<string, number>;
  halted: string | null;
}

function replaySegment(scans: Scan[], settings: Settings): SegmentResult {
  const store = memoryStore();
  const engine = new TradingEngine(
    { ...settings, liveMode: false },
    { apiKeyId: "", apiPrivateKeyPem: "" },
    store,
  );
  const d = engine as unknown as {
    status: string;
    setClock: (t: number) => void;
    processPendingOrders: (m: KalshiMarket[]) => void;
    updatePositions: (m: KalshiMarket[]) => void;
    scanForEntries: (m: KalshiMarket[], t: number) => void;
    enforceDailyLossLimit: () => void;
    enforceLosingStreak: () => void;
    enforceMaxDrawdown: () => void;
    equity: () => number;
  };
  d.status = "running";

  const equity: { ts: number; equityUsd: number }[] = [];
  for (const scan of scans) {
    if (d.status !== "running") break;
    // Mirrors tick(), same as backtest.ts — and must stay mirrored. The
    // clock first: cooldowns and lockouts expire on recorded time here.
    d.setClock(scan.ts);
    d.processPendingOrders(scan.markets);
    d.updatePositions(scan.markets);
    d.scanForEntries(scan.markets, scan.ts);
    d.enforceDailyLossLimit();
    d.enforceLosingStreak();
    d.enforceMaxDrawdown();
    equity.push({ ts: scan.ts, equityUsd: d.equity() });
  }
  engine.flatten("open at segment end");

  const logs = engine.getLogs();
  return {
    history: store.loadHistory(),
    equity,
    ordersPlaced: logs.filter((l) => l.msg.startsWith("REST ")).length,
    ordersFilled: logs.filter((l) => l.msg.startsWith("FILL ")).length,
    ordersExpired: logs.filter((l) => l.msg.startsWith("EXPIRE ")).length,
    halted: engine.getState().haltedReason,
  };
}

/** Replays every contiguous segment through a fresh engine and pools the results. */
function replay(segs: Scan[][], settings: Settings, label: string): ReplayResult {
  const parts = segs.map((seg) => replaySegment(seg, settings));
  const history = parts.flatMap((p) => p.history);
  const exitReasons: Record<string, number> = {};
  for (const t of history) exitReasons[t.reason] = (exitReasons[t.reason] ?? 0) + 1;

  // Metrics pool over the concatenated trades. Equity curves cannot be
  // stitched across segments (each restarts at fresh cash), so drawdown is
  // the worst any single segment reached.
  const metrics = computeMetrics(history, []);
  let worstDd = 0;
  let worstDdPct: number | null = null;
  for (const p of parts) {
    const m = computeMetrics(p.history, p.equity);
    if (m.maxDrawdownUsd > worstDd) {
      worstDd = m.maxDrawdownUsd;
      worstDdPct = m.maxDrawdownPct;
    }
  }
  metrics.maxDrawdownUsd = worstDd;
  metrics.maxDrawdownPct = worstDdPct;

  return {
    label,
    maker: settings.makerEntries,
    metrics,
    pnlUsd: Math.round(history.reduce((s, t) => s + t.pnlUsd, 0) * 100) / 100,
    ordersPlaced: parts.reduce((s, p) => s + p.ordersPlaced, 0),
    ordersFilled: parts.reduce((s, p) => s + p.ordersFilled, 0),
    ordersExpired: parts.reduce((s, p) => s + p.ordersExpired, 0),
    exitReasons,
    halted: parts.map((p) => p.halted).find((h) => h !== null) ?? null,
  };
}

function table(rows: ReplayResult[]): void {
  const head = `  ${"config".padEnd(26)} ${"trades".padStart(6)} ${"win".padStart(5)} ${"PF".padStart(6)} ${"per trade".padStart(10)} ${"P&L".padStart(9)} ${"orders".padStart(16)}`;
  console.log(head);
  console.log(`  ${"-".repeat(26)} ${"-".repeat(6)} ${"-".repeat(5)} ${"-".repeat(6)} ${"-".repeat(10)} ${"-".repeat(9)} ${"-".repeat(16)}`);
  for (const r of rows) {
    const m = r.metrics;
    const wr = m.winRate === null ? "—" : `${(m.winRate * 100).toFixed(0)}%`;
    const pf = m.profitFactor === null ? "—" : m.profitFactor.toFixed(2);
    const exp = m.expectancyUsd === null ? "—" : `${m.expectancyUsd >= 0 ? "+" : ""}$${m.expectancyUsd.toFixed(2)}`;
    const pnl = `${r.pnlUsd >= 0 ? "+" : ""}$${r.pnlUsd.toFixed(2)}`;
    const orders = r.maker ? `${r.ordersFilled}/${r.ordersPlaced} filled` : "taker";
    console.log(
      `  ${r.label.padEnd(26)} ${String(m.trades).padStart(6)} ${wr.padStart(5)} ${pf.padStart(6)} ${exp.padStart(10)} ${pnl.padStart(9)} ${orders.padStart(16)}`,
    );
  }
}

function main(): void {
  const file = argStr(
    "in",
    path.join(process.env.APPDATA ?? ".", "ROM Trader", "scans.jsonl"),
  );
  const scans = loadScans(file);
  if (scans.length < 10) {
    console.log(`Only ${scans.length} scans in ${file} — nothing meaningful to replay.`);
    process.exit(1);
  }

  // A ten-scan minimum here rather than the app's five: this script prints
  // research tables, and a stub segment adds noise faster than information.
  const segs = segmentScans(scans, 180_000, 10);
  if (segs.length === 0) {
    console.log("No contiguous segment is long enough to replay.");
    process.exit(1);
  }

  // Context the tables need: what the recorded market actually looked like.
  const spanMin = segs.reduce((s, seg) => s + (seg[seg.length - 1].ts - seg[0].ts), 0) / 60_000;
  const tickers = new Set<string>();
  let tightBooks = 0;
  let books = 0;
  const spreads: number[] = [];
  for (const s of scans) {
    for (const m of s.markets) {
      tickers.add(m.ticker);
      books += 1;
      const spread = m.yes_ask - m.yes_bid;
      spreads.push(spread);
      if (spread <= DEFAULT_SETTINGS.maxSpreadCents) tightBooks += 1;
    }
  }
  spreads.sort((a, b) => a - b);
  console.log(`\n=== Real-data replay: ${path.basename(file)} ===`);
  console.log(
    `  ${scans.length} scans over ${spanMin.toFixed(0)} minutes of market time, ` +
      `${segs.length} contiguous segment${segs.length === 1 ? "" : "s"}, ${tickers.size} distinct markets`,
  );
  console.log(
    `  median spread ${spreads[Math.floor(spreads.length / 2)]}c; ` +
      `${((tightBooks / books) * 100).toFixed(0)}% of books inside the default ${DEFAULT_SETTINGS.maxSpreadCents}c limit`,
  );

  // Brakes off for research, as in simulate.ts: they are safety features, and
  // a halt would score "stopped early" rather than the rule being measured.
  const base: Settings = {
    ...DEFAULT_SETTINGS,
    liveMode: false,
    maxConsecutiveLosses: 0,
    dailyLossLimitUsd: 0,
    maxDrawdownPct: 0,
    dryRunCash: 10_000,
  };

  const patientPreset = STRATEGIES.find((s) => s.id === "patient");
  const patient: Settings = { ...base, ...(patientPreset?.params ?? {}), maxConsecutiveLosses: 0, dailyLossLimitUsd: 0, maxDrawdownPct: 0 };

  const rows: ReplayResult[] = [
    replay(segs, base, "defaults (taker)"),
    // The 1.10.0 ladder cap, isolated: identical rules with stacking allowed
    // again. Half of the soak's entries stacked an already-held ladder, and
    // 18 of its 34 stop-losses came in same-ladder cascades.
    replay(segs, { ...base, maxPositionsPerEvent: 99 }, "defaults, ladder cap off"),
    // The climb gate: more than half the window's steps must rise, so a
    // single gapped tick cannot trigger an entry on its own. Measured here
    // before any default changes.
    replay(segs, { ...base, requireConsistentMove: true }, "defaults + climb gate"),
    // The clean A/B: identical rules, only the entry mechanics differ.
    replay(segs, { ...base, makerEntries: true, makerTtlTicks: 4 }, "defaults + maker ttl4"),
    replay(segs, { ...base, makerEntries: true, makerTtlTicks: 8 }, "defaults + maker ttl8"),
    replay(segs, patient, "Patient preset"),
    replay(segs, { ...patient, regimeFilterEnabled: false }, "Patient, no filter"),
    // The books are wide at night; a looser spread limit shows what the
    // filter is protecting against — and what a maker, who does not pay the
    // spread on entry, might tolerably relax.
    replay(segs, { ...base, maxSpreadCents: 5 }, "taker, spread limit 5c"),
    replay(segs, { ...base, makerEntries: true, makerTtlTicks: 8, maxSpreadCents: 5 }, "maker ttl8, spread 5c"),
    // Entry-quality attribution. The gates ship on since 1.6.0, so the
    // variants here remove them: what the old ungated defaults would have
    // done, and what each gate contributes on its own.
    replay(
      segs,
      { ...base, momentumOnBid: false, requireTradeActivity: false },
      "taker, gates off (pre-1.6)",
    ),
    replay(segs, { ...base, requireTradeActivity: false }, "taker, bid gate only"),
    replay(segs, { ...base, momentumOnBid: false }, "taker, volume gate only"),
    // The maker exit: winners fill at the target fee-free instead of selling
    // at the bid and paying the taker fee. Measured before it defaults.
    replay(segs, { ...base, makerExits: true }, "defaults + maker TP"),
    replay(segs, { ...patient, makerExits: true }, "Patient + maker TP"),
  ];

  console.log("");
  table(rows);

  console.log("\n  Why trades closed:");
  for (const r of rows) {
    if (r.metrics.trades === 0) continue;
    const parts = Object.entries(r.exitReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${k}`)
      .join(" · ");
    console.log(`  ${r.label.padEnd(26)} ${parts}`);
  }

  const anyHalted = rows.filter((r) => r.halted !== null);
  for (const r of anyHalted) console.log(`\n  NOTE ${r.label} halted: ${r.halted}`);

  // The disciplined verdict: the full grid, fitted on the first 60% of the
  // recording and scored on the 40% it never saw. The hand-picked rows above
  // answer specific questions; this answers "is there anything here at all".
  const sweep = runSweep(scans, base);
  console.log(
    `\n  Train/test sweep — fitted on ${sweep.scansTrain} scans, scored on ${sweep.scansTest} unseen:`,
  );
  console.log(
    `  ${"candidate".padEnd(34)} ${"fitted".padStart(9)} ${"unseen".padStart(9)} ${"trades".padStart(7)}`,
  );
  console.log(`  ${"-".repeat(34)} ${"-".repeat(9)} ${"-".repeat(9)} ${"-".repeat(7)}`);
  const sweepRows = [
    ...(sweep.baseline ? [sweep.baseline] : []),
    ...sweep.candidates.slice(0, 5),
  ];
  for (const c of sweepRows) {
    const f = `${c.trainPnlUsd >= 0 ? "+" : ""}$${c.trainPnlUsd.toFixed(2)}`;
    const u = `${c.testPnlUsd >= 0 ? "+" : ""}$${c.testPnlUsd.toFixed(2)}`;
    const name = c === sweep.baseline ? `${c.label} (yours)` : c.label;
    console.log(`  ${name.padEnd(34)} ${f.padStart(9)} ${u.padStart(9)} ${String(c.testTrades).padStart(7)}`);
  }
  for (const n of sweep.notes) console.log(`  · ${n}`);

  console.log(
    "\n  One recording is one stretch of one night. It says how these settings" +
      "\n  would have behaved here — not what they will do next.\n",
  );
}

main();
