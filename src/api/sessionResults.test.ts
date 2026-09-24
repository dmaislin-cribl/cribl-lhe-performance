import { describe, expect, it } from 'vitest';
import type { RunRecord } from './appSettings';
import { expectedRuns, sessionCoverage, sessionResults } from './sessionResults';
import type { SessionRecord } from './sessions';

function run(overrides: Partial<RunRecord>): RunRecord {
  return {
    id: Math.random().toString(36).slice(2),
    jobId: 'job',
    engine: 'medium',
    window: 'T1',
    earliestSec: 1_790_164_800,
    latestSec: 1_790_168_400,
    totalMs: 1000,
    engineMs: 900,
    queueMs: 100,
    clientMs: 1100,
    totalEventCount: 42,
    status: 'Success',
    notes: '',
    measured: true,
    at: '2026-09-23T10:00:00.000Z',
    dataset: 'Fortinet_Syslog',
    queryHash: 'abc',
    searchGroup: 'default_search',
    searchId: 's-1',
    searchName: 'Test search',
    sessionId: 'run-1',
    sessionName: 'Fixture session',
    ...overrides,
  };
}

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'run-1',
    name: 'Fixture session',
    startedAt: '2026-09-23T10:00:00.000Z',
    endedAt: '2026-09-23T10:30:00.000Z',
    tier: 'medium',
    windowIds: ['T1'],
    searchNames: ['Test search'],
    repetitions: 4,
    notes: '',
    outcome: 'stopped',
    ...overrides,
  };
}

const ORDER = ['T1', 'T2', 'T3'];
const ENGINES = ['medium', 'large'];

describe('sessionResults', () => {
  it('summarises one cell per search × window × engine', () => {
    const cells = sessionResults(
      [
        run({ totalMs: 1000 }),
        run({ totalMs: 3000 }),
        run({ window: 'T2', totalMs: 8000 }),
        run({ engine: 'large', totalMs: 500 }),
      ],
      session(),
      ORDER,
      ENGINES,
    );
    expect(cells).toHaveLength(3);
    expect(cells[0]).toMatchObject({ windowId: 'T1', engine: 'medium', expected: 4 });
    // Nearest-rank, not interpolated: the median of two samples is the lower one.
    // Every statistic in the app is a value that was actually observed.
    expect(cells[0].total).toMatchObject({ n: 2, min: 1000, median: 1000, max: 3000 });
    // The engine is read off the run, never off the session's starting tier, so a
    // sweep does not average two sizes into one median.
    expect(cells.map((cell) => `${cell.windowId}/${cell.engine}`)).toEqual([
      'T1/medium',
      'T1/large',
      'T2/medium',
    ]);
  });

  it('ignores warm-ups and other sessions, and counts errors without timing them', () => {
    const cells = sessionResults(
      [
        run({ totalMs: 1000 }),
        run({ measured: false, totalMs: 99_000 }),
        run({ sessionId: 'other', totalMs: 99_000 }),
        run({ status: 'Error', totalMs: null }),
      ],
      session(),
      ORDER,
      ENGINES,
    );
    expect(cells).toHaveLength(1);
    expect(cells[0].total).toMatchObject({ n: 1, median: 1000 });
    expect(cells[0].errors).toBe(1);
  });

  it('withholds p95 on the thin sample a stopped session leaves behind', () => {
    const thin = sessionResults([run({}), run({})], session(), ORDER, ENGINES);
    expect(thin[0].total.p95).toBeNull();
    const full = sessionResults(
      Array.from({ length: 20 }, (_, index) => run({ totalMs: 1000 + index })),
      session({ repetitions: 20 }),
      ORDER,
      ENGINES,
    );
    expect(full[0].total.p95).not.toBeNull();
  });

  it('keeps a window the operator has since deleted, sorted after the known ones', () => {
    const cells = sessionResults(
      [run({ window: 'gone' }), run({ window: 'T1' })],
      session(),
      ORDER,
      ENGINES,
    );
    expect(cells.map((cell) => cell.windowId)).toEqual(['T1', 'gone']);
  });

  it('flags event counts that disagreed between repetitions', () => {
    const cells = sessionResults(
      [run({ totalEventCount: 42 }), run({ totalEventCount: 77 })],
      session(),
      ORDER,
      ENGINES,
    );
    expect(cells[0].consistent).toBe(false);
  });
});

describe('expectedRuns', () => {
  it('prefers the per-window count the session recorded', () => {
    const stopped = session({ repetitions: 20, windowRepetitions: { T8: 4 } });
    expect(expectedRuns(stopped, 'T8')).toBe(4);
    expect(expectedRuns(stopped, 'T1')).toBe(20);
  });

  it('is null when the session recorded no usable count, rather than guessing one', () => {
    expect(expectedRuns(session({ repetitions: 0 }), 'T1')).toBeNull();
  });
});

describe('sessionCoverage', () => {
  it('reports the shortfall a stopped session left', () => {
    const cells = sessionResults(
      [run({}), run({}), run({ window: 'T2' })],
      session({ repetitions: 4 }),
      ORDER,
      ENGINES,
    );
    expect(sessionCoverage(cells)).toEqual({ cells: 2, partial: 2, runs: 3, expected: 8 });
  });

  it('reports a complete session as having nothing partial', () => {
    const cells = sessionResults(
      [run({}), run({}), run({}), run({})],
      session({ repetitions: 4 }),
      ORDER,
      ENGINES,
    );
    expect(sessionCoverage(cells)).toMatchObject({ cells: 1, partial: 0, runs: 4, expected: 4 });
  });

  it('gives up on a total rather than inventing one when a count was unrecorded', () => {
    const cells = sessionResults([run({})], session({ repetitions: 0 }), ORDER, ENGINES);
    expect(sessionCoverage(cells).expected).toBeNull();
  });
});
