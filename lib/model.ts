// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// radar-4 is a fitted model, not a priced median. It fits a regression on the live protocols
// that already trade, then prices every pre-token protocol off that fit:
//
//   log(market cap) = a + b * log(TVL) + effect[category]
//
// The fit is done by this program, from the sealed snapshot, every run: the reference set is
// every live protocol (a market cap and a TVL above zero, exchanges left out); the category
// effects go only to categories with at least five live names, the rest share the intercept.
// Growth, age and chain count were tested and left out: on the same snapshot they add nothing
// in-sample and make the out-of-sample error worse (see the validation the program runs).
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and every
// other rankable pre-token protocol below it. A protocol is pre-token when its record carries
// no token (no market cap, no CoinGecko id, no symbol); the snapshot's live-token protocols are
// kept apart and shown as the market's own values, never mixed into the ranked board.
//
// The validation runs at build time, from the same snapshot: a time split (fit on the earlier
// half of the dated live protocols, predict the later half) and a five-fold cross-check, plus
// the median-ratio baseline on the same split, so the page can say how much the fit beats the
// naive price — and how wide the error still is. The band on each row comes from the holdout
// errors, not from a guess: the value is a ranking device, and the page says so.
//
// The constants are the model's, stated in the dashboard. No protocol name is ever special-cased:
// the same function scores every row.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-4';

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Clamp `v` into [`lo`, `hi`]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A percentile of a sorted list, linearly interpolated. */
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** The mean of a list of numbers. */
function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Ordinary least squares, standard library only. Deterministic: the same
// snapshot always fits the same coefficients, so two runs write the same bytes.
// ---------------------------------------------------------------------------

/** Invert a square matrix by Gauss-Jordan with partial pivoting; null when singular. */
function invertMatrix(a: number[][]): number[][] | null {
  const n = a.length;
  const m = a.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    if (Math.abs(m[pivot]![col]!) < 1e-12) return null;
    if (pivot !== col) {
      const tmp = m[col]!;
      m[col] = m[pivot]!;
      m[pivot] = tmp;
    }
    const div = m[col]![col]!;
    for (let j = 0; j < 2 * n; j++) m[col]![j]! /= div;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r]![col]!;
      if (factor === 0) continue;
      for (let j = 0; j < 2 * n; j++) m[r]![j]! -= factor * m[col]![j]!;
    }
  }
  return m.map((row) => row.slice(n));
}

export interface OlsResult {
  /** One coefficient per design column, in column order; 0 for a column dropped as all-zero. */
  beta: number[];
  /** Standard error per coefficient; 0 for a dropped column. */
  se: number[];
  /** t statistic per coefficient; 0 for a dropped column. */
  t: number[];
  /** R squared on the fitted rows. */
  r2: number;
  /** Residual standard deviation. */
  sigma: number;
  /** Rows fitted. */
  n: number;
  /** Columns kept (a column of all zeros is dropped, never fitted). */
  kept: boolean[];
}

/** Fit y ~ X by least squares. Columns of all zeros are dropped before solving. */
function ols(design: number[][], y: number[]): OlsResult {
  const n = y.length;
  const kAll = design[0]!.length;
  const kept = Array.from({ length: kAll }, (_, j) => design.some((row) => row[j] !== 0));
  // The intercept is never dropped: it is all ones by construction.
  kept[0] = true;
  const cols = kept.map((k, j) => (k ? j : -1)).filter((j) => j >= 0);
  const k = cols.length;
  const xtx: number[][] = Array.from({ length: k }, () => new Array<number>(k).fill(0));
  const xty: number[] = new Array<number>(k).fill(0);
  for (let i = 0; i < n; i++) {
    const row = design[i]!;
    for (let a = 0; a < k; a++) {
      xty[a]! += row[cols[a]!]! * y[i]!;
      for (let b = 0; b < k; b++) xtx[a]![b]! += row[cols[a]!]! * row[cols[b]!]!;
    }
  }
  const inv = invertMatrix(xtx);
  const yMean = mean(y);
  let ssTot = 0;
  for (const v of y) ssTot += (v - yMean) * (v - yMean);
  if (inv === null) {
    // Singular design: fall back to the mean, so the program still scores.
    const beta = new Array<number>(kAll).fill(0);
    beta[0] = yMean;
    return { beta, se: new Array<number>(kAll).fill(0), t: new Array<number>(kAll).fill(0), r2: 0, sigma: Math.sqrt(ssTot / Math.max(1, n - 1)), n, kept };
  }
  const betaKept = inv.map((row) => row.reduce((s, v, j) => s + v * xty[j]!, 0));
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    let pred = 0;
    for (let a = 0; a < k; a++) pred += design[i]![cols[a]!]! * betaKept[a]!;
    ssRes += (y[i]! - pred) * (y[i]! - pred);
  }
  const dof = Math.max(1, n - kAll);
  const sigma = Math.sqrt(ssRes / dof);
  const beta = new Array<number>(kAll).fill(0);
  const se = new Array<number>(kAll).fill(0);
  const t = new Array<number>(kAll).fill(0);
  for (let a = 0; a < k; a++) {
    beta[cols[a]!] = betaKept[a]!;
    const v = Math.max(0, inv[a]![a]!);
    se[cols[a]!] = sigma * Math.sqrt(v);
    t[cols[a]!] = se[cols[a]!]! > 0 ? betaKept[a]! / se[cols[a]!]! : 0;
  }
  return { beta, se, t, r2: ssTot > 0 ? 1 - ssRes / ssTot : 0, sigma, n, kept };
}

/** Predict one row's y from a fitted coefficient vector (same column order as the fit). */
function predictRow(beta: number[], row: number[]): number {
  return beta.reduce((s, b, j) => s + b * row[j]!, 0);
}

// ---------------------------------------------------------------------------
// The fitted model.
// ---------------------------------------------------------------------------

/** The live protocols the fit learns from: a token that trades, a TVL above zero, no exchange. */
function liveRefs(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter(
    (p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 && p.category !== 'CEX',
  );
}

/** Categories with at least five live names, most names first, name order breaking ties. */
function bigCategories(refs: SnapshotProtocol[]): { category: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const p of refs) {
    const key = p.category ?? 'Uncategorised';
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 5)
    .map(([category, n]) => ({ category, n }))
    .sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : a.category > b.category ? 1 : 0));
}

/**
 * One design row for a protocol: [1, log TVL, category dummies...], plus, when `extra` is
 * set, [growth in points clamped to -60..120, log(age_days + 1) with a missing age as 365
 * days, chain count capped at 5]. The extra terms are fitted only to test them; the model
 * that prices the board never uses them.
 */
function featureRow(
  p: SnapshotProtocol,
  asOf: string,
  bigCats: { category: string; n: number }[],
  extra: boolean,
): number[] {
  const row: number[] = [1, Math.log(p.tvl_usd)];
  for (const c of bigCats) row.push(p.category === c.category ? 1 : 0);
  if (extra) {
    row.push(clamp(finite(p.change_7d, 0), -60, 120));
    const age = ageDays(asOf, p.listed_at);
    row.push(Math.log((age ?? 365) + 1));
    row.push(Math.min(p.chains.length, 5));
  }
  return row;
}

/** The holdout's error summary for one fitted spec. */
export interface HoldoutSummary {
  split_date: string;
  n_train: number;
  n_test: number;
  train_r2: number;
  r2: number;
  mae: number;
  median_abs_err: number;
  coverage50: number;
  coverage80: number;
  /** 10th / 90th percentiles of the holdout log-errors: the band the board's rows carry. */
  q10: number;
  q90: number;
}

/** Score fitted values against truth in log space. */
function scoreHoldout(actual: number[], predicted: number[], sigmaTrain: number): Omit<HoldoutSummary, 'split_date' | 'n_train' | 'n_test' | 'train_r2' | 'q10' | 'q90'> & { errors: number[] } {
  const errors = actual.map((y, i) => y - predicted[i]!);
  const abs = errors.map((e) => Math.abs(e)).sort((a, b) => a - b);
  const meanActual = mean(actual);
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < actual.length; i++) {
    ssTot += (actual[i]! - meanActual) * (actual[i]! - meanActual);
    ssRes += errors[i]! * errors[i]!;
  }
  const cov50 = errors.filter((e) => Math.abs(e) <= 0.6745 * sigmaTrain).length / errors.length;
  const cov80 = errors.filter((e) => Math.abs(e) <= 1.2816 * sigmaTrain).length / errors.length;
  return {
    r2: ssTot > 0 ? 1 - ssRes / ssTot : 0,
    mae: mean(abs),
    median_abs_err: median(abs),
    coverage50: cov50,
    coverage80: cov80,
    errors,
  };
}

/** Everything the dashboard states about the fit, computed from the snapshot at build time. */
export interface FitSummary {
  /** The regression as fitted, in words. */
  spec: string;
  /** Live protocols the fit learns from. */
  n_refs: number;
  /** Dated live protocols, the only ones the time split can use. */
  n_dated: number;
  intercept: number;
  slope_log_tvl: number;
  slope_se: number;
  slope_t: number;
  r2: number;
  adj_r2: number;
  sigma: number;
  /** One entry per fitted category effect, most names first. */
  categories: { category: string; n: number; effect: number; se: number; t: number }[];
  /** The time-split validation of the model that prices the board. */
  holdout: HoldoutSummary;
  /** The same split, fitted with growth, age and chains added: the test that rejects them. */
  holdout_full: { r2: number; mae: number };
  /** The median-ratio baseline on the same split, for the honest comparison. */
  baseline_holdout: { r2: number; mae: number; median_abs_err: number };
  /** Five folds dealt by slug order, model spec only. */
  cv: { mae_mean: number; r2_mean: number };
  /** The kitchen-sink fit's extra terms: the evidence growth, age and chains do not predict. */
  tested: { growth_t: number; age_t: number; chains_t: number };
}

/** The fitted model and its validation, computed from the snapshot. */
export interface FittedModel {
  bigCats: { category: string; n: number }[];
  fit: OlsResult;
  fitFull: OlsResult;
  summary: FitSummary;
  /** The band's log-error quantiles from the holdout, applied to every row. */
  bandQ10: number;
  bandQ90: number;
}

export function fitModel(snapshot: Snapshot): FittedModel {
  const refs = liveRefs(snapshot);
  const bigCats = bigCategories(refs);
  const y = refs.map((p) => Math.log(p.mcap_usd!));
  const design = refs.map((p) => featureRow(p, snapshot.as_of, bigCats, false));
  const fit = ols(design, y);
  const designFull = refs.map((p) => featureRow(p, snapshot.as_of, bigCats, true));
  const fitFull = ols(designFull, y);
  const k = fit.beta.length;
  const adjR2 = 1 - (1 - fit.r2) * ((refs.length - 1) / Math.max(1, refs.length - k));

  // Time split: the dated live protocols, earliest half fits, latest half is predicted.
  const dated = refs
    .filter((p) => p.listed_at !== null)
    .sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : a.listed_at! > b.listed_at! ? 1 : a.slug < b.slug ? -1 : 1));
  const nTrain = Math.ceil(dated.length / 2);
  const train = dated.slice(0, nTrain);
  const test = dated.slice(nTrain);
  const splitDate = train[train.length - 1]!.listed_at!;
  const trainY = train.map((p) => Math.log(p.mcap_usd!));
  const trainDesign = train.map((p) => featureRow(p, snapshot.as_of, bigCats, false));
  const holdoutFit = ols(trainDesign, trainY);
  const testY = test.map((p) => Math.log(p.mcap_usd!));
  const testPred = test.map((p) => predictRow(holdoutFit.beta, featureRow(p, snapshot.as_of, bigCats, false)));
  const scored = scoreHoldout(testY, testPred, holdoutFit.sigma);
  const sortedErr = [...scored.errors].sort((a, b) => a - b);
  const q10 = quantile(sortedErr, 0.1);
  const q90 = quantile(sortedErr, 0.9);

  // The kitchen-sink spec on the same split: the test that rejects growth, age and chains.
  const trainDesignFull = train.map((p) => featureRow(p, snapshot.as_of, bigCats, true));
  const holdoutFitFull = ols(trainDesignFull, trainY);
  const testPredFull = test.map((p) => predictRow(holdoutFitFull.beta, featureRow(p, snapshot.as_of, bigCats, true)));
  const scoredFull = scoreHoldout(testY, testPredFull, holdoutFitFull.sigma);

  // The median-ratio baseline on the same split: log TVL plus the training set's median
  // log(mcap/TVL) — the naive price the fit has to beat.
  const trainRatios = train.map((p) => Math.log(p.mcap_usd! / p.tvl_usd));
  const baseMedian = median(trainRatios);
  const testPredBase = test.map((p) => Math.log(p.tvl_usd) + baseMedian);
  const scoredBase = scoreHoldout(testY, testPredBase, holdoutFit.sigma);

  // Five-fold cross-check, folds dealt by slug order so the run is reproducible.
  const bySlug = [...refs].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const cvMae: number[] = [];
  const cvR2: number[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const testFold = bySlug.filter((_, i) => i % 5 === fold);
    const trainFold = bySlug.filter((_, i) => i % 5 !== fold);
    const foldFit = ols(
      trainFold.map((p) => featureRow(p, snapshot.as_of, bigCats, false)),
      trainFold.map((p) => Math.log(p.mcap_usd!)),
    );
    const actual = testFold.map((p) => Math.log(p.mcap_usd!));
    const pred = testFold.map((p) => predictRow(foldFit.beta, featureRow(p, snapshot.as_of, bigCats, false)));
    const s = scoreHoldout(actual, pred, foldFit.sigma);
    cvMae.push(s.mae);
    cvR2.push(s.r2);
  }

  const categories = bigCats.map((c, i) => ({
    category: c.category,
    n: c.n,
    effect: fit.beta[2 + i]!,
    se: fit.se[2 + i]!,
    t: fit.t[2 + i]!,
  }));
  const summary: FitSummary = {
    spec: 'log(market cap) = a + b·log(TVL) + category effect, fitted on the live protocols',
    n_refs: refs.length,
    n_dated: dated.length,
    intercept: fit.beta[0]!,
    slope_log_tvl: fit.beta[1]!,
    slope_se: fit.se[1]!,
    slope_t: fit.t[1]!,
    r2: fit.r2,
    adj_r2: adjR2,
    sigma: fit.sigma,
    categories,
    holdout: {
      split_date: splitDate,
      n_train: train.length,
      n_test: test.length,
      train_r2: holdoutFit.r2,
      r2: scored.r2,
      mae: scored.mae,
      median_abs_err: scored.median_abs_err,
      coverage50: scored.coverage50,
      coverage80: scored.coverage80,
      q10,
      q90,
    },
    holdout_full: { r2: scoredFull.r2, mae: scoredFull.mae },
    baseline_holdout: { r2: scoredBase.r2, mae: scoredBase.mae, median_abs_err: scoredBase.median_abs_err },
    cv: { mae_mean: mean(cvMae), r2_mean: mean(cvR2) },
    tested: {
      growth_t: fitFull.t[2 + bigCats.length]!,
      age_t: fitFull.t[3 + bigCats.length]!,
      chains_t: fitFull.t[4 + bigCats.length]!,
    },
  };
  return { bigCats, fit, fitFull, summary, bandQ10: q10, bandQ90: q90 };
}

/** The fitted log market cap of one protocol under the model that prices the board. */
function fittedLogMcap(p: SnapshotProtocol, asOf: string, model: FittedModel): number {
  return predictRow(model.fit.beta, featureRow(p, asOf, model.bigCats, false));
}

/** The category effect one protocol's row carries: its fitted category's, else zero. */
function categoryEffect(p: SnapshotProtocol, model: FittedModel): { effect: number; n: number } {
  const hit = model.bigCats.find((c) => c.category === p.category);
  if (hit === undefined) return { effect: 0, n: 0 };
  const idx = model.bigCats.indexOf(hit);
  return { effect: model.fit.beta[2 + idx]!, n: hit.n };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** The watchlist's own exclusions: a wrapped, staked or bridged product of a token that already trades is not a token still to come. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Whether a protocol is one the board may rank: pre-token, and none of the watchlist's
 * exclusions — not a bridge, not liquid staking or restaking, not a versioned pool, not a
 * wrapped or staked product, not an exchange's own product. The watchlist itself is always
 * ranked; this rule shapes the early rows below it.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    fitted_log_mcap: number;
    intercept: number;
    slope_log_tvl: number;
    log_tvl: number;
    category_effect: number;
    category_n: number;
    implied_low_usd: number;
    implied_high_usd: number;
    growth_pct: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's view of one row, with its farm plan and model breakdown. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  fitted_log_mcap: number;
  intercept: number;
  slope_log_tvl: number;
  log_tvl: number;
  category_effect: number;
  category_n: number;
  implied_low_usd: number;
  implied_high_usd: number;
  growth_pct: number;
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  /** The fitted model and its validation, computed from this snapshot. */
  fit: FitSummary;
  model_version: string;
  global_median: number;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  /** The watchlist's slugs, so the page can mark them. */
  watchlist: string[];
  /** One row per category with live protocols: its median ratio, spread and fitted effect. */
  multiples: {
    category: string;
    n: number;
    median: number;
    q1: number;
    q3: number;
    effect: number;
    fitted_multiple_100m: number;
  }[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: FittedModel): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names is ranked, whatever its TVL.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other rankable pre-token protocol, not just the largest few. A
  // protocol below the floor is no worse a subject than one on it, and the radar exists to
  // find them all.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const logPred = fittedLogMcap(p, snapshot.as_of, model);
    const implied = Math.max(1, Math.round(Math.exp(logPred)));
    const low = Math.max(1, Math.round(Math.exp(logPred + model.bandQ10)));
    const high = Math.max(1, Math.round(Math.exp(logPred + model.bandQ90)));
    const { effect, n } = categoryEffect(p, model);
    return { p, logPred, implied, low, high, effect, n };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => {
    const age = ageDays(snapshot.as_of, s.p.listed_at);
    const growthPct = clamp(finite(s.p.change_7d, 0), -60, 120);
    return {
      rank: i + 1,
      slug: s.p.slug,
      name: s.p.name,
      category: s.p.category,
      chains: s.p.chains,
      tvl_usd: s.p.tvl_usd,
      change_7d: s.p.change_7d,
      mcap_usd: s.p.mcap_usd,
      listed_at: s.p.listed_at,
      gecko_id: s.p.gecko_id,
      symbol: s.p.symbol,
      token_status: 'pre-token' as const,
      age_days: age,
      implied_value_usd: s.implied,
      model: {
        fitted_log_mcap: round4(s.logPred),
        intercept: round4(model.summary.intercept),
        slope_log_tvl: round4(model.summary.slope_log_tvl),
        log_tvl: round4(Math.log(s.p.tvl_usd)),
        category_effect: round4(s.effect),
        category_n: s.n,
        implied_low_usd: s.low,
        implied_high_usd: s.high,
        growth_pct: growthPct,
        age_days: age,
      },
      farm_steps: farmSteps(s.p, age, s.low).map(stepText),
    };
  });
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('amm') || c.includes('liquidity')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  if (c.includes('yield') || c.includes('farm') || c.includes('leveraged')) return `Deposit $${capital} into ${name}'s main yield position on ${chain} and keep it open.`;
  if (c.includes('launchpad')) return `Join ${name}'s next launch allocation on ${chain} with $${capital}.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** The week's qualifying actions for the category, in the farmer's own terms. */
function weeklyFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return 'a supply top-up, a borrow, a repay or a vote';
  if (c.includes('dex') || c.includes('amm') || c.includes('liquidity')) return 'a swap, adding liquidity or a vote';
  if (c.includes('bridge')) return 'a bridge, a swap or a vote';
  if (c.includes('staking') || c.includes('restak')) return 'a stake top-up, a rewards claim or a vote';
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return 'a small hedged trade, a margin top-up or a vote';
  if (c.includes('prediction')) return 'a market position or a vote';
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) return 'a deposit, a rebalance check or a vote';
  if (c.includes('stable')) return 'a mint, a deposit or a vote';
  if (c.includes('rwa')) return 'a mint, a hold check or a vote';
  if (c.includes('insurance')) return 'a cover check, a claim or a vote';
  if (c.includes('yield') || c.includes('farm') || c.includes('leveraged')) return 'a deposit, a yield claim or a vote';
  if (c.includes('launchpad')) return 'a launch check, an allocation or a vote';
  if (c.includes('basis')) return 'a hedge rebalance, a funding-rate check or a vote';
  if (c === 'chain') return 'a transaction, a stake or a vote';
  return 'a deposit, a borrow, a swap or a vote';
}

/** A short dollar figure in the dashboard's own style: $766.0M, $4.6M, $842.0K. */
function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age, 7-day move), never from a
 * hand-written list of names. Each step states what to do first, what it costs and how long
 * it takes; nothing in it is a promised return — the plan buys eligibility for a future
 * token, and the prize it points at is netted at the low end of the fitted band, not the
 * point estimate, so the economics are stated on the conservative side.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null, impliedLow: number): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const gas = capital >= 150 ? 8 : 4;
  // The bridge action moves the funds itself, so it needs no bridging first; every other
  // action needs the capital sitting on the chain before it starts.
  const isBridge = (p.category ?? '').toLowerCase().includes('bridge');
  const setup = isBridge ? action : `${action} Have the $${capital} on ${chain} first — bridge it in if it sits elsewhere.`;
  const trend =
    p.change_7d === null
      ? ''
      : p.change_7d === 0
        ? ' TVL is flat over the last 7 days.'
        : ` TVL is ${p.change_7d > 0 ? 'up' : 'down'} ${Math.abs(p.change_7d).toFixed(1)}% over the last 7 days.`;
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: setup,
      cost: `$${capital} of capital and about $${gas} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week on ${chain}, such as ${weeklyFor(p)}. Confirm on the protocol's own pages which actions earn points — only those count.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.${trend} If TVL drops 20% or more in a week, check the protocol is still active before you add more.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it. The prize this plan points at is the low end of the fitted band — ${fmtUsd(impliedLow)} at today's TVL — and the plan buys eligibility for it, not a share of it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 24)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** One category's live ratios, for the multiples table's context columns. */
function categoryRatioStats(snapshot: Snapshot): Map<string, { n: number; median: number; q1: number; q3: number }> {
  const byCategory = new Map<string, number[]>();
  for (const p of liveRefs(snapshot)) {
    const key = p.category ?? 'Uncategorised';
    const list = byCategory.get(key);
    if (list === undefined) byCategory.set(key, [p.mcap_usd! / p.tvl_usd]);
    else list.push(p.mcap_usd! / p.tvl_usd);
  }
  const out = new Map<string, { n: number; median: number; q1: number; q3: number }>();
  for (const [key, list] of byCategory) {
    const sorted = [...list].sort((a, b) => a - b);
    out.set(key, { n: list.length, median: median(list), q1: quantile(sorted, 0.25), q3: quantile(sorted, 0.75) });
  }
  return out;
}

/** A board row's form for data.js, with its farm plan and model breakdown. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    fitted_log_mcap: row.model.fitted_log_mcap,
    intercept: row.model.intercept,
    slope_log_tvl: row.model.slope_log_tvl,
    log_tvl: row.model.log_tvl,
    category_effect: row.model.category_effect,
    category_n: row.model.category_n,
    implied_low_usd: row.model.implied_low_usd,
    implied_high_usd: row.model.implied_high_usd,
    growth_pct: row.model.growth_pct,
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(
  snapshot: Snapshot,
): { board: BoardRow[]; radar: RadarData } {
  const model = fitModel(snapshot);
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const refs = liveRefs(snapshot);
  const ratios = refs.map((p) => p.mcap_usd! / p.tvl_usd);
  const ratioStats = categoryRatioStats(snapshot);
  const effectByCat = new Map(model.summary.categories.map((c) => [c.category, c.effect]));
  const multiples = [...ratioStats.entries()].map(([category, s]) => {
    const effect = effectByCat.get(category) ?? 0;
    // The fitted multiple at $100M of TVL: exp(a + effect) * TVL^(b-1), the rate the fit
    // implies for a protocol of that size in this category.
    const fittedMultiple100m = Math.exp(model.summary.intercept + effect) * Math.pow(1e8, model.summary.slope_log_tvl - 1);
    return {
      category,
      n: s.n,
      median: round4(s.median),
      q1: round4(s.q1),
      q3: round4(s.q3),
      effect: round4(effect),
      fitted_multiple_100m: round4(fittedMultiple100m),
    };
  });
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    fit: model.summary,
    model_version: MODEL_VERSION,
    global_median: round4(median(ratios)),
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    watchlist: [...snapshot.watchlist],
    multiples,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100-row floor`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
