/**
 * Sample statistics for benchmark results.
 *
 * The important rule here is that a statistic is only reported when the sample
 * size can support it. Nearest-rank p95 over 5 samples is arithmetically just
 * the maximum (ceil(0.95 * 5) - 1 = 4, the last index), so labelling it "p95"
 * overstates what was measured. `summarizeSamples` therefore returns p95 as
 * null below `P95_MIN_SAMPLES` and the UI shows why rather than printing a
 * number that means something else.
 */

/** Below this, a nearest-rank p95 is indistinguishable from max. */
export const P95_MIN_SAMPLES = 20;

export interface SampleSummary {
  n: number;
  min: number | null;
  median: number | null;
  max: number | null;
  mean: number | null;
  /** Null when n < P95_MIN_SAMPLES — see module note. */
  p95: number | null;
  /** Coefficient of variation (stdev / mean). High values mean noisy runs. */
  cv: number | null;
}

/** Nearest-rank quantile. `p` in [0, 1]. */
export function quantile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(p * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** Sample standard deviation (n-1). Null below two samples. */
export function stdev(values: number[]): number | null {
  if (values.length < 2) return null;
  const average = mean(values)!;
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function summarizeSamples(values: number[]): SampleSummary {
  const average = mean(values);
  const spread = stdev(values);
  return {
    n: values.length,
    min: quantile(values, 0),
    median: quantile(values, 0.5),
    max: values.length ? Math.max(...values) : null,
    mean: average,
    p95: values.length >= P95_MIN_SAMPLES ? quantile(values, 0.95) : null,
    cv: spread !== null && average ? spread / average : null,
  };
}

/**
 * Benchmark integrity check: every repetition of one window queries identical
 * absolute bounds, so the matching event count must be identical too. A spread
 * of counts means the underlying data moved and the timings are not comparable.
 */
export function countsAgree(counts: (number | null)[]): boolean {
  const known = counts.filter((value): value is number => typeof value === 'number');
  if (known.length < 2) return true;
  return known.every((value) => value === known[0]);
}

/** Milliseconds as seconds, to 3 dp. Null-safe, returns an em dash. */
export function formatSec(ms: number | null): string {
  return ms === null ? '—' : (ms / 1000).toFixed(3);
}
