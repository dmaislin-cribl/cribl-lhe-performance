import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  MAX_RUNS,
  hashQuery,
  normalizeConfig,
  pruneRunLog,
  repetitionsFor,
  type RunLog,
  type RunRecord,
} from './appSettings';
import { DEFAULT_WINDOWS, makeWindow } from './windows';

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r',
    jobId: 'j',
    engine: 'medium',
    window: 'T1',
    earliestSec: 0,
    latestSec: 3600,
    totalMs: 2,
    engineMs: 1,
    queueMs: 1,
    clientMs: 1,
    totalEventCount: 1,
    status: 'Success',
    notes: '',
    measured: true,
    at: '2026-09-23T10:00:00.000Z',
    dataset: 'd',
    queryHash: 'abc',
    searchGroup: 'default_search',
    searchId: 's-1',
    searchName: 'Test search',
    sessionId: 'run-1',
    sessionName: 'Fixture session',
    ...overrides,
  };
}

describe('hashQuery', () => {
  it('is stable and distinguishes revisions', () => {
    expect(hashQuery('a')).toBe(hashQuery('a'));
    expect(hashQuery('a')).not.toBe(hashQuery('b'));
    // Whitespace matters: a reformatted query is a different measurement subject.
    expect(hashQuery('a | b')).not.toBe(hashQuery('a |  b'));
  });

  it('is url/filename safe', () => {
    expect(hashQuery('dataset="x"\n| summarize count()')).toMatch(/^[0-9a-z]+$/);
  });
});

describe('normalizeConfig', () => {
  it('applies defaults to a null or empty record', () => {
    expect(normalizeConfig(null)).toEqual(DEFAULT_CONFIG);
    expect(normalizeConfig({})).toEqual(DEFAULT_CONFIG);
  });

  it('keeps stored values and fills only what is missing', () => {
    const config = normalizeConfig({ searchGroup: 'other_search' });
    expect(config.searchGroup).toBe('other_search');
    expect(config.repetitions).toBe(DEFAULT_CONFIG.repetitions);
  });

  it('clamps repetitions into a runnable range', () => {
    expect(normalizeConfig({ repetitions: 0 }).repetitions).toBe(DEFAULT_CONFIG.repetitions);
    expect(normalizeConfig({ repetitions: -5 }).repetitions).toBe(DEFAULT_CONFIG.repetitions);
    expect(normalizeConfig({ repetitions: 9999 }).repetitions).toBe(200);
    expect(normalizeConfig({ repetitions: 7.9 }).repetitions).toBe(7);
  });

  it('ignores a wrongly typed stored value instead of propagating it', () => {
    const stored = { searchGroup: 42, repetitions: 'ten' } as unknown as Record<string, unknown>;
    expect(normalizeConfig(stored)).toEqual(DEFAULT_CONFIG);
  });

  it('folds an alias in the stored sweep selection onto one size', () => {
    // Otherwise the sweep measures 2XLarge twice, with a resize between.
    expect(normalizeConfig({ sweepTiers: ['xxlarge', '2xlarge', 'medium'] }).sweepTiers).toEqual([
      '2xlarge',
      'medium',
    ]);
  });

  it('defaults the sweep selection to empty, meaning the engine size right now', () => {
    // Not a hardcoded size: an empty selection is how the workbench knows to follow
    // the live engine, so a fresh install measures the size the org actually runs.
    expect(DEFAULT_CONFIG.sweepTiers).toEqual([]);
    // And an explicitly cleared selection is kept cleared, not refilled.
    expect(normalizeConfig({ sweepTiers: [] }).sweepTiers).toEqual([]);
  });

  it('drops junk from the sweep selection without discarding the rest', () => {
    const stored = { sweepTiers: ['medium', '', null, 3] } as unknown as Record<string, unknown>;
    expect(normalizeConfig(stored).sweepTiers).toEqual(['medium']);
  });

  it('treats a non-positive budget as no budget rather than an impossible gate', () => {
    expect(normalizeConfig({ budgetMs: 0 }).budgetMs).toBeNull();
    expect(normalizeConfig({ budgetMs: -1 }).budgetMs).toBeNull();
    expect(normalizeConfig({ budgetMs: 2500 }).budgetMs).toBe(2500);
  });

  it('falls back on an unrecognised budget statistic', () => {
    const stored = { budgetStatistic: 'p42' } as unknown as Record<string, unknown>;
    expect(normalizeConfig(stored).budgetStatistic).toBe(DEFAULT_CONFIG.budgetStatistic);
    expect(normalizeConfig({ budgetStatistic: 'p99' }).budgetStatistic).toBe('p99');
  });

  it('keeps the good per-window repetition overrides and drops only the bad ones', () => {
    const stored = {
      repetitions: 20,
      windowRepetitions: { T1: 5, T2: 0, T3: 'many', T4: 999 },
    } as unknown as Record<string, unknown>;
    expect(normalizeConfig(stored).windowRepetitions).toEqual({ T1: 5, T4: 200 });
  });

  it('restores the default window set when none was stored or none is usable', () => {
    expect(normalizeConfig({}).windows).toEqual(DEFAULT_WINDOWS);
    expect(normalizeConfig({ windows: [] }).windows).toEqual(DEFAULT_WINDOWS);
  });

  it('keeps a stored custom window set', () => {
    const windows = [makeWindow('A', 30, 'day', 'day')];
    expect(normalizeConfig({ windows }).windows).toEqual(windows);
  });
});

describe('repetitionsFor', () => {
  it('uses the window override when there is one and the default otherwise', () => {
    const config = { ...DEFAULT_CONFIG, repetitions: 20, windowRepetitions: { T8: 4 } };
    expect(repetitionsFor(config, 'T8')).toBe(4);
    expect(repetitionsFor(config, 'T1')).toBe(20);
    // A window nothing knows about still gets a usable count rather than NaN.
    expect(repetitionsFor(config, 'nope')).toBe(20);
  });
});

describe('pruneRunLog', () => {
  it('caps the history, keeping the newest runs', () => {
    const log: RunLog = {
      runs: Array.from({ length: 5 }, (_, index) => run({ id: `r${index}` })),
      queries: { abc: 'q' },
      sessions: [],
    };
    const pruned = pruneRunLog(log, 3);
    expect(pruned.runs.map((entry) => entry.id)).toEqual(['r0', 'r1', 'r2']);
  });

  it('drops query text nothing references any more', () => {
    const log: RunLog = {
      runs: [run({ queryHash: 'keep' })],
      queries: { keep: 'still used', gone: 'orphaned' },
      sessions: [],
    };
    expect(pruneRunLog(log).queries).toEqual({ keep: 'still used' });
  });

  it('defaults to the documented cap', () => {
    const log: RunLog = {
      runs: Array.from({ length: MAX_RUNS + 10 }, () => run()),
      queries: {},
      sessions: [],
    };
    expect(pruneRunLog(log).runs).toHaveLength(MAX_RUNS);
  });
});
