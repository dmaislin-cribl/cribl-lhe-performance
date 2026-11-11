import { describe, expect, it } from 'vitest';
import type { RunRecord } from './appSettings';
import { checkComparability, buildComparison } from './compare';
import { pairCountMismatch, pairRuns } from './pairs';
import {
  counterpartOf,
  deleteSearch,
  makeSearch,
  normalizeLibrary,
  setCounterpart,
  type SearchLibrary,
} from './searches';
import { DEFAULT_WINDOWS } from './windows';

function run(fields: Partial<RunRecord>): RunRecord {
  return {
    id: Math.random().toString(36).slice(2),
    jobId: 'j',
    engine: 'medium',
    window: 'T1',
    earliestSec: 0,
    latestSec: 3600,
    totalMs: 1000,
    engineMs: 900,
    queueMs: 100,
    clientMs: 1100,
    totalEventCount: 24851,
    status: 'Success',
    notes: '',
    measured: true,
    at: '2026-11-11T00:00:00Z',
    dataset: 'criblcoffee_pos',
    queryHash: 'q1',
    searchGroup: 'default_search',
    searchId: 'lh',
    searchName: 'POS Lakehouse',
    sessionId: 's',
    sessionName: 'S',
    ...fields,
  };
}

const s3 = (fields: Partial<RunRecord> = {}) =>
  run({
    engine: 'federated',
    searchId: 's3',
    searchName: 'POS S3',
    dataset: 'criblcoffee_historical_pos',
    queryHash: 'q2',
    totalMs: 1100,
    ...fields,
  });

function library(): SearchLibrary {
  const a = { ...makeSearch({ name: 'A', text: 'dataset=a' }), id: 'a' };
  const b = { ...makeSearch({ name: 'B', text: 'dataset=b' }), id: 'b' };
  const c = { ...makeSearch({ name: 'C', text: 'dataset=c' }), id: 'c' };
  return { searches: [a, b, c], selectedIds: [] };
}

describe('setCounterpart', () => {
  it('pairs both ways', () => {
    const paired = setCounterpart(library(), 'a', 'b');
    expect(counterpartOf(paired, 'a')?.id).toBe('b');
    expect(counterpartOf(paired, 'b')?.id).toBe('a');
  });

  it('re-pairing leaves nobody pointing at a partner that points elsewhere', () => {
    const repaired = setCounterpart(setCounterpart(library(), 'a', 'b'), 'a', 'c');
    expect(counterpartOf(repaired, 'a')?.id).toBe('c');
    expect(counterpartOf(repaired, 'c')?.id).toBe('a');
    expect(counterpartOf(repaired, 'b')).toBeNull();
  });

  it('unpairs both ends, and refuses self- or unknown pairs', () => {
    const paired = setCounterpart(library(), 'a', 'b');
    const unpaired = setCounterpart(paired, 'b', '');
    expect(counterpartOf(unpaired, 'a')).toBeNull();
    expect(counterpartOf(unpaired, 'b')).toBeNull();
    expect(setCounterpart(paired, 'a', 'a')).toBe(paired);
    expect(setCounterpart(paired, 'a', 'zzz')).toBe(paired);
  });

  it('deleting one member unpairs the other', () => {
    const left = deleteSearch(setCounterpart(library(), 'a', 'b'), 'a');
    expect(left.searches.find((entry) => entry.id === 'b')?.counterpartId).toBeUndefined();
  });

  it('survives a save and reload, and drops one-sided links on load', () => {
    const paired = setCounterpart(library(), 'a', 'b');
    expect(counterpartOf(normalizeLibrary(JSON.parse(JSON.stringify(paired))), 'a')?.id).toBe('b');
    const oneSided = { ...library(), searches: library().searches.map((entry) =>
      entry.id === 'a' ? { ...entry, counterpartId: 'b' } : entry) };
    expect(normalizeLibrary(oneSided).searches.find((entry) => entry.id === 'a')?.counterpartId).toBeUndefined();
  });
});

describe('pairRuns', () => {
  it('gives the primary a counterpart column on targets it never ran on', () => {
    const runs = [run({}), run({}), s3(), s3(), run({ searchId: 'other', engine: 'federated' })];
    const { runs: out, overlaps } = pairRuns(runs, 'lh', 's3');
    const mine = out.filter((entry) => entry.searchId === 'lh');
    expect(mine.map((entry) => entry.engine).sort()).toEqual(['federated', 'federated', 'medium', 'medium']);
    // Other searches pass through untouched.
    expect(out.filter((entry) => entry.searchId === 'other')).toHaveLength(1);
    expect(overlaps).toEqual([]);
  });

  it('never pools both members on one target: keeps the better-measured one', () => {
    const runs = [run({ engine: 'federated' }), s3(), s3(), s3()];
    const { runs: out, overlaps } = pairRuns(runs, 'lh', 's3');
    const federated = out.filter((entry) => entry.searchId === 'lh' && entry.engine === 'federated');
    expect(federated).toHaveLength(3);
    expect(federated.every((entry) => entry.queryHash === 'q2')).toBe(true);
    expect(overlaps).toEqual([
      { target: 'federated', keptSearchName: 'POS S3', droppedSearchName: 'POS Lakehouse', droppedRuns: 1 },
    ]);
  });

  it('is the identity without a counterpart', () => {
    const runs = [run({}), s3()];
    expect(pairRuns(runs, 'lh', null).runs).toBe(runs);
  });
});

describe('pairCountMismatch', () => {
  it('flags copies of the data that matched different events', () => {
    const paired = pairRuns([run({}), s3({ totalEventCount: 20_000 })], 'lh', 's3').runs;
    expect(pairCountMismatch(paired, 'T1')).toEqual({ medium: 24851, federated: 20000 });
    const agree = pairRuns([run({}), s3()], 'lh', 's3').runs;
    expect(pairCountMismatch(agree, 'T1')).toBeNull();
  });
});

describe('checkComparability with a pair', () => {
  const windows = DEFAULT_WINDOWS.slice(0, 1);

  it('does not call a pair "mixed queries", and checks the copies agree instead', () => {
    const paired = pairRuns([run({}), s3({ totalEventCount: 1 })], 'lh', 's3');
    const scoped = paired.runs.filter((entry) => entry.searchId === 'lh');
    const tiers = ['medium', 'federated'];
    const rows = buildComparison(scoped, windows, tiers, 'medium');
    const kinds = checkComparability(scoped, rows, tiers, () => 1, {
      names: ['POS Lakehouse', 'POS S3'],
      overlaps: paired.overlaps,
    }).map((warning) => warning.kind);
    expect(kinds).toContain('pair');
    expect(kinds).toContain('pairCounts');
    expect(kinds).not.toContain('query');
    expect(kinds).not.toContain('dataset');
    // Unpaired, the same runs still raise the ordinary warnings.
    const plain = checkComparability(scoped, rows, tiers, () => 1).map((warning) => warning.kind);
    expect(plain).toContain('query');
  });
});
