/**
 * Strategy research against synthetic markets with known properties.
 *
 * Replaying one real recording tells you what happened once. It cannot tell
 * you whether a setting won because the rule works or because that stretch of
 * market happened to suit it. Generating markets whose behaviour is known lets
 * both questions be answered separately:
 *
 *   random   - a pure random walk. There is no edge to find, so any positive
 *              result is the search fooling itself, and the expected loss is
 *              exactly the trading cost.
 *   momentum - price changes are positively autocorrelated. A momentum rule
 *              should make money here if it works at all.
 *   revert   - price changes are negatively autocorrelated, which is what
 *              short-horizon prediction markets often look like.
 *
 * Each regime is run over many independent seeds so a result is an average
 * rather than one lucky path.
 *
 *   npx esbuild scripts/simulate.ts --bundle --platform=node \
 *     --alias:electron=./test/electron-stub.js --outfile=scripts/simulate.js
 *   node scripts/simulate.js
 */
import { runBacktest } from "../electron/engine/backtest";
import { roundTripFeeCentsPerContract } from "../electron/engine/fees";
import type { RecordedScan } from "../electron/engine/recorder";
import { DEFAULT_SETTINGS, type Settings } from "../electron/engine/store";

type Regime = "random" | "momentum" | "revert";

/** Deterministic PRNG so every run of this script is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

/** Box-Muller, for price steps that are normal rather than uniform. */
function normal(rand: () => number): number {
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

interface MarketSpec {
  regime: Regime;
  scans: number;
  markets: number;
  /** Standard deviation of one price step, in cents. */
  volatilityCents: number;
  /** How strongly the last step predicts the next. */
  autocorrelation: number;
  /** Half the bid/ask gap, in cents. */
  spreadCents: number;
  startCents: number;
  seed: number;
}

function generate(spec: MarketSpec): RecordedScan[] {
  const rand = rng(spec.seed);
  const price: number[] = [];
  const lastStep: number[] = [];
  for (let i = 0; i < spec.markets; i++) {
    price.push(spec.startCents);
    lastStep.push(0);
  }

  const out: RecordedScan[] = [];
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);

  for (let s = 0; s < spec.scans; s++) {
    const markets = [];
    for (let i = 0; i < spec.markets; i++) {
      const shock = normal(rand) * spec.volatilityCents;
      const step = spec.autocorrelation * lastStep[i] + shock;
      lastStep[i] = step;
      // Prediction markets are bounded; reflect rather than clamp so prices do
      // not pile up against the wall and go artificially quiet.
      let next = price[i] + step;
      if (next < 5) next = 10 - next;
      if (next > 95) next = 190 - next;
      price[i] = Math.min(95, Math.max(5, next));

      const mid = Math.round(price[i]);
      markets.push({
        ticker: `SIM-${i}`,
        title: `Simulated market ${i}`,
        yes_bid: Math.max(1, mid - spec.spreadCents),
        yes_ask: Math.min(99, mid + spec.spreadCents),
        volume: 5000,
        status: "active",
      });
    }
    out.push({ ts: t0 + s * 15000, markets: markets as never });
  }
  return out;
}

interface Score {
  label: string;
  pnl: number;
  trades: number;
  winRate: number | null;
  /** Gross winnings over gross losses, pooled across all seeds. */
  profitFactor: number | null;
}

/** Averages a configuration over many independent worlds. */
function evaluate(
  label: string,
  settings: Settings,
  spec: Omit<MarketSpec, "seed">,
  seeds: number[],
): Score {
  let pnl = 0;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;
  for (const seed of seeds) {
    const r = runBacktest(generate({ ...spec, seed }), settings, label);
    pnl += r.pnlUsd;
    trades += r.trades;
    wins += r.wins;
    losses += r.losses;
    grossWin += r.metrics.grossWinUsd;
    grossLoss += r.metrics.grossLossUsd;
  }
  return {
    label,
    pnl: round2(pnl / seeds.length),
    trades: Math.round(trades / seeds.length),
    winRate: wins + losses > 0 ? wins / (wins + losses) : null,
    profitFactor: grossWin > 0 && grossLoss > 0 ? round2(grossWin / grossLoss) : null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function table(rows: Score[], title: string): void {
  console.log(`\n  ${title}`);
  console.log(`  ${"config".padEnd(34)} ${"trades".padStart(7)} ${"win".padStart(6)} ${"PF".padStart(6)} ${"avg P&L".padStart(10)}`);
  console.log(`  ${"-".repeat(34)} ${"-".repeat(7)} ${"-".repeat(6)} ${"-".repeat(6)} ${"-".repeat(10)}`);
  for (const r of rows) {
    const wr = r.winRate === null ? "—" : `${(r.winRate * 100).toFixed(0)}%`;
    const pf = r.profitFactor === null ? "—" : r.profitFactor.toFixed(2);
    const pnl = `${r.pnl >= 0 ? "+" : ""}$${r.pnl.toFixed(2)}`;
    console.log(`  ${r.label.padEnd(34)} ${String(r.trades).padStart(7)} ${wr.padStart(6)} ${pf.padStart(6)} ${pnl.padStart(10)}`);
  }
}

const SEEDS = [1, 7, 13, 29, 41, 53, 67, 79, 91, 103];
const BASE: Omit<MarketSpec, "seed" | "regime" | "autocorrelation"> = {
  scans: 600,
  markets: 12,
  volatilityCents: 1.2,
  spreadCents: 1,
  startCents: 50,
};

const REGIMES: Record<Regime, number> = {
  random: 0,
  momentum: 0.35,
  revert: -0.35,
};

function main(): void {
  console.log("\n=== ROM Trader strategy simulation ===");
  console.log(`  ${SEEDS.length} independent worlds per configuration, ${BASE.scans} scans each`);
  console.log(`  Round-trip taker fee: ${roundTripFeeCentsPerContract(50).toFixed(2)}c per contract at 50c,`);
  console.log(`  ${roundTripFeeCentsPerContract(20).toFixed(2)}c at 20c, ${roundTripFeeCentsPerContract(80).toFixed(2)}c at 80c.`);

  // Risk brakes are switched off for research. They are safety features, not
  // strategy: with a low win rate the losing-streak halt fires after four
  // trades and every configuration then scores "the engine stopped early"
  // rather than anything about the rule being tested. Leaving them on made
  // every row look identical, which is what gave the mistake away.
  //
  // The edge margin is also zeroed here so the historical tables stay
  // comparable across versions; it gets its own measurement below.
  const shipped: Settings = {
    ...DEFAULT_SETTINGS,
    liveMode: false,
    maxConsecutiveLosses: 0,
    dailyLossLimitUsd: 0,
    reentryCooldownSeconds: 0,
    maxDrawdownPct: 0,
    minNetEdgeCents: 0,
    dryRunCash: 10_000,
  };
  const perRegime: Score[] = [];
  for (const [regime, ac] of Object.entries(REGIMES)) {
    perRegime.push(
      evaluate(`shipped defaults · ${regime}`, shipped, { ...BASE, regime: regime as Regime, autocorrelation: ac }, SEEDS),
    );
  }
  table(
    perRegime,
    `1. Shipped defaults (tp${shipped.takeProfitCents} / sl${shipped.stopLossCents}) across market regimes`,
  );

  // --- 2. How much of that is fees?
  //  Compare the same rule against take-profits either side of the fee floor.
  const tpRows: Score[] = [];
  for (const tp of [4, 6, 8, 10, 12, 15, 20]) {
    tpRows.push(
      evaluate(
        `take-profit ${tp}c`,
        { ...shipped, takeProfitCents: tp, stopLossCents: 5 },
        { ...BASE, regime: "momentum", autocorrelation: REGIMES.momentum },
        SEEDS,
      ),
    );
  }
  table(tpRows, "2. Take-profit vs the fee floor (momentum market, stop 5c)");

  // --- 3. The fee curve is parabolic, so where you trade matters.
  const bandRows: Score[] = [];
  for (const [lo, hi, name] of [
    [5, 90, "5-90c (shipped)"],
    [40, 60, "40-60c (dearest fees)"],
    [5, 30, "5-30c (cheap side)"],
    [70, 95, "70-95c (cheap side)"],
  ] as [number, number, string][]) {
    const start = Math.round((lo + hi) / 2);
    bandRows.push(
      evaluate(
        name,
        { ...shipped, minPriceCents: lo, maxPriceCents: hi, takeProfitCents: 12, stopLossCents: 5 },
        { ...BASE, regime: "momentum", autocorrelation: REGIMES.momentum, startCents: start },
        SEEDS,
      ),
    );
  }
  table(bandRows, "3. Where in the price range it trades (tp12 / sl5, momentum)");

  // --- 4. The control that matters most: a market with no edge at all.
  const nullRows: Score[] = [];
  for (const tp of [6, 12, 20]) {
    nullRows.push(
      evaluate(
        `take-profit ${tp}c`,
        { ...shipped, takeProfitCents: tp, stopLossCents: 5 },
        { ...BASE, regime: "random", autocorrelation: 0 },
        SEEDS,
      ),
    );
  }
  table(nullRows, "4. Control: random walk, where no edge exists to find");

  // --- 5. Why are trades closing? A 5% win rate is not a fee problem.
  console.log("\n  5. Why trades close (momentum market, shipped defaults)");
  {
    const scans = generate({ ...BASE, regime: "momentum", autocorrelation: REGIMES.momentum, seed: 1 });
    const r = runBacktest(scans, shipped, "diagnostic");
    const total = Object.values(r.exitReasons).reduce((a, b) => a + b, 0) || 1;
    for (const [reason, n] of Object.entries(r.exitReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${reason.padEnd(34)} ${String(n).padStart(7)} ${((n / total) * 100).toFixed(0).padStart(5)}%`);
    }
  }

  // --- 6. The spread is charged twice, and the settings ignore it.
  //
  // Entry is at the ask, exit at the bid, so a position opens at -spread. The
  // take-profit is measured from there, meaning the price must move
  // (tp + spread) to win but only (sl - spread) to lose. With the shipped
  // tp6 / sl4 and a 2c spread that is +8c to win against -2c to lose: a 4:1
  // adverse ratio before a penny of fees.
  console.log("\n  6. Required move, given entry at ask and exit at bid");
  console.log(`  ${"tp / sl".padEnd(18)} ${"need up".padStart(9)} ${"need down".padStart(10)} ${"ratio".padStart(8)}`);
  console.log(`  ${"-".repeat(18)} ${"-".repeat(9)} ${"-".repeat(10)} ${"-".repeat(8)}`);
  const spread = 2;
  for (const [tp, sl] of [[6, 4], [6, 10], [10, 14], [12, 18], [8, 16]] as [number, number][]) {
    const up = tp + spread;
    const down = sl - spread;
    const ratio = down > 0 ? (up / down).toFixed(1) : "instant";
    console.log(`  ${`tp${tp} / sl${sl}`.padEnd(18)} ${`+${up}c`.padStart(9)} ${`-${down}c`.padStart(10)} ${`${ratio}:1`.padStart(8)}`);
  }

  const symRows: Score[] = [];
  for (const [tp, sl] of [[6, 4], [6, 10], [8, 14], [10, 16], [12, 20]] as [number, number][]) {
    symRows.push(
      evaluate(
        `tp${tp} / sl${sl}`,
        { ...shipped, takeProfitCents: tp, stopLossCents: sl },
        { ...BASE, regime: "momentum", autocorrelation: REGIMES.momentum },
        SEEDS,
      ),
    );
  }
  table(symRows, "7. Widening the stop so the trade is not lost on entry (momentum)");

  const symNull: Score[] = [];
  for (const [tp, sl] of [[6, 4], [10, 16]] as [number, number][]) {
    symNull.push(
      evaluate(
        `tp${tp} / sl${sl}`,
        { ...shipped, takeProfitCents: tp, stopLossCents: sl },
        { ...BASE, regime: "random", autocorrelation: 0 },
        SEEDS,
      ),
    );
  }
  table(symNull, "8. Same two, on a random walk (should both lose the fees)");

  // --- 9. The trailing exit, now that it has its own setting.
  //
  // Tables 2 and 7 returned identical numbers for different stop-losses, which
  // is what exposed the bug: the trailing exit reused the 3c entry trigger and
  // fired before any stop could. With it separated, both controls can be
  // measured for the first time.
  const trailRows: Score[] = [];
  for (const ts of [0, 3, 6, 10, 15]) {
    trailRows.push(
      evaluate(
        ts === 0 ? "trailing off" : `trailing ${ts}c`,
        { ...shipped, trailingStopCents: ts, takeProfitCents: 12, stopLossCents: 10 },
        { ...BASE, regime: "momentum", autocorrelation: REGIMES.momentum },
        SEEDS,
      ),
    );
  }
  table(trailRows, "9. Trailing exit width (momentum, tp12 / sl10)");

  // Now that the trailing exit is not swallowing everything, does the stop
  // actually do anything?
  const stopRows: Score[] = [];
  for (const sl of [4, 8, 12, 20]) {
    stopRows.push(
      evaluate(
        `stop ${sl}c`,
        { ...shipped, trailingStopCents: 0, takeProfitCents: 12, stopLossCents: sl },
        { ...BASE, regime: "momentum", autocorrelation: REGIMES.momentum },
        SEEDS,
      ),
    );
  }
  table(stopRows, "10. Stop-loss width with the trailing exit off (tp12)");

  // --- 11. The change 1.4.0 said would matter: stop being a taker.
  //
  // A maker rests at the bid: no entry fee, no spread paid on entry. The paper
  // fill model is conservative — the ask must trade down to the limit — so
  // these numbers carry the adverse selection honestly: the fills a maker
  // gets are the moments the market moved against the signal.
  const makerRows: Score[] = [];
  for (const [regime, ac] of Object.entries(REGIMES)) {
    const spec = { ...BASE, regime: regime as Regime, autocorrelation: ac };
    makerRows.push(
      evaluate(`taker · ${regime}`, { ...shipped }, spec, SEEDS),
      evaluate(`maker · ${regime}`, { ...shipped, makerEntries: true, makerTtlTicks: 4 }, spec, SEEDS),
    );
  }
  table(makerRows, "11. Taker vs maker entries (tp12 / sl12), across regimes");

  // --- 12. How long to let a resting order wait.
  //
  // Short and the order dies before anyone sells into it; long and the
  // momentum that justified it has gone stale by the time it fills.
  const ttlRows: Score[] = [];
  for (const ttl of [2, 4, 8, 16]) {
    ttlRows.push(
      evaluate(
        `maker, ttl ${ttl} scans`,
        { ...shipped, makerEntries: true, makerTtlTicks: ttl },
        { ...BASE, regime: "momentum", autocorrelation: REGIMES.momentum },
        SEEDS,
      ),
    );
  }
  table(ttlRows, "12. Resting-order lifetime (momentum market)");

  // --- 13. The regime filter, where it should help and where it must not.
  //
  // In the mean-reverting world it should refuse most entries; in the
  // momentum world it should stay out of the way. A filter that costs money
  // in the regime it was built for would be worse than none.
  const regimeRows: Score[] = [];
  for (const [regime, ac] of Object.entries(REGIMES)) {
    const spec = { ...BASE, regime: regime as Regime, autocorrelation: ac };
    regimeRows.push(
      evaluate(`filter off · ${regime}`, { ...shipped }, spec, SEEDS),
      evaluate(`filter on  · ${regime}`, { ...shipped, regimeFilterEnabled: true }, spec, SEEDS),
    );
  }
  table(regimeRows, "13. Regime filter (tp12 / sl12), across regimes");

  // --- 14. The edge margin: refusing thin trades.
  //
  // tp8 clears the ~3.5c fee by ~4.5c near 50c. Margins under that change
  // nothing — the demonstration that the filter only bites when it should.
  // A margin above it refuses every trade, and on a strategy with negative
  // expectancy, "refused everything" is the best row on the table.
  const edgeRows: Score[] = [];
  for (const edge of [0, 4, 6]) {
    edgeRows.push(
      evaluate(
        `min net edge ${edge}c`,
        { ...shipped, takeProfitCents: 8, minNetEdgeCents: edge },
        { ...BASE, regime: "momentum", autocorrelation: REGIMES.momentum },
        SEEDS,
      ),
    );
  }
  // A margin over the mid-price fee confines entries to the cheap ends of the
  // fee curve (under ~17c, over ~83c). If that row turns positive, this
  // control decides whether it found something or fooled itself: the same
  // configuration on a random walk, where there is nothing to find, and where
  // the synthetic price reflection at 5c and 95c could manufacture a bounce.
  edgeRows.push(
    evaluate(
      `min net edge 6c · random CONTROL`,
      { ...shipped, takeProfitCents: 8, minNetEdgeCents: 6 },
      { ...BASE, regime: "random", autocorrelation: 0 },
      SEEDS,
    ),
  );
  table(edgeRows, "14. Minimum net edge (tp8, momentum) — 8c clears the fee by ~4.5c");

  // --- 15. Everything the research points at, together, vs the shipped taker.
  //
  // The filter-off row is there for attribution: table 13 says the regime
  // filter contributes little on its own, so if "patient maker" wins, the
  // credit must be traceable to the parts that earned it.
  const patient = {
    ...shipped,
    makerEntries: true,
    makerTtlTicks: 6,
    momentumThresholdCents: 4,
    regimeFilterEnabled: true,
    minNetEdgeCents: 3,
  };
  const combined: Score[] = [];
  for (const [regime, ac] of Object.entries(REGIMES)) {
    const spec = { ...BASE, regime: regime as Regime, autocorrelation: ac };
    combined.push(
      evaluate(`shipped taker · ${regime}`, { ...shipped }, spec, SEEDS),
      evaluate(`patient maker · ${regime}`, patient, spec, SEEDS),
      evaluate(
        `patient, no filter · ${regime}`,
        { ...patient, regimeFilterEnabled: false },
        spec,
        SEEDS,
      ),
    );
  }
  table(combined, "15. The Patient preset's rules vs shipped defaults, across regimes");

  console.log("\n  Read 4 and 8 first. Anything that looks profitable there is noise,");
  console.log("  and tells you how much to discount the other tables.");
  console.log("  For 11 and 15, the random rows are again the control: a maker in a");
  console.log("  random walk should lose little (few fees) but also make nothing.\n");
}

main();
