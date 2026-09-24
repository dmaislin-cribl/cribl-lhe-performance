/**
 * Named run sessions.
 *
 * A session is one press of a run button: the selected searches × the chosen
 * windows × (one warm-up + N repetitions), all on one engine tier. Before this
 * existed the run log was a flat list, and two runs of the same search an hour
 * apart — one before a config change, one after — were indistinguishable except
 * by reading timestamps. There was no way to say "these numbers are the ones I
 * showed the customer".
 *
 * So a session is a first-class, named, saved record. The name is the operator's
 * (`Before index tuning`, `Acme POV baseline`), suggested but always editable,
 * and it can be renamed long after the runs finished — a benchmark usually earns
 * its name in hindsight.
 *
 * Sessions live in the **same KV record as the runs** (`RunLog.sessions`) rather
 * than a key of their own. A run and the session it belongs to must not be able
 * to diverge: two keys mean two writes, and a failure between them would leave
 * runs pointing at a session that does not exist. One record, one write.
 *
 * Every run carries `sessionId` and the `sessionName` as it stood at the time.
 * Same discipline as saved searches: the id is a join key, the name is a label,
 * and neither is authoritative over the measurement itself.
 */

export const MAX_SESSION_NAME = 80;

/**
 * The parts of a run this module needs. Declared structurally rather than
 * imported from appSettings, which imports `SessionRecord` from here — a runtime
 * import cycle between the two would be fragile for no benefit. This keeps
 * sessions.ts a leaf.
 */
export interface SessionRunLike {
  sessionId: string;
  measured: boolean;
  status: 'Success' | 'Error';
}

/** The parts of the run log this module needs. */
export interface SessionLogLike<R extends SessionRunLike> {
  runs: R[];
  sessions: SessionRecord[];
}

/** How a session ended. `running` survives a reload mid-session — see `settleStale`. */
export type SessionOutcome = 'running' | 'complete' | 'stopped' | 'failed';

export interface SessionRecord {
  id: string;
  name: string;
  startedAt: string;
  endedAt: string | null;
  /** Engine tier the session ran on, as reported at start. */
  tier: string;
  /** Window ids this session covered, e.g. ["T1"] or all eight. */
  windowIds: string[];
  /** Names of the searches measured, captured at start. */
  searchNames: string[];
  /**
   * Default timed repetitions per search per window, excluding the warm-up. Kept
   * for records written before per-window counts existed.
   */
  repetitions: number;
  /**
   * Timed repetitions each window actually got, keyed by window id. Absent on
   * older records, where `repetitions` applied to every window.
   */
  windowRepetitions?: Record<string, number>;
  /** Operator notes: what changed since the last session, what this proves. */
  notes: string;
  outcome: SessionOutcome;
}

export function newSessionId(now = Date.now()): string {
  return `run-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * A suggested name, not an imposed one. Local date plus tier plus scope is the
 * minimum that distinguishes two sessions in a list; the operator renames it to
 * something meaningful when they know what the session turned out to show.
 */
export function suggestSessionName(
  fields: { tier: string; windowCount: number; searchCount: number },
  nowMs = Date.now(),
): string {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const scope = fields.windowCount === 1 ? '1 window' : `${fields.windowCount} windows`;
  const cases = fields.searchCount === 1 ? '1 search' : `${fields.searchCount} searches`;
  return `${day} · ${fields.tier} · ${cases} × ${scope}`;
}

export function makeSession(
  fields: {
    name: string;
    tier: string;
    windowIds: string[];
    searchNames: string[];
    repetitions: number;
    windowRepetitions?: Record<string, number>;
    notes?: string;
  },
  nowMs = Date.now(),
): SessionRecord {
  return {
    id: newSessionId(nowMs),
    name: fields.name.trim().slice(0, MAX_SESSION_NAME) || 'Unnamed session',
    startedAt: new Date(nowMs).toISOString(),
    endedAt: null,
    tier: fields.tier,
    windowIds: fields.windowIds,
    searchNames: fields.searchNames,
    repetitions: fields.repetitions,
    ...(fields.windowRepetitions ? { windowRepetitions: fields.windowRepetitions } : {}),
    notes: fields.notes ?? '',
    outcome: 'running',
  };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length ? value : fallback;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

const OUTCOMES: SessionOutcome[] = ['running', 'complete', 'stopped', 'failed'];

/** Coerce stored sessions, dropping anything without an id to join runs on. */
export function normalizeSessions(stored: unknown): SessionRecord[] {
  if (!Array.isArray(stored)) return [];
  const seen = new Set<string>();
  const sessions: SessionRecord[] = [];
  for (const entry of stored) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<SessionRecord>;
    const id = typeof candidate.id === 'string' && candidate.id ? candidate.id : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const startedAt = asString(candidate.startedAt, new Date(0).toISOString());
    sessions.push({
      id,
      name: asString(candidate.name, 'Unnamed session').slice(0, MAX_SESSION_NAME),
      startedAt,
      endedAt: typeof candidate.endedAt === 'string' ? candidate.endedAt : null,
      tier: asString(candidate.tier, 'unknown'),
      windowIds: asStringArray(candidate.windowIds),
      searchNames: asStringArray(candidate.searchNames),
      repetitions:
        typeof candidate.repetitions === 'number' && candidate.repetitions >= 0
          ? Math.floor(candidate.repetitions)
          : 0,
      ...(candidate.windowRepetitions && typeof candidate.windowRepetitions === 'object'
        ? {
            windowRepetitions: Object.fromEntries(
              Object.entries(candidate.windowRepetitions as Record<string, unknown>).flatMap(
                ([id, value]) =>
                  typeof value === 'number' && Number.isFinite(value) && value >= 0
                    ? [[id, Math.floor(value)] as const]
                    : [],
              ),
            ),
          }
        : {}),
      notes: typeof candidate.notes === 'string' ? candidate.notes : '',
      outcome: OUTCOMES.includes(candidate.outcome as SessionOutcome)
        ? (candidate.outcome as SessionOutcome)
        : 'complete',
    });
  }
  return sessions;
}

/**
 * Mark sessions left `running` as `stopped`.
 *
 * A session is set to `running` at start and settled at the end. Closing the tab
 * mid-matrix skips the settle, so on load a stale `running` would claim a
 * session is still going and let its partial numbers read as complete. Called
 * once on load, before any new session starts.
 */
export function settleStale(sessions: SessionRecord[], nowMs = Date.now()): SessionRecord[] {
  if (!sessions.some((entry) => entry.outcome === 'running')) return sessions;
  const now = new Date(nowMs).toISOString();
  return sessions.map((entry) =>
    entry.outcome === 'running'
      ? { ...entry, outcome: 'stopped' as SessionOutcome, endedAt: entry.endedAt ?? now }
      : entry,
  );
}

export function upsertSession(sessions: SessionRecord[], session: SessionRecord): SessionRecord[] {
  const index = sessions.findIndex((entry) => entry.id === session.id);
  if (index === -1) return [session, ...sessions];
  const next = sessions.slice();
  next[index] = session;
  return next;
}

/** Close a session out. Runs already recorded against it are untouched. */
export function endSession(
  sessions: SessionRecord[],
  id: string,
  outcome: Exclude<SessionOutcome, 'running'>,
  nowMs = Date.now(),
): SessionRecord[] {
  return sessions.map((entry) =>
    entry.id === id ? { ...entry, outcome, endedAt: new Date(nowMs).toISOString() } : entry,
  );
}

/** Reason a name cannot be used, or null. Distinct names keep a list of sessions readable. */
export function validateSessionName(
  sessions: SessionRecord[],
  name: string,
  excludeId?: string,
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'A session name is required.';
  if (trimmed.length > MAX_SESSION_NAME) return `Keep the name to ${MAX_SESSION_NAME} characters or fewer.`;
  const clash = sessions.some(
    (entry) => entry.id !== excludeId && entry.name.trim().toLowerCase() === trimmed.toLowerCase(),
  );
  return clash ? 'Another session already has that name.' : null;
}

/** `name`, `name 2`, … so a repeated suggestion never produces two identical rows. */
export function uniqueSessionName(
  sessions: SessionRecord[],
  wanted: string,
  excludeId?: string,
): string {
  const taken = new Set(
    sessions.filter((entry) => entry.id !== excludeId).map((entry) => entry.name.trim().toLowerCase()),
  );
  const base = wanted.trim().slice(0, MAX_SESSION_NAME) || 'Unnamed session';
  if (!taken.has(base.toLowerCase())) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

export function renameSession(
  sessions: SessionRecord[],
  id: string,
  name: string,
): SessionRecord[] {
  const trimmed = name.trim().slice(0, MAX_SESSION_NAME);
  if (!trimmed) return sessions;
  return sessions.map((entry) => (entry.id === id ? { ...entry, name: trimmed } : entry));
}

export function annotateSession(sessions: SessionRecord[], id: string, notes: string): SessionRecord[] {
  return sessions.map((entry) => (entry.id === id ? { ...entry, notes } : entry));
}

export function runsInSession<R extends SessionRunLike>(runs: R[], id: string): R[] {
  return runs.filter((run) => run.sessionId === id);
}

/**
 * Drop a session. `withRuns` also deletes its measurements — the honest way to
 * discard a session that measured the wrong thing, rather than leaving orphan
 * rows that still count toward tier progression. Without it the runs stay and
 * keep their `sessionName` label, so nothing silently loses its provenance.
 */
export function deleteSession<R extends SessionRunLike, L extends SessionLogLike<R>>(
  log: L,
  id: string,
  withRuns: boolean,
): L {
  const sessions = log.sessions.filter((entry) => entry.id !== id);
  const runs = withRuns ? log.runs.filter((run) => run.sessionId !== id) : log.runs;
  return { ...log, sessions, runs };
}

export interface SessionSummary extends SessionRecord {
  /** Timed, successful runs — what any statistic would be computed from. */
  measuredRuns: number;
  /** Every recorded run including warm-ups and failures. */
  totalRuns: number;
  failedRuns: number;
}

/** Sessions newest-first, each with its run counts derived from the log. */
export function summarizeSessions<R extends SessionRunLike>(
  log: SessionLogLike<R>,
): SessionSummary[] {
  const byId = new Map<string, { measured: number; total: number; failed: number }>();
  for (const run of log.runs) {
    if (!run.sessionId) continue;
    const bucket = byId.get(run.sessionId) ?? { measured: 0, total: 0, failed: 0 };
    bucket.total += 1;
    if (run.status === 'Error') bucket.failed += 1;
    else if (run.measured) bucket.measured += 1;
    byId.set(run.sessionId, bucket);
  }
  return log.sessions
    .map((session) => {
      const counts = byId.get(session.id) ?? { measured: 0, total: 0, failed: 0 };
      return {
        ...session,
        measuredRuns: counts.measured,
        totalRuns: counts.total,
        failedRuns: counts.failed,
      };
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
