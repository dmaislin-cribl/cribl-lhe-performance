import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  MAX_RUNS,
  hashQuery,
  normalizeConfig,
  pruneRunLog,
  type RunLog,
  type RunRecord,
} from './appSettings';

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
    const config = normalizeConfig({ dataset: 'other' });
    expect(config.dataset).toBe('other');
    expect(config.searchGroup).toBe(DEFAULT_CONFIG.searchGroup);
  });

  it('clamps repetitions into a runnable range', () => {
    expect(normalizeConfig({ repetitions: 0 }).repetitions).toBe(DEFAULT_CONFIG.repetitions);
    expect(normalizeConfig({ repetitions: -5 }).repetitions).toBe(DEFAULT_CONFIG.repetitions);
    expect(normalizeConfig({ repetitions: 9999 }).repetitions).toBe(200);
    expect(normalizeConfig({ repetitions: 7.9 }).repetitions).toBe(7);
  });

  it('ignores a wrongly typed stored value instead of propagating it', () => {
    const stored = { dataset: 42, repetitions: 'ten' } as unknown as Record<string, unknown>;
    expect(normalizeConfig(stored)).toEqual(DEFAULT_CONFIG);
  });
});

describe('pruneRunLog', () => {
  it('caps the history, keeping the newest runs', () => {
    const log: RunLog = {
      runs: Array.from({ length: 5 }, (_, index) => run({ id: `r${index}` })),
      queries: { abc: 'q' },
    };
    const pruned = pruneRunLog(log, 3);
    expect(pruned.runs.map((entry) => entry.id)).toEqual(['r0', 'r1', 'r2']);
  });

  it('drops query text nothing references any more', () => {
    const log: RunLog = {
      runs: [run({ queryHash: 'keep' })],
      queries: { keep: 'still used', gone: 'orphaned' },
    };
    expect(pruneRunLog(log).queries).toEqual({ keep: 'still used' });
  });

  it('defaults to the documented cap', () => {
    const log: RunLog = {
      runs: Array.from({ length: MAX_RUNS + 10 }, () => run()),
      queries: {},
    };
    expect(pruneRunLog(log).runs).toHaveLength(MAX_RUNS);
  });
});
