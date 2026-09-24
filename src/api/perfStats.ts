/**
 * Performance-engineering statistics: the numbers a performance or QA team asks
 * for when they are deciding whether a change is real.
 *
 * `stats.ts` answers "how long did it take" for the workbench. This module
 * answers the three harder questions that come next:
 *
 *   1. **What is the shape of the distribution?** Latency is right-skewed, so a
 *      median alone hides the tail that actually pages someone. Hence the full
 *      percentile set, IQR, MAD and an explicit outlier count rather than a mean
 *      and a standard deviation, which both assume a symmetry latency does not
 *      have.
 *   2. **Is the difference between two engine sizes real, or is it noise?** A
 *      median that moved 8% across 20 runs may be nothing. `mannWhitney` gives a
 *      p-value without assuming normality, `hodgesLehmann` gives the size of the
 *      shift in milliseconds, and `cliffsDelta` gives a scale-free effect size.
 *      All three are reported together on purpose: a p-value alone says only
 *      that *something* moved, and with enough samples everything moves.
 *   3. **Is this sample even fit to quote?** `sampleHealth` is the check an SE
 *      wants before pasting a table into a customer deck.
 *
 * Two house rules carried over from `stats.ts` and applied throughout:
 *
 *   - **A statistic is withheld when the sample cannot support it.** A
 *     nearest-rank percentile is arithmetically just the maximum until the
 *     sample is large enough (see `quantileMinSamples`), so reporting "p99" off
 *     20 runs would be relabelling the slowest run. Those come back null.
 *   - **Nothing here is inferred from a warm-up or a failure.** Callers pass
 *     successful measured runs only; this module does no filtering of its own.
 */

import { mean, quantile, stdev } from './stats';

/**
 * Smallest sample size at which a nearest-rank percentile is distinguishable
 * from the maximum.
 *
 * Nearest-rank picks index `ceil(p * n) - 1`, which equals `n - 1` — the max —
 * for every `n < 1 / (1 - p)`. So p90 needs 10 samples, p95 needs 20, p99 needs
 * 100. `P95_MIN_SAMPLES` in stats.ts is this same arithmetic, hardcoded.
 */
export function quantileMinSamples(p: number): number {
  if (p <= 0 || p >= 1) return 1;
  // Rounded before the ceiling: 1/(1-0.9) evaluates to 10.000000000000002 in
  // binary floating point, and a bare Math.ceil would demand an 11th run to
  // report p90. The threshold is exact arithmetic, so the representation error
  // must not leak into it.
  const exact = Math.round((1 / (1 - p)) * 1e9) / 1e9;
  return Math.max(2, Math.ceil(exact));
}

/** The percentiles reported in the analysis table, in display order. */
export const REPORTED_PERCENTILES = [0.5, 0.9, 0.95, 0.99] as const;

/** Sample size below which a two-sample normal approximation is not trusted. */
export const MIN_COMPARE_SAMPLES = 8;

/** Effect-size thresholds for Cliff's delta (Romano et al.). */
const DELTA_BANDS: [number, EffectSize][] = [
  [0.147, 'negligible'],
  [0.33, 'small'],
  [0.474, 'medium'],
];

export type EffectSize = 'negligible' | 'small' | 'medium' | 'large';

export interface ExtendedSummary {
  n: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  /** Sample standard deviation (n-1). Reported for continuity with other tools,
   *  not used as the headline spread — see the module note on skew. */
  stdev: number | null;
  /** stdev / mean. The conventional noise gauge; above ~0.3 the run is soft. */
  cv: number | null;
  /** Nearest-rank percentiles, null where the sample is too small to support one. */
  percentiles: Record<string, number | null>;
  /** Interquartile range (p75 - p25): spread that ignores the tail entirely. */
  iqr: number | null;
  /** Median absolute deviation. Robust spread; unaffected by a single freak run. */
  mad: number | null;
  /** Tukey fences at 1.5 x IQR, and how many samples fell outside them. */
  outliers: number;
  fenceLow: number | null;
  fenceHigh: number | null;
}

function percentileKey(p: number): string {
  return `p${Math.round(p * 100)}`;
}

/** Median absolute deviation: median(|x - median(x)|). */
export function mad(values: number[]): number | null {
  const centre = quantile(values, 0.5);
  if (centre === null) return null;
  return quantile(
    values.map((value) => Math.abs(value - centre)),
    0.5,
  );
}

export function iqr(values: number[]): number | null {
  const low = quantile(values, 0.25);
  const high = quantile(values, 0.75);
  return low === null || high === null ? null : high - low;
}

/**
 * Tukey fences at 1.5 x IQR. Used to *count and disclose* outliers, never to
 * drop them: a slow run on a shared engine is a real thing that happened, and
 * silently trimming it is how a benchmark starts flattering itself.
 */
export function tukeyFences(values: number[]): { low: number | null; high: number | null } {
  const q1 = quantile(values, 0.25);
  const q3 = quantile(values, 0.75);
  const spread = iqr(values);
  if (q1 === null || q3 === null || spread === null) return { low: null, high: null };
  return { low: q1 - 1.5 * spread, high: q3 + 1.5 * spread };
}

export function extendedSummary(values: number[]): ExtendedSummary {
  const average = mean(values);
  const spread = stdev(values);
  const percentiles: Record<string, number | null> = {};
  for (const p of REPORTED_PERCENTILES) {
    percentiles[percentileKey(p)] =
      values.length >= quantileMinSamples(p) ? quantile(values, p) : null;
  }
  const fences = tukeyFences(values);
  const outliers =
    fences.low === null || fences.high === null
      ? 0
      : values.filter((value) => value < fences.low! || value > fences.high!).length;
  return {
    n: values.length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    mean: average,
    stdev: spread,
    cv: spread !== null && average ? spread / average : null,
    percentiles,
    iqr: iqr(values),
    mad: mad(values),
    outliers,
    fenceLow: fences.low,
    fenceHigh: fences.high,
  };
}

/**
 * Upper tail of the standard normal, via the Abramowitz & Stegun 7.1.26 erf
 * approximation (absolute error < 1.5e-7). Good to far more precision than a
 * p-value printed to three decimals needs, and keeps this module dependency-free.
 */
export function normalSf(z: number): number {
  const sign = z < 0 ? -1 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) *
      t *
      Math.exp(-x * x);
  return 0.5 * (1 - sign * erf);
}

/** Ranks with ties averaged, plus the tie-group sizes the U variance needs. */
function rankWithTies(values: number[]): { ranks: number[]; tieGroups: number[] } {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);
  const ranks = new Array<number>(values.length);
  const tieGroups: number[] = [];
  let position = 0;
  while (position < indexed.length) {
    let end = position;
    while (end + 1 < indexed.length && indexed[end + 1].value === indexed[position].value) end += 1;
    const size = end - position + 1;
    // Average rank for the tied block, 1-based.
    const shared = (position + end + 2) / 2;
    for (let offset = position; offset <= end; offset += 1) ranks[indexed[offset].index] = shared;
    if (size > 1) tieGroups.push(size);
    position = end + 1;
  }
  return { ranks, tieGroups };
}

export interface MannWhitneyResult {
  /** U for the baseline group. */
  u: number;
  /** Normal-approximation z, continuity-corrected. */
  z: number | null;
  /** Two-sided p-value, or null when the sample is too small to approximate. */
  p: number | null;
  /** False when either group is under MIN_COMPARE_SAMPLES. */
  usable: boolean;
  /** Plain-language reason when `usable` is false. */
  reason: string;
}

/**
 * Mann-Whitney U (Wilcoxon rank-sum), two-sided, normal approximation with
 * continuity and tie corrections.
 *
 * Chosen over Student's t because search latency is not normally distributed —
 * it is right-skewed with a hard floor and an open tail, which is exactly the
 * case where a t-test's assumptions bite. This tests whether one sample tends to
 * produce lower times than the other, which is the question being asked.
 *
 * A p-value is not a verdict on its own. Read it beside `cliffsDelta` (how
 * separated the samples are) and `hodgesLehmann` (how many milliseconds), since
 * a large enough sample makes any difference "significant".
 */
export function mannWhitney(baseline: number[], candidate: number[]): MannWhitneyResult {
  const n1 = baseline.length;
  const n2 = candidate.length;
  if (!n1 || !n2) {
    return { u: 0, z: null, p: null, usable: false, reason: 'One of the two samples is empty.' };
  }
  const { ranks, tieGroups } = rankWithTies([...baseline, ...candidate]);
  const rankSum1 = ranks.slice(0, n1).reduce((sum, rank) => sum + rank, 0);
  const u = rankSum1 - (n1 * (n1 + 1)) / 2;

  if (n1 < MIN_COMPARE_SAMPLES || n2 < MIN_COMPARE_SAMPLES) {
    return {
      u,
      z: null,
      p: null,
      usable: false,
      reason: `Needs ${MIN_COMPARE_SAMPLES} timed runs in each sample for the approximation to hold; have ${n1} and ${n2}.`,
    };
  }

  const total = n1 + n2;
  const mu = (n1 * n2) / 2;
  const tieTerm = tieGroups.reduce((sum, size) => sum + (size ** 3 - size), 0);
  const variance =
    ((n1 * n2) / 12) * (total + 1 - tieTerm / (total * (total - 1)));
  if (variance <= 0) {
    return {
      u,
      z: null,
      p: null,
      usable: false,
      reason: 'Every run produced an identical time, so there is no variance to test.',
    };
  }
  const sigma = Math.sqrt(variance);
  const deviation = Math.abs(u - mu);
  // Continuity correction, floored at zero so a difference smaller than half a
  // rank cannot produce a negative z.
  const z = Math.max(0, deviation - 0.5) / sigma;
  return { u, z, p: Math.min(1, 2 * normalSf(z)), usable: true, reason: '' };
}

/**
 * Cliff's delta: the probability a candidate run is faster than a baseline run,
 * minus the probability it is slower.
 *
 * Signed so that **positive means the candidate was faster** (lower times),
 * which is the direction an operator expects from a bigger engine. Scale-free,
 * so it is comparable across searches and windows in a way a millisecond
 * difference is not.
 */
export function cliffsDelta(baseline: number[], candidate: number[]): number | null {
  if (!baseline.length || !candidate.length) return null;
  let faster = 0;
  let slower = 0;
  for (const base of baseline) {
    for (const value of candidate) {
      if (value < base) faster += 1;
      else if (value > base) slower += 1;
    }
  }
  return (faster - slower) / (baseline.length * candidate.length);
}

export function interpretDelta(delta: number | null): EffectSize | null {
  if (delta === null) return null;
  const magnitude = Math.abs(delta);
  for (const [bound, label] of DELTA_BANDS) if (magnitude < bound) return label;
  return 'large';
}

/**
 * Hodges-Lehmann estimator: the median of every pairwise difference
 * `candidate - baseline`, in the original units.
 *
 * This is the shift that goes with the Mann-Whitney test — the difference of the
 * medians is *not*, and can point the other way on skewed samples. **Negative
 * means the candidate was faster.**
 *
 * O(n1 x n2), which is fine at benchmark sample sizes (tens to low hundreds per
 * cell) and avoids approximating the thing the whole page exists to report.
 */
export function hodgesLehmann(baseline: number[], candidate: number[]): number | null {
  if (!baseline.length || !candidate.length) return null;
  const differences: number[] = [];
  for (const base of baseline) for (const value of candidate) differences.push(value - base);
  return quantile(differences, 0.5);
}

export interface MedianInterval {
  low: number;
  high: number;
  /** Actual coverage of the order statistics used, which is >= the level asked for. */
  coverage: number;
}

/**
 * Distribution-free confidence interval for the median, from the binomial order
 * statistics (normal approximation to the rank bounds).
 *
 * Distribution-free because a bootstrap would need a PRNG and reproducible
 * seeding to be defensible in a report, and a parametric interval would reassert
 * the normality assumption this module is avoiding. Null below 6 samples, where
 * the interval degenerates to the full range and says nothing.
 */
export function medianInterval(values: number[], level = 0.95): MedianInterval | null {
  const n = values.length;
  if (n < 6) return null;
  const sorted = [...values].sort((a, b) => a - b);
  // z for the two-sided level, e.g. 1.96 at 95%.
  const z = level >= 0.99 ? 2.5758 : level >= 0.95 ? 1.96 : 1.6449;
  const half = (z * Math.sqrt(n)) / 2;
  const lowRank = Math.max(1, Math.floor(n / 2 - half));
  const highRank = Math.min(n, Math.ceil(n / 2 + half + 1));
  return {
    low: sorted[lowRank - 1],
    high: sorted[highRank - 1],
    coverage: level,
  };
}

export type Verdict = 'pass' | 'fail' | 'unknown';

/** Which statistic an acceptance budget is applied to. */
export type BudgetStatistic = 'p50' | 'p90' | 'p95' | 'p99';

export interface BudgetResult {
  verdict: Verdict;
  /** The measured value the verdict was reached on, ms. */
  value: number | null;
  /** Headroom against the budget, ms. Negative means over budget. */
  headroomMs: number | null;
  /** Why, in words — always populated, including for a pass. */
  reason: string;
}

/**
 * Grade a sample against an acceptance budget, the way a QA gate does.
 *
 * `unknown` is a first-class outcome and never collapses into `fail`: a sample
 * too small to support the chosen percentile has not failed the budget, it has
 * failed to test it, and a gate that conflates the two teaches people to ignore
 * it.
 */
export function gradeAgainstBudget(
  summary: ExtendedSummary,
  budgetMs: number | null,
  statistic: BudgetStatistic,
): BudgetResult {
  if (budgetMs === null || !Number.isFinite(budgetMs) || budgetMs <= 0) {
    return { verdict: 'unknown', value: null, headroomMs: null, reason: 'No acceptance budget set.' };
  }
  if (!summary.n) {
    return { verdict: 'unknown', value: null, headroomMs: null, reason: 'No timed runs.' };
  }
  const value = summary.percentiles[statistic] ?? null;
  if (value === null) {
    const needed = quantileMinSamples(Number(statistic.slice(1)) / 100);
    return {
      verdict: 'unknown',
      value: null,
      headroomMs: null,
      reason: `${statistic} needs ${needed} timed runs to mean anything; have ${summary.n}.`,
    };
  }
  const headroomMs = budgetMs - value;
  return {
    verdict: headroomMs >= 0 ? 'pass' : 'fail',
    value,
    headroomMs,
    reason:
      headroomMs >= 0
        ? `${statistic} of ${(value / 1000).toFixed(3)}s is inside the ${(budgetMs / 1000).toFixed(3)}s budget.`
        : `${statistic} of ${(value / 1000).toFixed(3)}s exceeds the ${(budgetMs / 1000).toFixed(3)}s budget by ${(-headroomMs / 1000).toFixed(3)}s.`,
  };
}

/** CV above this and the run-to-run scatter is large enough to mislead. */
export const NOISY_CV = 0.3;
/** Below this many timed runs, treat any comparison as indicative only. */
export const THIN_SAMPLE = 10;

export interface HealthNote {
  kind: 'thin' | 'noisy' | 'outliers' | 'drift' | 'errors';
  severity: 'warning' | 'info';
  detail: string;
}

/**
 * Whether a sample is fit to quote, in the words an operator needs to hear.
 *
 * Deliberately not a score. A single number would get read as a grade and
 * argued with; a list of specific defects tells someone what to re-run.
 */
export function sampleHealth(input: {
  summary: ExtendedSummary;
  errors: number;
  countsAgree: boolean;
}): HealthNote[] {
  const { summary, errors, countsAgree } = input;
  const notes: HealthNote[] = [];
  if (summary.n === 0) return notes;

  if (summary.n < THIN_SAMPLE) {
    notes.push({
      kind: 'thin',
      severity: 'warning',
      detail: `Only ${summary.n} timed ${summary.n === 1 ? 'run' : 'runs'}. Under ${THIN_SAMPLE} the median moves with a single run — treat this as indicative, not as a measurement.`,
    });
  }
  if (summary.cv !== null && summary.cv > NOISY_CV) {
    notes.push({
      kind: 'noisy',
      severity: 'warning',
      detail: `Run-to-run variability is ${(summary.cv * 100).toFixed(0)}%, above the ${NOISY_CV * 100}% threshold. Something outside the search is moving — other load on the engine, or cache state differing between runs.`,
    });
  }
  if (summary.outliers > 0) {
    const share = (summary.outliers / summary.n) * 100;
    notes.push({
      kind: 'outliers',
      severity: share > 10 ? 'warning' : 'info',
      detail: `${summary.outliers} of ${summary.n} runs fell outside the 1.5x IQR fences (${share.toFixed(0)}%). They are kept in every figure here — none of these statistics trim.`,
    });
  }
  if (!countsAgree) {
    notes.push({
      kind: 'drift',
      severity: 'warning',
      detail:
        'Runs of the same window matched different event counts, so the underlying data moved mid-session. The times are not measuring the same work and should not be compared.',
    });
  }
  if (errors > 0) {
    notes.push({
      kind: 'errors',
      severity: 'info',
      detail: `${errors} ${errors === 1 ? 'run' : 'runs'} failed and are excluded from every statistic. A failure rate this high can itself be the finding.`,
    });
  }
  return notes;
}

/**
 * Events matched per second of elapsed time — the throughput figure a capacity
 * conversation needs, since a size that halves the time on twice the data has
 * not been shown to scale by the latency column alone.
 */
export function throughputPerSec(events: number | null, ms: number | null): number | null {
  if (events === null || ms === null || ms <= 0) return null;
  return events / (ms / 1000);
}
