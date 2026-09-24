import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_NAME,
  annotateSession,
  deleteSession,
  endSession,
  makeSession,
  normalizeSessions,
  renameSession,
  runsInSession,
  settleStale,
  suggestSessionName,
  summarizeSessions,
  uniqueSessionName,
  upsertSession,
  validateSessionName,
  type SessionRecord,
  type SessionRunLike,
} from './sessions';

const T0 = Date.parse('2026-09-23T10:00:00.000Z');

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    ...makeSession(
      { name: 'Baseline', tier: 'medium', windowIds: ['T1'], searchNames: ['Hostname scan'], repetitions: 5 },
      T0,
    ),
    id: 'run-1',
    ...overrides,
  };
}

function run(overrides: Partial<SessionRunLike> = {}): SessionRunLike {
  return { sessionId: 'run-1', measured: true, status: 'Success', ...overrides };
}

describe('suggestSessionName', () => {
  it('names the day, the tier and the scope, singular and plural', () => {
    expect(suggestSessionName({ tier: 'Medium', windowCount: 8, searchCount: 2 }, T0)).toBe(
      '2026-09-23 · Medium · 2 searches × 8 windows',
    );
    expect(suggestSessionName({ tier: 'Large', windowCount: 1, searchCount: 1 }, T0)).toBe(
      '2026-09-23 · Large · 1 search × 1 window',
    );
  });
});

describe('makeSession', () => {
  it('opens as running with no end time', () => {
    const made = session();
    expect(made.outcome).toBe('running');
    expect(made.endedAt).toBeNull();
    expect(made.startedAt).toBe('2026-09-23T10:00:00.000Z');
  });

  it('falls back rather than storing a nameless session', () => {
    expect(session({ ...makeSession({ name: '  ', tier: 'medium', windowIds: [], searchNames: [], repetitions: 0 }) }).name).toBe(
      'Unnamed session',
    );
  });

  it('truncates an over-long name at the documented cap', () => {
    const long = 'x'.repeat(MAX_SESSION_NAME + 40);
    const made = makeSession({ name: long, tier: 'medium', windowIds: [], searchNames: [], repetitions: 1 });
    expect(made.name).toHaveLength(MAX_SESSION_NAME);
  });
});

describe('normalizeSessions', () => {
  it('returns empty for anything that is not an array', () => {
    expect(normalizeSessions(null)).toEqual([]);
    expect(normalizeSessions({ id: 'x' })).toEqual([]);
  });

  it('drops entries with no id, since runs join on it', () => {
    expect(normalizeSessions([{ name: 'No id' }, { id: '', name: 'Blank' }])).toEqual([]);
  });

  it('de-duplicates by id, keeping the first', () => {
    const got = normalizeSessions([
      { id: 'a', name: 'First' },
      { id: 'a', name: 'Second' },
    ]);
    expect(got).toHaveLength(1);
    expect(got[0].name).toBe('First');
  });

  it('coerces missing and wrongly typed fields instead of propagating them', () => {
    const [got] = normalizeSessions([{ id: 'a', repetitions: 'ten', windowIds: ['T1', 7], outcome: 'weird' }]);
    expect(got.repetitions).toBe(0);
    expect(got.windowIds).toEqual(['T1']);
    // An unrecognised outcome reads as finished, never as still running.
    expect(got.outcome).toBe('complete');
    expect(got.notes).toBe('');
  });
});

describe('settleStale', () => {
  it('turns a session left running by a closed tab into a stopped one', () => {
    const settled = settleStale([session({ outcome: 'running' })], T0 + 60_000);
    expect(settled[0].outcome).toBe('stopped');
    expect(settled[0].endedAt).toBe('2026-09-23T10:01:00.000Z');
  });

  it('is identity when nothing is running, so a load does not rewrite the record', () => {
    const sessions = [session({ outcome: 'complete' })];
    expect(settleStale(sessions)).toBe(sessions);
  });
});

describe('upsertSession and endSession', () => {
  it('prepends a new session and replaces in place on update', () => {
    const first = session({ id: 'run-1' });
    const second = session({ id: 'run-2', name: 'Second' });
    const list = upsertSession([first], second);
    expect(list.map((entry) => entry.id)).toEqual(['run-2', 'run-1']);
    const edited = upsertSession(list, { ...second, name: 'Renamed' });
    expect(edited.map((entry) => entry.id)).toEqual(['run-2', 'run-1']);
    expect(edited[0].name).toBe('Renamed');
  });

  it('stamps the outcome and end time of the named session only', () => {
    const list = [session({ id: 'run-1', outcome: 'running' }), session({ id: 'run-2', outcome: 'running' })];
    const ended = endSession(list, 'run-1', 'stopped', T0 + 1000);
    expect(ended[0].outcome).toBe('stopped');
    expect(ended[0].endedAt).toBe('2026-09-23T10:00:01.000Z');
    expect(ended[1].outcome).toBe('running');
  });
});

describe('validateSessionName and uniqueSessionName', () => {
  const list = [session({ id: 'run-1', name: 'Baseline' })];

  it('requires a name and rejects a clash, case-insensitively', () => {
    expect(validateSessionName(list, '  ')).toMatch(/required/i);
    expect(validateSessionName(list, 'baseline')).toMatch(/already has that name/i);
    expect(validateSessionName(list, 'x'.repeat(MAX_SESSION_NAME + 1))).toMatch(/characters or fewer/i);
    expect(validateSessionName(list, 'After tuning')).toBeNull();
  });

  it('does not treat a session as clashing with itself', () => {
    expect(validateSessionName(list, 'Baseline', 'run-1')).toBeNull();
  });

  it('suffixes a taken name rather than producing two identical rows', () => {
    expect(uniqueSessionName(list, 'Baseline')).toBe('Baseline 2');
    expect(uniqueSessionName(list, 'Baseline', 'run-1')).toBe('Baseline');
    expect(uniqueSessionName(list, 'Fresh')).toBe('Fresh');
  });
});

describe('renameSession and annotateSession', () => {
  it('renames, ignoring a blank name', () => {
    const list = [session()];
    expect(renameSession(list, 'run-1', ' After tuning ')[0].name).toBe('After tuning');
    expect(renameSession(list, 'run-1', '   ')).toBe(list);
  });

  it('stores notes, including clearing them', () => {
    const list = annotateSession([session()], 'run-1', 'Cache cleared first');
    expect(list[0].notes).toBe('Cache cleared first');
    expect(annotateSession(list, 'run-1', '')[0].notes).toBe('');
  });
});

describe('runsInSession and deleteSession', () => {
  const log = {
    runs: [run({ sessionId: 'run-1' }), run({ sessionId: 'run-2' }), run({ sessionId: '' })],
    sessions: [session({ id: 'run-1' }), session({ id: 'run-2' })],
  };

  it('selects only the runs of one session', () => {
    expect(runsInSession(log.runs, 'run-1')).toHaveLength(1);
    expect(runsInSession(log.runs, 'nope')).toEqual([]);
  });

  it('keeps the measurements by default, so nothing loses its provenance', () => {
    const next = deleteSession(log, 'run-1', false);
    expect(next.sessions.map((entry) => entry.id)).toEqual(['run-2']);
    expect(next.runs).toHaveLength(3);
  });

  it('discards the measurements when asked, leaving no orphan rows', () => {
    const next = deleteSession(log, 'run-1', true);
    expect(next.runs.map((entry) => entry.sessionId)).toEqual(['run-2', '']);
  });
});

describe('summarizeSessions', () => {
  it('counts measured, total and failed runs per session', () => {
    const summaries = summarizeSessions({
      runs: [
        run({ sessionId: 'run-1' }),
        run({ sessionId: 'run-1', measured: false }),
        run({ sessionId: 'run-1', status: 'Error' }),
        run({ sessionId: 'run-2' }),
      ],
      sessions: [session({ id: 'run-1' }), session({ id: 'run-2' })],
    });
    const first = summaries.find((entry) => entry.id === 'run-1')!;
    expect(first.totalRuns).toBe(3);
    // A warm-up and a failure are both excluded from the measured count.
    expect(first.measuredRuns).toBe(1);
    expect(first.failedRuns).toBe(1);
  });

  it('reports zero counts for a session whose runs have aged out of the log', () => {
    const [only] = summarizeSessions({ runs: [], sessions: [session()] });
    expect(only.totalRuns).toBe(0);
    expect(only.measuredRuns).toBe(0);
  });

  it('orders newest first', () => {
    const summaries = summarizeSessions({
      runs: [],
      sessions: [
        session({ id: 'old', startedAt: '2026-09-01T00:00:00.000Z' }),
        session({ id: 'new', startedAt: '2026-09-20T00:00:00.000Z' }),
      ],
    });
    expect(summaries.map((entry) => entry.id)).toEqual(['new', 'old']);
  });
});
