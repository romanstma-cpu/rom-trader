/**
 * Whether a model actually knows anything, as distinct from whether it won.
 *
 * Every measurement this app has produced so far reported a win rate and a
 * Wilson bound. Both are wrong for this venue, in two separate ways, and the
 * fair-value study tripped over both at once — it reported twenty-one wins out
 * of twenty-one and a Wilson lower bound of 88.6%, which is a number with no
 * defensible meaning.
 *
 * THE FIRST ERROR: N IS NOT THE NUMBER OF CONTRACTS
 *
 * Wilson assumes independent trials. A Kalshi crypto event carries a ladder of
 * strikes over ONE underlying path. Buy "above 78,000", "above 78,500" and
 * "above 79,000" in the same hourly event and BTC decides all three at once —
 * they win together or they lose together. Three rows, one outcome. Counting
 * them as three independent successes shrinks the interval by sqrt(3) that was
 * never earned, and stacked over a ladder of a dozen strikes the overstatement
 * is severe.
 *
 * The fix is the cluster bootstrap: resample EVENTS with replacement rather
 * than rows. If the honest sample is four BTC hours, the interval widens until
 * it says so.
 *
 * THE SECOND ERROR: 61% OF THESE MARKETS SETTLE NO
 *
 * Measured over this app's own settlement record: 414 NO against 263 YES. An
 * event has one true outcome and many strikes that miss it, so the universe is
 * structurally tilted. A strategy that leans NO harvests that tilt and looks
 * like a forecaster. A win rate compared against 50% is therefore comparing
 * against a baseline no one is offering.
 *
 * The fix is to run the same arithmetic over the same rows with the model
 * switched off — always-YES and always-NO — and report the DIFFERENCE. When the
 * model and the dumb baseline score alike, the model contributed nothing, and
 * that is true no matter how flattering the raw rate looks.
 *
 * Within-band skill goes one step further and compares inside entry-price
 * buckets, because a model that only ever buys 90c favourites will beat a
 * baseline computed over the whole book on price alone.
 *
 * Adapted from the backtest metrics in OctagonAI/kalshi-trading-bot-cli (MIT),
 * whose own comment names the trap exactly: the row bootstrap thinks N is a
 * hundred when the honest N is twenty. The seeded generator below is this
 * app's own addition — an interval that moves every time it is computed cannot
 * answer whether a change to the model helped.
 */

// ------------------------------------------------------------------ scoring

/**
 * Brier score for one forecast: the squared error of a probability.
 *
 * Both arguments are on 0..1. Lower is better; 0.25 is what you score by
 * answering "fifty-fifty" to everything, which makes it the number a model has
 * to beat before it has said anything at all.
 */
export function brier(forecast: number, outcome: 0 | 1): number {
  return (forecast - outcome) ** 2;
}

/**
 * How much better the model forecasts than the book does.
 *
 * Positive means the model carries information the price does not. Zero means
 * it is an expensive way to reproduce the ask. This is the question worth
 * asking — "is the model right more often than a coin" is not, because the
 * book is not a coin and the book is the counterparty.
 */
export function skillScore(brierModel: number, brierMarket: number): number {
  if (brierMarket <= 0) return 0;
  return 1 - brierModel / brierMarket;
}

// ------------------------------------------------------------------ resampling

/**
 * Deterministic PRNG (mulberry32), so a confidence interval is a property of
 * the data rather than of the moment it was computed.
 *
 * Octagon's version calls Math.random. That is defensible for a one-shot
 * report and useless for the thing this app actually does with the number,
 * which is re-run the study after changing the model and ask whether the
 * interval moved. With an unseeded generator the interval moves regardless.
 */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile interval over a sorted vector of bootstrap statistics.
 *
 * Split out because both bootstraps need it and because an off-by-one in the
 * index arithmetic silently narrows every interval the app reports.
 */
function percentileCI(stats: number[], alpha: number): [number, number] {
  if (stats.length === 0) return [0, 0];
  const sorted = [...stats].sort((a, b) => a - b);
  const at = (q: number): number => {
    const i = Math.floor(q * sorted.length);
    return sorted[Math.min(Math.max(i, 0), sorted.length - 1)];
  };
  return [at(alpha / 2), at(1 - alpha / 2)];
}

/**
 * Ordinary row bootstrap. Correct only when rows really are independent —
 * kept so the cluster version can be compared against it and the difference
 * shown, which is the most convincing way to demonstrate the correction
 * matters.
 */
export function bootstrapCI(
  data: number[],
  statFn: (sample: number[]) => number,
  iterations = 4000,
  alpha = 0.05,
  seed = 12345,
): [number, number] {
  if (data.length === 0) return [0, 0];
  const rnd = seededRandom(seed);
  const stats: number[] = [];
  const sample = new Array<number>(data.length);
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < data.length; j++) sample[j] = data[Math.floor(rnd() * data.length)];
    stats.push(statFn(sample));
  }
  return percentileCI(stats, alpha);
}

/**
 * Cluster bootstrap — resamples whole events, so correlated rows inside an
 * event cannot masquerade as independent evidence.
 *
 * `groups` holds row indices; `statFn` receives the pooled indices of one
 * resampled draw and returns the statistic. Indices rather than values because
 * the callers here need two parallel vectors (model Brier and market Brier) and
 * copying both per iteration is wasteful.
 */
export function clusterBootstrapCI(
  groups: number[][],
  statFn: (sampleIndices: number[]) => number,
  iterations = 4000,
  alpha = 0.05,
  seed = 12345,
): [number, number] {
  if (groups.length === 0) return [0, 0];
  const rnd = seededRandom(seed);
  const stats: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const pooled: number[] = [];
    for (let j = 0; j < groups.length; j++) {
      const g = groups[Math.floor(rnd() * groups.length)];
      for (const idx of g) pooled.push(idx);
    }
    if (pooled.length === 0) {
      stats.push(0);
      continue;
    }
    stats.push(statFn(pooled));
  }
  return percentileCI(stats, alpha);
}

/**
 * The event a market belongs to.
 *
 * Kalshi market tickers are `SERIES-EVENT-OUTCOME`, and the outcome segment
 * never contains a dash — strikes carry a decimal point instead (`T78899.99`,
 * `B1.2345678`). So the last dash is the boundary. Audited over every ticker
 * this app has ever written down — 5,523 of them across 119 series, the
 * settlement record and both scan logs — and all 5,523 have exactly three
 * segments. Nothing in the record can collapse to its series, which is the
 * only way this rule could merge two events that are genuinely separate.
 *
 * This is also the engine's risk boundary: `TradingEngine.eventOf` calls
 * straight through, so the ladder cap, the loss lockout and every study built
 * on `groupByEvent` cannot drift apart. They did drift, from 1.10.0 until
 * 1.15.1 — see the comment on `TradingEngine.eventOf` for what that cost.
 *
 * No copies survive. `splitTicker` in `src/pages/Signals.tsx` calls this to
 * find the boundary and keeps the remainder as the outcome, so the ladders
 * the page draws are by construction the ladders the engine enforces.
 */
export function eventOf(ticker: string): string {
  const i = ticker.lastIndexOf("-");
  return i <= 0 ? ticker : ticker.slice(0, i);
}

/** Row indices grouped by event, ready for `clusterBootstrapCI`. */
export function groupByEvent<T>(rows: T[], key: (row: T) => string): number[][] {
  const byEvent = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const k = key(row);
    const arr = byEvent.get(k);
    if (arr) arr.push(i);
    else byEvent.set(k, [i]);
  });
  return [...byEvent.values()];
}

/**
 * Independent observations, honestly counted.
 *
 * Reported alongside the row count in every study, because the gap between the
 * two IS the correction — "412 signals across 6 events" tells the reader
 * immediately that the interval will be wide, before they read it.
 */
export function effectiveN(groups: number[][]): number {
  return groups.length;
}

// ------------------------------------------------------------------ baselines

/**
 * One evaluated decision, reduced to what every metric here needs.
 *
 * `outcome` is 1 when YES settled. `priceCents` is what a YES contract cost at
 * the moment of the decision — the baselines need it to price their own
 * hypothetical fills, and the price bands need it to bucket.
 */
export interface SkillRow {
  ticker: string;
  event: string;
  /** The model's probability that YES settles, 0..1. */
  modelProb: number;
  /** The book's implied probability that YES settles, 0..1. */
  marketProb: number;
  /**
   * Cost of the side the model actually took, 1..99 cents. Bands bucket on
   * this, because "the model bought an 85c favourite" and "the model bought a
   * 30c longshot" are different claims that must not be averaged together.
   */
  priceCents: number;
  /**
   * What each side would really have cost. Both are carried because the
   * baselines have to pay their own ask — pricing always-NO as `100 - yesAsk`
   * hands the baseline a free crossing of the spread twice a row, which on a
   * 3c spread is worth more than any edge under discussion.
   */
  yesAskCents: number;
  noAskCents: number;
  /** 1 if YES settled, 0 if NO. */
  outcome: 0 | 1;
  /** Which way the model actually wanted to trade. */
  side: "yes" | "no";
  /** Net cents after fees if this decision were taken one lot. */
  pnlCents: number;
}

export interface Baseline {
  label: string;
  /** Fraction of rows this baseline called correctly. */
  hitRate: number;
  /** Net cents per contract, fees included. */
  pnlPerContract: number;
}

export interface BandSkill {
  band: string;
  n: number;
  modelPnl: number;
  baselinePnl: number;
  /** Model minus the better of the two dumb baselines, cents per contract. */
  deltaCents: number;
}

/** Entry-price buckets. A 90c favourite and a 20c longshot are not comparable. */
export const PRICE_BANDS: ReadonlyArray<{ label: string; lo: number; hi: number }> = [
  { label: "1-20c", lo: 1, hi: 20 },
  { label: "20-40c", lo: 20, hi: 40 },
  { label: "40-60c", lo: 40, hi: 60 },
  { label: "60-80c", lo: 60, hi: 80 },
  { label: "80-99c", lo: 80, hi: 100 },
];

/**
 * What the same rows would have paid with the model switched off.
 *
 * Buying every YES, and buying every NO, over the identical population. Fees
 * are charged at one lot with the same rounding the real thing would face, so
 * the comparison is like for like — a baseline computed gross against a model
 * computed net manufactures skill out of arithmetic.
 */
export function dumbBaselines(
  rows: SkillRow[],
  feeCents: (priceCents: number) => number,
): Baseline[] {
  if (rows.length === 0) return [];
  let yesHits = 0;
  let noHits = 0;
  let yesPnl = 0;
  let noPnl = 0;
  for (const r of rows) {
    const yesCost = r.yesAskCents;
    const noCost = r.noAskCents;
    if (r.outcome === 1) {
      yesHits++;
      yesPnl += 100 - yesCost - feeCents(yesCost);
      noPnl += -noCost - feeCents(noCost);
    } else {
      noHits++;
      yesPnl += -yesCost - feeCents(yesCost);
      noPnl += 100 - noCost - feeCents(noCost);
    }
  }
  const n = rows.length;
  return [
    { label: "always YES", hitRate: yesHits / n, pnlPerContract: yesPnl / n },
    { label: "always NO", hitRate: noHits / n, pnlPerContract: noPnl / n },
  ];
}

/**
 * Model advantage inside each entry-price band.
 *
 * The band is the control for price mix. Against the whole book, a model that
 * only buys 90c favourites posts a gaudy hit rate that says nothing except
 * that it bought favourites; inside the 80-99c band it has to beat the other
 * favourites to score. The baseline compared against is the BETTER of always-
 * YES and always-NO in that band, so the model has to beat the best dumb thing
 * available rather than a convenient one.
 */
export function withinBandSkill(
  rows: SkillRow[],
  feeCents: (priceCents: number) => number,
): BandSkill[] {
  const out: BandSkill[] = [];
  for (const band of PRICE_BANDS) {
    const inBand = rows.filter((r) => r.priceCents >= band.lo && r.priceCents < band.hi);
    if (inBand.length === 0) continue;
    const modelPnl = inBand.reduce((s, r) => s + r.pnlCents, 0) / inBand.length;
    const base = dumbBaselines(inBand, feeCents);
    const baselinePnl = Math.max(...base.map((b) => b.pnlPerContract));
    out.push({
      band: band.label,
      n: inBand.length,
      modelPnl,
      baselinePnl,
      deltaCents: modelPnl - baselinePnl,
    });
  }
  return out;
}

// ------------------------------------------------------------------ the report

export interface SkillReport {
  n: number;
  /** Distinct events — the honest denominator. */
  events: number;
  hitRate: number;
  /** Event-clustered 95% interval on the hit rate. */
  hitRateCI: [number, number];
  /** The same interval computed the wrong way, for contrast. */
  hitRateNaiveCI: [number, number];
  brierModel: number;
  brierMarket: number;
  skill: number;
  /** Event-clustered 95% interval on the skill score. */
  skillCI: [number, number];
  pnlPerContract: number;
  baselines: Baseline[];
  bands: BandSkill[];
  /** True only when the clustered interval excludes zero skill. */
  significant: boolean;
  verdict: string;
}

/**
 * The whole scorecard, computed once.
 *
 * `significant` is deliberately strict: the CLUSTERED lower bound on the skill
 * score has to clear zero. Not the win rate, not the naive interval, not the
 * P&L. Everything this project has measured so far looked promising until the
 * right denominator was used.
 */
export function skillReport(
  rows: SkillRow[],
  feeCents: (priceCents: number) => number,
  seed = 12345,
): SkillReport {
  if (rows.length === 0) {
    return {
      n: 0,
      events: 0,
      hitRate: 0,
      hitRateCI: [0, 0],
      hitRateNaiveCI: [0, 0],
      brierModel: 0,
      brierMarket: 0,
      skill: 0,
      skillCI: [0, 0],
      pnlPerContract: 0,
      baselines: [],
      bands: [],
      significant: false,
      verdict: "No rows with a recorded outcome.",
    };
  }

  const groups = groupByEvent(rows, (r) => r.event);
  const hits: number[] = rows.map((r) => ((r.side === "yes") === (r.outcome === 1) ? 1 : 0));
  const hitRate = hits.reduce((a, b) => a + b, 0) / rows.length;

  const bModel = rows.map((r) => brier(r.modelProb, r.outcome));
  const bMarket = rows.map((r) => brier(r.marketProb, r.outcome));
  const brierModel = bModel.reduce((a, b) => a + b, 0) / rows.length;
  const brierMarket = bMarket.reduce((a, b) => a + b, 0) / rows.length;
  const skill = skillScore(brierModel, brierMarket);

  const hitRateCI = clusterBootstrapCI(
    groups,
    (idx) => {
      let s = 0;
      for (const i of idx) s += hits[i];
      return s / idx.length;
    },
    4000,
    0.05,
    seed,
  );
  const hitRateNaiveCI = bootstrapCI(
    hits,
    (sample) => sample.reduce((a, b) => a + b, 0) / sample.length,
    4000,
    0.05,
    seed,
  );
  const skillCI = clusterBootstrapCI(
    groups,
    (idx) => {
      let m = 0;
      let k = 0;
      for (const i of idx) {
        m += bModel[i];
        k += bMarket[i];
      }
      return skillScore(m / idx.length, k / idx.length);
    },
    4000,
    0.05,
    seed,
  );

  const pnlPerContract = rows.reduce((s, r) => s + r.pnlCents, 0) / rows.length;
  const baselines = dumbBaselines(rows, feeCents);
  const bands = withinBandSkill(rows, feeCents);
  const bestBaseline = Math.max(...baselines.map((b) => b.pnlPerContract));
  const significant = skillCI[0] > 0;

  let verdict: string;
  if (groups.length < 20) {
    verdict =
      `Not enough independent events (${groups.length}) to conclude anything. ` +
      `Rows are not evidence; events are.`;
  } else if (significant && pnlPerContract > bestBaseline) {
    verdict =
      `Model forecasts better than the book (skill +${(skill * 100).toFixed(1)}%, ` +
      `clustered CI excludes zero) and beats the best dumb baseline by ` +
      `${(pnlPerContract - bestBaseline).toFixed(2)}c per contract.`;
  } else if (skill > 0 && !significant) {
    verdict =
      `Inconclusive. Skill is +${(skill * 100).toFixed(1)}% but the event-clustered ` +
      `interval includes zero, so the sample cannot rule out luck.`;
  } else if (pnlPerContract <= bestBaseline) {
    verdict =
      `No skill. A dumb baseline over the same rows pays ` +
      `${bestBaseline.toFixed(2)}c against the model's ${pnlPerContract.toFixed(2)}c — ` +
      `the model is an expensive way to reproduce it.`;
  } else {
    verdict = `No skill detected (${(skill * 100).toFixed(1)}% vs the book).`;
  }

  return {
    n: rows.length,
    events: groups.length,
    hitRate,
    hitRateCI,
    hitRateNaiveCI,
    brierModel,
    brierMarket,
    skill,
    skillCI,
    pnlPerContract,
    baselines,
    bands,
    significant,
    verdict,
  };
}

// ------------------------------------------------------------------ tagging

/**
 * A label naming the exact slice a signal came from, so performance can be
 * decomposed instead of averaged.
 *
 * Borrowed from CloddsBot's divergence detector (`BTC_DOWN_s12-14_w15`), whose
 * point is that one number for a strategy hides the case where half its
 * configurations print money and the other half bleed it. A blended "roughly
 * break-even" is the shape that result takes, and it is indistinguishable from
 * a strategy that simply does not work.
 *
 * Form: `BTC_YES_e2-4_t05-15` — underlying, side, claimed-edge bucket in cents,
 * minutes remaining bucket.
 */
export function strategyTag(input: {
  asset: string;
  side: "yes" | "no";
  edgeCents: number;
  minsLeft: number;
}): string {
  return [
    input.asset.toUpperCase(),
    input.side.toUpperCase(),
    `e${bucketLabel(input.edgeCents, EDGE_BUCKETS)}`,
    `t${bucketLabel(input.minsLeft, TIME_BUCKETS)}`,
  ].join("_");
}

const EDGE_BUCKETS = [0, 1, 2, 4, 8, Infinity];
const TIME_BUCKETS = [0, 5, 15, 30, 60, Infinity];

function bucketLabel(value: number, edges: number[]): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  for (let i = 0; i < edges.length - 1; i++) {
    if (value >= edges[i] && value < edges[i + 1]) {
      return edges[i + 1] === Infinity ? `${pad(edges[i])}+` : `${pad(edges[i])}-${pad(edges[i + 1])}`;
    }
  }
  return "na";
}

export interface TagPerformance {
  tag: string;
  n: number;
  events: number;
  hitRate: number;
  pnlPerContract: number;
}

/**
 * Per-tag scorecard, sorted worst first.
 *
 * Worst first on purpose. The interesting question about a strategy is never
 * which slice looks best — with enough slices one always will — it is whether
 * any slice is reliably losing, because that is the one to switch off.
 */
export function tagPerformance(rows: (SkillRow & { tag: string })[]): TagPerformance[] {
  const byTag = new Map<string, (SkillRow & { tag: string })[]>();
  for (const r of rows) {
    const arr = byTag.get(r.tag);
    if (arr) arr.push(r);
    else byTag.set(r.tag, [r]);
  }
  const out: TagPerformance[] = [];
  for (const [tag, group] of byTag) {
    const hits = group.filter((r) => (r.side === "yes") === (r.outcome === 1)).length;
    out.push({
      tag,
      n: group.length,
      events: new Set(group.map((r) => r.event)).size,
      hitRate: hits / group.length,
      pnlPerContract: group.reduce((s, r) => s + r.pnlCents, 0) / group.length,
    });
  }
  return out.sort((a, b) => a.pnlPerContract - b.pnlPerContract);
}
