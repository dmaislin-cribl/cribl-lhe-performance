import { describe, expect, it } from 'vitest';
import { buildComparison, checkComparability, tiersWithData } from './compare';
import type { RunRecord } from './appSettings';
import { WINDOWS } from './windows';

const T1 = WINDOWS[0]; // 1 hour
const T2 = WINDOWS[1]; // 4 hours

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: Math.random().toString(36).slice(2),
    jobId: 'job',
    engine: 'medium',
    window: 'T1',
    earliestSec: 1_790_164_800,
    latestSec: 1_790_168_400,
    engineMs: 1000,
    queueMs: 100,
    clientMs: 1200,
    totalEventCount: 42,
    status: 'Success',
    notes: '',
    measured: true,
    at: '2026-09-23T10:00:00.000Z',
    dataset: 'Fortinet_Syslog',
    queryHash: 'abc',
    searchGroup: 'default_search',
    ...overrides,
  };
}

describe('buildComparison', () => {
  it('summarizes each tier/window pair independently', () => {
    const runs = [
      run({ engine: 'medium', window: 'T1', engineMs: 1000 }),
      run({ engine: 'medium', window: 'T1', engineMs: 2000 }),
      run({ engine: 'large', window: 'T1', engineMs: 500 }),
    ];
    const [row] = buildComparison(runs, [T1], ['medium', 'large'], 'medium');
    expect(row.cells.medium.stats.n).toBe(2);
    // Nearest rank over 2 samples: ceil(0.5 * 2) - 1 = index 0, the lower value.
    expect(row.cells.medium.stats.median).toBe(1000);
    expect(row.cells.large.stats.n).toBe(1);
  });

  it('reports speedup as baseline median over tier median', () => {
    const runs = [
      run({ engine: 'medium', engineMs: 4000 }),
      run({ engine: 'large', engineMs: 1000 }),
    ];
    const [row] = buildComparison(runs, [T1], ['medium', 'large'], 'medium');
    expect(row.cells.medium.speedup).toBe(1);
    expect(row.cells.large.speedup).toBe(4);
  });

  it('normalizes by window width so linear scaling reads flat', () => {
    const runs = [
      run({ window: 'T1', engineMs: 1000 }), // 1 hour
      run({ window: 'T2', engineMs: 4000 }), // 4 hours
    ];
    const rows = buildComparison(runs, [T1, T2], ['medium'], 'medium');
    expect(rows[0].cells.medium.msPerHour).toBe(1000);
    expect(rows[1].cells.medium.msPerHour).toBe(1000);
  });

  it('excludes warm-ups, failures and runs with no server timing', () => {
    const runs = [
      run({ measured: false, engineMs: 10 }),
      run({ status: 'Error', engineMs: null }),
      run({ engineMs: null }),
      run({ engineMs: 3000 }),
    ];
    const [row] = buildComparison(runs, [T1], ['medium'], 'medium');
    expect(row.cells.medium.stats.n).toBe(1);
    expect(row.cells.medium.stats.median).toBe(3000);
    // The failure is still counted as an error against the pair.
    expect(row.cells.medium.errors).toBe(1);
  });

  it('always emits a cell for every requested tier', () => {
    const [row] = buildComparison([], [T1], ['medium', '2xlarge'], 'medium');
    expect(row.cells['2xlarge'].stats.n).toBe(0);
    expect(row.cells['2xlarge'].speedup).toBeNull();
    expect(row.cells['2xlarge'].msPerHour).toBeNull();
  });

  it('flags a pair whose repetitions disagreed on the event count', () => {
    const runs = [run({ totalEventCount: 42 }), run({ totalEventCount: 43 })];
    const [row] = buildComparison(runs, [T1], ['medium'], 'medium');
    expect(row.cells.medium.consistent).toBe(false);
  });
});

describe('tiersWithData', () => {
  it('keeps the declared order and drops tiers with no usable measurement', () => {
    const runs = [
      run({ engine: '2xlarge' }),
      run({ engine: 'medium' }),
      run({ engine: 'large', status: 'Error', engineMs: null }),
    ];
    expect(tiersWithData(runs, ['medium', 'large', 'xlarge', '2xlarge'])).toEqual([
      'medium',
      '2xlarge',
    ]);
  });
});

describe('checkComparability', () => {
  const rowsFor = (runs: RunRecord[], tiers: string[]) =>
    buildComparison(runs, [T1], tiers, 'medium');

  it('is silent on a clean, complete set', () => {
    const runs = [run({}), run({})];
    expect(checkComparability(runs, rowsFor(runs, ['medium']), ['medium'], 2)).toEqual([]);
  });

  it('warns when the run log spans more than one query revision', () => {
    const runs = [run({ queryHash: 'abc' }), run({ queryHash: 'zzz' })];
    const kinds = checkComparability(runs, rowsFor(runs, ['medium']), ['medium'], 2).map(
      (warning) => warning.kind,
    );
    expect(kinds).toContain('query');
  });

  it('warns when runs span more than one dataset', () => {
    const runs = [run({ dataset: 'a' }), run({ dataset: 'b' })];
    const kinds = checkComparability(runs, rowsFor(runs, ['medium']), ['medium'], 2).map(
      (warning) => warning.kind,
    );
    expect(kinds).toContain('dataset');
  });

  it('warns about an incomplete sample set but not an empty one', () => {
    const partial = [run({})];
    expect(
      checkComparability(partial, rowsFor(partial, ['medium']), ['medium'], 20).map((w) => w.kind),
    ).toContain('partial');
    expect(checkComparability([], rowsFor([], ['medium']), ['medium'], 20)).toEqual([]);
  });
});
