import { describe, expect, it } from 'vitest';
import { P95_MIN_SAMPLES } from './stats';
import {
  MIN_COMPARE_SAMPLES,
  NOISY_CV,
  THIN_SAMPLE,
  cliffsDelta,
  extendedSummary,
  gradeAgainstBudget,
  hodgesLehmann,
  interpretDelta,
  iqr,
  mad,
  mannWhitney,
  medianInterval,
  normalSf,
  quantileMinSamples,
  sampleHealth,
  throughputPerSec,
  tukeyFences,
} from './perfStats';

/** n evenly spaced values, so percentile gating can be exercised at any size. */
function ramp(n: number, from = 1): number[] {
  return Array.from({ length: n }, (_, index) => from + index);
}

describe('quantileMinSamples', () => {
  it('matches the arithmetic in stats.ts for p95', () => {
    expect(quantileMinSamples(0.95)).toBe(P95_MIN_SAMPLES);
  });

  it('scales with the tail being asked for', () => {
    expect(quantileMinSamples(0.5)).toBe(2);
    expect(quantileMinSamples(0.9)).toBe(10);
    expect(quantileMinSamples(0.99)).toBe(100);
  });

  it('is the point at which nearest rank stops returning the maximum', () => {
    // One sample short of the threshold, p90 is still just the largest value.
    const short = ramp(9);
    const enough = ramp(10);
    expect(extendedSummary(short).percentiles.p90).toBeNull();
    expect(extendedSummary(enough).percentiles.p90).toBe(9);
    expect(Math.max(...enough)).toBe(10);
  });
});

describe('extendedSummary', () => {
  it('withholds percentiles the sample cannot support', () => {
    const summary = extendedSummary(ramp(20));
    expect(summary.percentiles.p50).not.toBeNull();
    expect(summary.percentiles.p90).not.toBeNull();
    expect(summary.percentiles.p95).not.toBeNull();
    // p99 needs 100 samples; below that it would just repeat the slowest run.
    expect(summary.percentiles.p99).toBeNull();
  });

  it('reports an empty sample without throwing', () => {
    const summary = extendedSummary([]);
    expect(summary).toMatchObject({ n: 0, min: null, max: null, mean: null, outliers: 0 });
    expect(summary.percentiles.p50).toBeNull();
  });

  it('counts outliers without removing them', () => {
    const values = [...Array(20).fill(100), 10_000] as number[];
    const summary = extendedSummary(values);
    expect(summary.n).toBe(21);
    expect(summary.outliers).toBe(1);
    // The freak run still sets the maximum — nothing here trims.
    expect(summary.max).toBe(10_000);
  });
});

describe('robust spread', () => {
  it('computes the interquartile range', () => {
    expect(iqr([1, 2, 3, 4])).toBe(2);
  });

  it('is unmoved by a single freak value, unlike stdev', () => {
    const clean = [...Array(20).fill(100)] as number[];
    const spiked = [...clean, 100_000];
    expect(mad(spiked)).toBe(mad(clean));
    expect(extendedSummary(spiked).stdev).toBeGreaterThan(extendedSummary(clean).stdev ?? 0);
  });

  it('places Tukey fences at 1.5x IQR', () => {
    const fences = tukeyFences([1, 2, 3, 4]);
    // Nearest rank puts q1 at 1 and q3 at 3, so IQR=2 and the fences sit 3 out.
    expect(fences.low).toBe(-2);
    expect(fences.high).toBe(6);
  });
});

describe('normalSf', () => {
  it('is the upper tail of the standard normal', () => {
    expect(normalSf(0)).toBeCloseTo(0.5, 6);
    expect(normalSf(1.96)).toBeCloseTo(0.025, 4);
    expect(normalSf(-1.96)).toBeCloseTo(0.975, 4);
  });
});

describe('mannWhitney', () => {
  it('computes U from the rank sum', () => {
    // Complete separation with the baseline lower: U for the baseline is 0.
    const result = mannWhitney([1, 2, 3], [4, 5, 6]);
    expect(result.u).toBe(0);
  });

  it('refuses to approximate a p-value on a thin sample', () => {
    const result = mannWhitney(ramp(4), ramp(4, 100));
    expect(result.usable).toBe(false);
    expect(result.p).toBeNull();
    expect(result.reason).toContain(String(MIN_COMPARE_SAMPLES));
  });

  it('finds a clearly separated pair significant', () => {
    const result = mannWhitney(ramp(12, 1000), ramp(12, 1));
    expect(result.usable).toBe(true);
    expect(result.p!).toBeLessThan(0.01);
  });

  it('does not find identical samples significant', () => {
    const sample = ramp(12);
    const result = mannWhitney(sample, [...sample]);
    expect(result.usable).toBe(true);
    expect(result.p!).toBeGreaterThan(0.9);
  });

  it('reports no variance rather than dividing by zero', () => {
    const flat = Array(10).fill(500) as number[];
    const result = mannWhitney(flat, [...flat]);
    expect(result.usable).toBe(false);
    expect(result.reason).toContain('identical');
  });

  it('handles ties without inflating significance', () => {
    // Half the values overlap exactly; the tie correction must keep p sane.
    const baseline = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
    const candidate = [1, 1, 2, 2, 3, 3, 4, 4, 5, 5];
    const result = mannWhitney(baseline, candidate);
    expect(result.p!).toBeGreaterThan(0.9);
  });
});

describe('effect size', () => {
  it('signs Cliffs delta so positive means the candidate was faster', () => {
    expect(cliffsDelta([10, 10, 10], [1, 1, 1])).toBe(1);
    expect(cliffsDelta([1, 1, 1], [10, 10, 10])).toBe(-1);
    expect(cliffsDelta([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('is null without both samples', () => {
    expect(cliffsDelta([], [1])).toBeNull();
  });

  it('bands the magnitude', () => {
    expect(interpretDelta(0.1)).toBe('negligible');
    expect(interpretDelta(0.2)).toBe('small');
    expect(interpretDelta(0.4)).toBe('medium');
    expect(interpretDelta(0.9)).toBe('large');
    // Direction does not change the magnitude band.
    expect(interpretDelta(-0.9)).toBe('large');
    expect(interpretDelta(null)).toBeNull();
  });

  it('signs the Hodges-Lehmann shift so negative means the candidate was faster', () => {
    expect(hodgesLehmann([10], [4])).toBe(-6);
    expect(hodgesLehmann([100, 100], [150, 150])).toBe(50);
  });
});

describe('medianInterval', () => {
  it('is withheld below six samples, where it would span everything', () => {
    expect(medianInterval(ramp(5))).toBeNull();
  });

  it('brackets the median', () => {
    const values = ramp(40);
    const interval = medianInterval(values)!;
    expect(interval.low).toBeLessThanOrEqual(20);
    expect(interval.high).toBeGreaterThanOrEqual(20);
    expect(interval.coverage).toBe(0.95);
  });

  it('narrows as the sample grows', () => {
    const small = medianInterval(ramp(20))!;
    const large = medianInterval(ramp(400))!;
    const relative = (i: { low: number; high: number }, n: number) => (i.high - i.low) / n;
    expect(relative(large, 400)).toBeLessThan(relative(small, 20));
  });
});

describe('gradeAgainstBudget', () => {
  it('passes inside the budget and fails outside it', () => {
    const summary = extendedSummary(ramp(20, 1000));
    const pass = gradeAgainstBudget(summary, 5000, 'p95');
    expect(pass.verdict).toBe('pass');
    expect(pass.headroomMs).toBeGreaterThan(0);
    expect(gradeAgainstBudget(summary, 100, 'p95').verdict).toBe('fail');
  });

  it('never turns an unmeasurable percentile into a failure', () => {
    // p99 off 20 runs is not available, so the budget was not tested.
    const result = gradeAgainstBudget(extendedSummary(ramp(20)), 5, 'p99');
    expect(result.verdict).toBe('unknown');
    expect(result.reason).toContain('100');
  });

  it('is unknown with no budget and with no runs', () => {
    expect(gradeAgainstBudget(extendedSummary(ramp(20)), null, 'p95').verdict).toBe('unknown');
    expect(gradeAgainstBudget(extendedSummary([]), 5000, 'p50').verdict).toBe('unknown');
  });

  it('explains a pass as well as a failure', () => {
    expect(gradeAgainstBudget(extendedSummary(ramp(20)), 5000, 'p50').reason).not.toBe('');
  });
});

describe('sampleHealth', () => {
  const clean = extendedSummary(Array(30).fill(1000) as number[]);

  it('says nothing about an empty sample', () => {
    expect(sampleHealth({ summary: extendedSummary([]), errors: 0, countsAgree: true })).toEqual([]);
  });

  it('flags a thin sample', () => {
    const notes = sampleHealth({
      summary: extendedSummary(ramp(THIN_SAMPLE - 1)),
      errors: 0,
      countsAgree: true,
    });
    expect(notes.map((note) => note.kind)).toContain('thin');
  });

  it('flags variability above the threshold', () => {
    const noisy = extendedSummary([100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 5000]);
    expect(noisy.cv!).toBeGreaterThan(NOISY_CV);
    const notes = sampleHealth({ summary: noisy, errors: 0, countsAgree: true });
    expect(notes.map((note) => note.kind)).toContain('noisy');
  });

  it('flags data drift as a warning', () => {
    const notes = sampleHealth({ summary: clean, errors: 0, countsAgree: false });
    const drift = notes.find((note) => note.kind === 'drift');
    expect(drift?.severity).toBe('warning');
  });

  it('is quiet on a clean sample', () => {
    expect(sampleHealth({ summary: clean, errors: 0, countsAgree: true })).toEqual([]);
  });
});

describe('throughputPerSec', () => {
  it('converts events and elapsed milliseconds into a rate', () => {
    expect(throughputPerSec(2000, 1000)).toBe(2000);
    expect(throughputPerSec(500, 2000)).toBe(250);
  });

  it('is null on missing or zero inputs', () => {
    expect(throughputPerSec(null, 1000)).toBeNull();
    expect(throughputPerSec(100, null)).toBeNull();
    expect(throughputPerSec(100, 0)).toBeNull();
  });
});
