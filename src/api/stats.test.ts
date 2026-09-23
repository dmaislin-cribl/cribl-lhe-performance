import { describe, expect, it } from 'vitest';
import {
  P95_MIN_SAMPLES,
  countsAgree,
  formatSec,
  quantile,
  stdev,
  summarizeSamples,
} from './stats';

describe('quantile', () => {
  it('uses nearest rank', () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4, 5], 1)).toBe(5);
  });

  it('is order-independent', () => {
    expect(quantile([5, 1, 4, 2, 3], 0.5)).toBe(3);
  });

  it('returns null for an empty sample', () => {
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe('summarizeSamples', () => {
  // The original bug: nearest-rank p95 over 5 samples is ceil(0.95*5)-1 = 4,
  // i.e. always the last index. Reporting that as "p95" claims a tail estimate
  // the sample cannot support, so we withhold it instead.
  it('withholds p95 below the minimum sample size', () => {
    const summary = summarizeSamples([1, 2, 3, 4, 5]);
    expect(summary.p95).toBeNull();
    expect(summary.max).toBe(5);
  });

  it('reports p95 once there are enough samples', () => {
    const values = Array.from({ length: P95_MIN_SAMPLES }, (_, index) => index + 1);
    const summary = summarizeSamples(values);
    expect(summary.n).toBe(P95_MIN_SAMPLES);
    expect(summary.p95).toBe(19);
    expect(summary.max).toBe(20);
    // The point of the gate: at sufficient n, p95 is genuinely below max.
    expect(summary.p95).toBeLessThan(summary.max!);
  });

  it('summarises min, median, mean and max', () => {
    const summary = summarizeSamples([10, 20, 30]);
    expect(summary).toMatchObject({ n: 3, min: 10, median: 20, max: 30, mean: 20 });
  });

  it('reports cv as zero for identical samples and null for an empty set', () => {
    expect(summarizeSamples([5, 5, 5]).cv).toBe(0);
    expect(summarizeSamples([]).cv).toBeNull();
    expect(summarizeSamples([]).n).toBe(0);
  });
});

describe('stdev', () => {
  it('needs at least two samples', () => {
    expect(stdev([1])).toBeNull();
    expect(stdev([2, 4])).toBeCloseTo(1.4142, 3);
  });
});

describe('countsAgree', () => {
  it('accepts identical counts and a single known count', () => {
    expect(countsAgree([100, 100, 100])).toBe(true);
    expect(countsAgree([100, null, null])).toBe(true);
    expect(countsAgree([])).toBe(true);
  });

  it('rejects a spread, which means the data moved under the run', () => {
    expect(countsAgree([100, 101])).toBe(false);
  });

  it('ignores unknown counts when comparing', () => {
    expect(countsAgree([null, 7, null, 7])).toBe(true);
    expect(countsAgree([null, 7, null, 8])).toBe(false);
  });
});

describe('formatSec', () => {
  it('converts ms to seconds at 3 dp', () => {
    expect(formatSec(1097)).toBe('1.097');
  });

  it('renders an unknown measurement as an em dash', () => {
    expect(formatSec(null)).toBe('—');
  });
});
