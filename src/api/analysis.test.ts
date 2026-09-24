import { describe, expect, it } from 'vitest';
import type { RunRecord } from './appSettings';
import {
  type AnalysisScope,
  analysisOptions,
  analyzeByTier,
  defaultScope,
  scopeRuns,
} from './analysis';

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  const totalMs = overrides.totalMs !== undefined ? overrides.totalMs : 1000;
  return {
    id: Math.random().toString(36).slice(2),
    jobId: 'job',
    engine: 'medium',
    window: 'T1',
    earliestSec: 1_790_164_800,
    latestSec: 1_790_168_400,
    totalMs,
    engineMs: totalMs,
    queueMs: 0,
    clientMs: totalMs,
    totalEventCount: 1000,
    status: 'Success',
    notes: '',
    measured: true,
    at: '2026-09-23T10:00:00.000Z',
    dataset: 'ds',
    queryHash: 'abc',
    searchGroup: 'default_search',
    searchId: 's-1',
    searchName: 'Test search',
    sessionId: 'sess-1',
    sessionName: 'Fixture',
    ...overrides,
  };
}

/** `count` runs on one size, timings taken from `values`. */
function runsAt(engine: string, values: number[], overrides: Partial<RunRecord> = {}): RunRecord[] {
  return values.map((totalMs) => run({ engine, totalMs, ...overrides }));
}

const scope: AnalysisScope = {
  searchId: 's-1',
  windowId: 'T1',
  metric: 'total',
  baseline: 'medium',
  budgetMs: null,
  budgetStatistic: 'p95',
};

const twelve = (base: number) => Array.from({ length: 12 }, (_, index) => base + index);

describe('scopeRuns', () => {
  it('keeps only measured runs of one search and one window', () => {
    const runs = [
      run({ searchId: 's-1', window: 'T1' }),
      run({ searchId: 's-2', window: 'T1' }),
      run({ searchId: 's-1', window: 'T2' }),
      run({ searchId: 's-1', window: 'T1', measured: false }),
    ];
    expect(scopeRuns(runs, 's-1', 'T1')).toHaveLength(1);
  });

  it('buckets runs with no search id under one label rather than dropping them', () => {
    const runs = [run({ searchId: '' })];
    expect(scopeRuns(runs, '(unattributed)', 'T1')).toHaveLength(1);
  });
});

describe('analyzeByTier', () => {
  it('orders sizes smallest to largest', () => {
    const runs = [
      ...runsAt('2xlarge', [100]),
      ...runsAt('small', [900]),
      ...runsAt('medium', [500]),
    ];
    expect(analyzeByTier(runs, scope).map((row) => row.tier)).toEqual([
      'small',
      'medium',
      '2xlarge',
    ]);
  });

  it('always includes the baseline size, even with no runs on it', () => {
    const rows = analyzeByTier(runsAt('large', [100]), scope);
    const baseline = rows.find((row) => row.tier === 'medium');
    expect(baseline).toBeDefined();
    expect(baseline!.summary.n).toBe(0);
  });

  it('excludes failures from the statistics but counts them', () => {
    const runs = [
      ...runsAt('medium', [100, 200, 300]),
      run({ engine: 'medium', status: 'Error', totalMs: null }),
    ];
    const row = analyzeByTier(runs, scope).find((entry) => entry.tier === 'medium')!;
    expect(row.summary.n).toBe(3);
    expect(row.errors).toBe(1);
  });

  it('never compares a size to itself', () => {
    const rows = analyzeByTier(runsAt('medium', twelve(1000)), scope);
    expect(rows.find((row) => row.tier === 'medium')!.vsBaseline).toBeNull();
  });

  it('reports a faster size as a negative shift and a positive delta', () => {
    const runs = [...runsAt('medium', twelve(1000)), ...runsAt('large', twelve(400))];
    const large = analyzeByTier(runs, scope).find((row) => row.tier === 'large')!;
    expect(large.vsBaseline!.shiftMs).toBeLessThan(0);
    expect(large.vsBaseline!.delta).toBeGreaterThan(0);
    expect(large.vsBaseline!.effect).toBe('large');
    expect(large.vsBaseline!.test.usable).toBe(true);
    expect(large.vsBaseline!.test.p!).toBeLessThan(0.01);
  });

  it('reports a slower size as a positive shift', () => {
    const runs = [...runsAt('medium', twelve(400)), ...runsAt('large', twelve(1000))];
    const large = analyzeByTier(runs, scope).find((row) => row.tier === 'large')!;
    expect(large.vsBaseline!.shiftMs).toBeGreaterThan(0);
    expect(large.vsBaseline!.percent).toBeGreaterThan(0);
    expect(large.vsBaseline!.delta).toBeLessThan(0);
  });

  it('has no comparison when the baseline recorded nothing', () => {
    const rows = analyzeByTier(runsAt('large', twelve(400)), scope);
    expect(rows.find((row) => row.tier === 'large')!.vsBaseline).toBeNull();
  });

  it('reads the engine metric when asked, not the total', () => {
    const runs = runsAt('medium', [9999]).map((entry) => ({ ...entry, engineMs: 100 }));
    const row = analyzeByTier(runs, { ...scope, metric: 'engine' })!.find(
      (entry) => entry.tier === 'medium',
    )!;
    expect(row.summary.max).toBe(100);
  });

  it('folds an alias onto the size it names', () => {
    // A workspace reporting `xxlarge` must not appear as a size of its own.
    const rows = analyzeByTier(runsAt('xxlarge', [100]), scope);
    expect(rows.map((row) => row.tier)).toContain('2xlarge');
    expect(rows.map((row) => row.tier)).not.toContain('xxlarge');
  });

  it('applies the acceptance budget per size', () => {
    const runs = [...runsAt('medium', twelve(5000)), ...runsAt('large', twelve(100))];
    const rows = analyzeByTier(runs, { ...scope, budgetMs: 1000, budgetStatistic: 'p50' });
    expect(rows.find((row) => row.tier === 'medium')!.budget.verdict).toBe('fail');
    expect(rows.find((row) => row.tier === 'large')!.budget.verdict).toBe('pass');
  });

  it('surfaces data drift in the health notes', () => {
    const runs = [
      ...runsAt('medium', [100, 200], { totalEventCount: 10 }),
      ...runsAt('medium', [300], { totalEventCount: 999 }),
    ];
    const row = analyzeByTier(runs, scope).find((entry) => entry.tier === 'medium')!;
    expect(row.countsAgree).toBe(false);
    expect(row.health.map((note) => note.kind)).toContain('drift');
  });

  it('computes throughput from the median, not the fastest run', () => {
    const runs = runsAt('medium', [1000, 2000, 3000], { totalEventCount: 4000 });
    const row = analyzeByTier(runs, scope).find((entry) => entry.tier === 'medium')!;
    // Median is 2000 ms, so 4000 events is 2000/sec.
    expect(row.throughput).toBe(2000);
  });
});

describe('analysisOptions', () => {
  it('orders searches by how much data backs them', () => {
    const runs = [
      ...runsAt('medium', [1, 2], { searchId: 'quiet', searchName: 'Quiet' }),
      ...runsAt('medium', [1, 2, 3, 4], { searchId: 'busy', searchName: 'Busy' }),
    ];
    expect(analysisOptions(runs).searches.map((entry) => entry.id)).toEqual(['busy', 'quiet']);
  });

  it('keeps windows in their own sequence rather than by volume', () => {
    const runs = [
      ...runsAt('medium', [1], { window: 'T5' }),
      ...runsAt('medium', [1, 2, 3], { window: 'T2' }),
    ];
    expect(analysisOptions(runs).windows.map((entry) => entry.id)).toEqual(['T2', 'T5']);
  });

  it('ignores warm-ups', () => {
    expect(analysisOptions([run({ measured: false })]).searches).toEqual([]);
  });
});

describe('defaultScope', () => {
  it('picks the search and window pair with the most runs', () => {
    const runs = [
      ...runsAt('medium', [1], { searchId: 's-1', window: 'T1' }),
      ...runsAt('medium', [1, 2, 3], { searchId: 's-2', window: 'T4' }),
    ];
    expect(defaultScope(runs)).toEqual({ searchId: 's-2', windowId: 'T4' });
  });

  it('is null on an empty log so the caller can show its own empty state', () => {
    expect(defaultScope([])).toEqual({ searchId: null, windowId: null });
  });
});
