/**
 * Scores a handful of named configurations honestly, one contiguous segment at
 * a time.
 *
 * optimize.ts ranks a grid and reports marginals; this is what comes after a
 * marginal looks promising. A total across a whole recording hides everything:
 * one segment can carry a config that lost in the other eight. Nine separate
 * numbers cannot.
 *
 *   npx esbuild scripts/validate.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/validate.js
 *   node scripts/validate.js [--in <scans.jsonl>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { runBacktest } from "../electron/engine/backtest";
import { segmentScans, type RecordedScan } from "../electron/engine/recorder";
import { STRATEGIES } from "../electron/engine/strategies";
import { DEFAULT_SETTINGS, type Settings } from "../electron/engine/store";

function argStr(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= process.argv.length ? fallback : process.argv[i + 1];
}

function loadScans(file: string): RecordedScan[] {
  const out: RecordedScan[] = [];
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      const s = JSON.parse(line) as RecordedScan;
      if (Array.isArray(s.markets) && s.markets.length > 0) out.push(s);
    } catch {
      // half-written final line
    }
  }
  return out;
}

const BASE: Settings = {
  ...DEFAULT_SETTINGS,
  liveMode: false,
  dryRunCash: 10_000,
  maxConsecutiveLosses: 0,
  dailyLossLimitUsd: 0,
  maxDrawdownPct: 0,
  tradeSizeUsd: 10,
  maxPositions: 5,
  maxPositionsPerEvent: 1,
};

const patient = STRATEGIES.find((s) => s.id === "patient")!.params;

/**
 * The fee-band candidate.
 *
 * Not chosen by ranking a grid. Kalshi charges 0.07 x P x (1 - P) per contract
 * per side, so a trade at 67c pays 1.54c where a trade at 50c pays 1.75c and
 * one at 80c pays 1.12c. edge.ts then measured the signal separately inside
 * each band and found 60-75c is where the barrier race is won often enough to
 * cover what that band actually costs. The grid agreed afterwards, which is
 * the right order for those two things to happen in.
 */
const BAND: Settings = {
  ...BASE,
  minPriceCents: 60,
  maxPriceCents: 75,
  takeProfitCents: 30,
  stopLossCents: 20,
  momentumThresholdCents: 3,
  maxSpreadCents: 1,
  makerEntries: true,
  makerTtlTicks: 6,
  regimeFilterEnabled: true,
  minMinutesToClose: 30,
};

const CONFIGS: { label: string; settings: Settings }[] = [
  { label: "shipped defaults", settings: { ...BASE } },
  { label: "Patient preset", settings: { ...BASE, ...patient, dailyLossLimitUsd: 0, maxConsecutiveLosses: 0, maxDrawdownPct: 0 } },
  { label: "fee band 60-75c", settings: BAND },
  { label: "  same, taker entry", settings: { ...BAND, makerEntries: false } },
  { label: "  same, band 10-85c", settings: { ...BAND, minPriceCents: 10, maxPriceCents: 85 } },
  { label: "  same, band 75-90c", settings: { ...BAND, minPriceCents: 75, maxPriceCents: 90 } },
  { label: "  same, band 10-40c", settings: { ...BAND, minPriceCents: 10, maxPriceCents: 40 } },
];

function money(n: number): string {
  return `${n >= 0 ? "+" : ""}$${n.toFixed(2)}`;
}

function main(): void {
  const file = argStr("in", path.join(process.env.APPDATA ?? ".", "ROM Trader", "scans.jsonl"));
  const scans = loadScans(file);
  const segs = segmentScans(scans, 180_000, 30);

  console.log(`\n=== Per-segment validation: ${path.basename(file)} ===`);
  console.log(`  ${scans.length} scans in ${segs.length} contiguous segments\n`);
  console.log(
    `  ${"segment".padEnd(9)} ${"scans".padStart(6)} ${"hours".padStart(6)}  ` +
      `${new Date(segs[0][0].ts).toISOString().slice(0, 16).replace("T", " ")} onwards`,
  );
  segs.forEach((s, i) => {
    const hrs = (s[s.length - 1].ts - s[0].ts) / 3_600_000;
    console.log(
      `  ${`#${i + 1}`.padEnd(9)} ${String(s.length).padStart(6)} ${hrs.toFixed(1).padStart(6)}  ` +
        `${new Date(s[0].ts).toISOString().slice(0, 16).replace("T", " ")}`,
    );
  });

  console.log(`\n  Result per segment (P&L, and trades in brackets):\n`);
  const head = `  ${"config".padEnd(22)} ${"total".padStart(9)} ${"trades".padStart(7)} ${"win".padStart(5)} ${"segs+".padStart(6)}  ` +
    segs.map((_, i) => `#${i + 1}`.padStart(9)).join(" ");
  console.log(head);
  console.log(`  ${"-".repeat(22)} ${"-".repeat(9)} ${"-".repeat(7)} ${"-".repeat(5)} ${"-".repeat(6)}  ${segs.map(() => "-".repeat(9)).join(" ")}`);

  for (const c of CONFIGS) {
    const per = segs.map((seg) => runBacktest(seg, c.settings, c.label));
    const total = per.reduce((a, r) => a + r.pnlUsd, 0);
    const trades = per.reduce((a, r) => a + r.trades, 0);
    const wins = per.reduce((a, r) => a + r.wins, 0);
    const losses = per.reduce((a, r) => a + r.losses, 0);
    // Segments with no trade are neither a win nor a loss for the config and
    // are not counted as either.
    const traded = per.filter((r) => r.trades > 0);
    const positive = traded.filter((r) => r.pnlUsd > 0).length;
    const wr = wins + losses > 0 ? `${Math.round((wins / (wins + losses)) * 100)}%` : "—";
    console.log(
      `  ${c.label.padEnd(22)} ${money(total).padStart(9)} ${String(trades).padStart(7)} ${wr.padStart(5)} ` +
        `${`${positive}/${traded.length}`.padStart(6)}  ` +
        per.map((r) => (r.trades === 0 ? "—".padStart(9) : money(r.pnlUsd).padStart(9))).join(" "),
    );
  }

  console.log(`\n  Worst single trade and how the trades ended:\n`);
  for (const c of CONFIGS) {
    const per = segs.map((seg) => runBacktest(seg, c.settings, c.label));
    const trades = per.reduce((a, r) => a + r.trades, 0);
    if (trades === 0) {
      console.log(`  ${c.label.padEnd(22)} no trades`);
      continue;
    }
    const worst = Math.min(...per.map((r) => r.worstUsd));
    const best = Math.max(...per.map((r) => r.bestUsd));
    const reasons: Record<string, number> = {};
    for (const r of per) {
      for (const [k, n] of Object.entries(r.exitReasons)) reasons[k] = (reasons[k] ?? 0) + n;
    }
    const tail = Object.entries(reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n} ${k}`)
      .join(" · ");
    console.log(
      `  ${c.label.padEnd(22)} best ${money(best).padStart(8)}  worst ${money(worst).padStart(8)}   ${tail}`,
    );
  }

  console.log(
    `\n  A stop is a price, not a guarantee: the worst trade is what the market\n` +
      `  actually paid when the sell went in, which is how a gap gets counted.\n`,
  );
}

main();
