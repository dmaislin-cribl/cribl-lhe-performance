/**
 * Saved run sessions: what was measured, when, on which engine size, and how it
 * ended — renameable, annotatable, exportable and deletable.
 *
 * This is the page an SE opens to answer "which of these numbers am I showing the
 * customer". The run log alone cannot answer it: it is a flat list where two runs
 * of the same search an hour apart, one either side of a config change, look
 * identical. A session is the unit that has a name.
 *
 * Writes go through the same `runs` KV record as the measurements (see
 * sessions.ts), so a rename and the runs it labels cannot end up in two states.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DEFAULT_CONFIG,
  EMPTY_RUN_LOG,
  loadConfig,
  loadRunLog,
  saveRunLog,
  type LabConfig,
  type RunLog,
} from '../api/appSettings';
import { copyToClipboard, provenanceBlock, runsToCsv } from '../api/exportResults';
import {
  MAX_SESSION_NAME,
  annotateSession,
  deleteSession,
  renameSession,
  runsInSession,
  summarizeSessions,
  validateSessionName,
  type SessionSummary,
} from '../api/sessions';
import { sessionCoverage, sessionResults } from '../api/sessionResults';
import { formatSec } from '../api/stats';
import { ENGINE_TIERS, describeTier, labelTier } from '../api/tiers';
import StatusBanner from '../components/StatusBanner';
import s from './SessionsPage.module.css';

const OUTCOME_LABEL: Record<string, string> = {
  running: 'Running',
  complete: 'Complete',
  stopped: 'Stopped',
  failed: 'Failed',
};

/** Local time, because a session is a thing that happened to the operator's day. */
function when(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? '—' : at.toLocaleString();
}

function duration(session: SessionSummary): string {
  if (!session.endedAt) return '—';
  const ms = Date.parse(session.endedAt) - Date.parse(session.startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Repetition count for the tile. A single number is only honest when every window
 * in the session got the same one; when they differ, the range is the truthful
 * answer and a lone number would misstate the sample behind half the table.
 */
function describeRepetitions(session: SessionSummary): string {
  const counts = Object.values(session.windowRepetitions ?? {});
  if (!counts.length) return `${session.repetitions}`;
  const low = Math.min(...counts);
  const high = Math.max(...counts);
  return low === high ? `${low}` : `${low}–${high}`;
}

export default function SessionsPage() {
  const [log, setLog] = useState<RunLog>(EMPTY_RUN_LOG);
  const [config, setConfig] = useState<LabConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);
  /**
   * Which session's results are expanded. Separate from `openId` (the rename and
   * notes editor) because reading the numbers and editing the label are different
   * jobs, and opening one should not close the other.
   */
  const [resultsId, setResultsId] = useState('');
  const [openId, setOpenId] = useState('');
  const [nameDraft, setNameDraft] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pendingDelete, setPendingDelete] = useState<SessionSummary | null>(null);
  const [alsoRuns, setAlsoRuns] = useState(false);

  useEffect(() => {
    void loadRunLog().then((stored) => {
      setLog(stored);
      setLoaded(true);
    });
    // Only for the window order the results table sorts by — this page never
    // writes config.
    void loadConfig().then(setConfig);
  }, []);

  const sessions = useMemo(() => summarizeSessions(log), [log]);
  /** Window ids in configured span order, for sorting the results table. */
  const windowOrder = useMemo(() => config.windows.map((def) => def.id), [config.windows]);
  const open = useMemo(() => sessions.find((entry) => entry.id === openId) ?? null, [sessions, openId]);

  /** Persist and adopt together, so the page can never show an unsaved log. */
  const commit = useCallback(async (next: RunLog, note: string) => {
    setLog(next);
    setError('');
    try {
      await saveRunLog(next);
      setMessage(note);
      window.setTimeout(() => setMessage(''), 2500);
    } catch (cause) {
      setError(
        `${cause instanceof Error ? cause.message : String(cause)} — the change is applied in this tab only.`,
      );
    }
  }, []);

  const startRename = useCallback((session: SessionSummary) => {
    setOpenId(session.id);
    setNameDraft(session.name);
    setError('');
  }, []);

  const saveName = useCallback(() => {
    if (!open) return;
    const reason = validateSessionName(log.sessions, nameDraft, open.id);
    if (reason) {
      setError(reason);
      return;
    }
    void commit(
      { ...log, sessions: renameSession(log.sessions, open.id, nameDraft) },
      `Renamed to “${nameDraft.trim()}”. The runs keep the name they were recorded under.`,
    );
  }, [open, log, nameDraft, commit]);

  const saveNotes = useCallback(
    (id: string, notes: string) => {
      void commit({ ...log, sessions: annotateSession(log.sessions, id, notes) }, 'Notes saved.');
    },
    [log, commit],
  );

  const confirmDelete = useCallback(() => {
    if (!pendingDelete) return;
    const next = deleteSession(log, pendingDelete.id, alsoRuns);
    const discarded = alsoRuns ? ` Its ${pendingDelete.totalRuns} runs were discarded.` : '';
    setPendingDelete(null);
    setAlsoRuns(false);
    if (openId === pendingDelete.id) setOpenId('');
    void commit(next, `Deleted “${pendingDelete.name}”.${discarded}`);
  }, [pendingDelete, alsoRuns, log, openId, commit]);

  const copySession = useCallback(
    async (session: SessionSummary) => {
      const runs = runsInSession(log.runs, session.id);
      const header = provenanceBlock(
        { ...log, runs },
        {
          session: session.name,
          'engine size': describeTier(session.tier),
          outcome: OUTCOME_LABEL[session.outcome] ?? session.outcome,
          started: session.startedAt,
          notes: session.notes || '(none)',
        },
      );
      const ok = await copyToClipboard(`${header}\n${runsToCsv(runs)}`);
      setMessage(
        ok
          ? `Copied ${runs.length} runs from “${session.name}” as CSV.`
          : 'The clipboard is unavailable here — try again after clicking the page.',
      );
      window.setTimeout(() => setMessage(''), 3500);
    },
    [log],
  );

  return (
    <div className={s.page}>
      <div className={s.head}>
        <div>
          <h1>Run sessions</h1>
          <p className={s.intro}>
            One session is one press of a run button: the selected searches × the chosen windows ×
            (one warm-up plus the timed repetitions), all on one engine size. Naming them is what
            makes a result citable — <b>“before index tuning”</b> against <b>“after”</b> rather than
            two timestamps. A session can be renamed long after it finished; a benchmark usually
            earns its name in hindsight.
          </p>
        </div>
        <Link className={s.back} to="/">
          Back to the workbench
        </Link>
      </div>

      {message && <StatusBanner kind="info">{message}</StatusBanner>}
      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      {loaded && !sessions.length && (
        <div className={s.empty}>
          <h2>No sessions recorded yet</h2>
          <p>
            Name a session in the workbench toolbar before you start a run and it appears here, with
            its runs attached. Runs recorded before sessions existed stay in the log and are
            reachable from the run table — they simply have no session to belong to.
          </p>
          <Link className={s.cta} to="/">
            Go to the workbench
          </Link>
        </div>
      )}

      {sessions.map((session) => {
        const isOpen = session.id === openId;
        const showResults = session.id === resultsId;
        // Computed per card only while it is expanded: a workspace can hold
        // hundreds of sessions and the run log is capped at 2000 runs, so
        // summarising every session on every render would be work nobody reads.
        const cells = showResults
          ? sessionResults(log.runs, session, windowOrder, ENGINE_TIERS)
          : [];
        const coverage = sessionCoverage(cells);
        return (
          <section className={s.card} key={session.id}>
            <div className={s.cardHead}>
              <div className={s.title}>
                <h2>{session.name}</h2>
                <span className={s.meta}>
                  {when(session.startedAt)} · {labelTier(session.tier)} · {duration(session)}
                </span>
              </div>
              <span className={`${s.badge} ${s[`badge_${session.outcome}`] ?? ''}`}>
                {OUTCOME_LABEL[session.outcome] ?? session.outcome}
              </span>
            </div>

            <div className={s.stats}>
              <div>
                <b>{session.measuredRuns}</b>
                <span>timed runs</span>
              </div>
              <div>
                <b>{session.totalRuns}</b>
                <span>runs recorded</span>
              </div>
              <div>
                <b className={session.failedRuns ? s.bad : ''}>{session.failedRuns}</b>
                <span>failed</span>
              </div>
              <div>
                <b>{describeRepetitions(session)}</b>
                <span>repetitions each</span>
              </div>
            </div>

            <dl className={s.detail}>
              <dt>Searches</dt>
              <dd>{session.searchNames.length ? session.searchNames.join(', ') : '—'}</dd>
              <dt>Windows</dt>
              <dd>{session.windowIds.length ? session.windowIds.join(', ') : '—'}</dd>
              <dt>Engine size</dt>
              <dd>{describeTier(session.tier)}</dd>
            </dl>

            {session.outcome === 'stopped' && (
              <p className={s.caution}>
                This session did not run its full matrix — it was stopped, or the tab was closed
                while it was going. Its numbers are real but the set is partial, so compare
                like-for-like before quoting it.{' '}
                {session.totalRuns > 0 && (
                  <>
                    Open <b>Results</b> below to see exactly which search, window and size got
                    measured and how deep each sample went.
                  </>
                )}
              </p>
            )}

            {session.totalRuns === 0 && (
              <p className={s.caution}>
                No runs are attached. Either the session recorded nothing, or its measurements have
                aged out of the capped run log.
              </p>
            )}

            <div className={s.actions}>
              <button
                className={s.primaryAction}
                onClick={() => setResultsId(showResults ? '' : session.id)}
                disabled={!session.totalRuns}
              >
                {showResults ? 'Hide results' : 'Results'}
              </button>
              <Link className={s.linkAction} to={`/analysis?session=${encodeURIComponent(session.id)}`}>
                Analyse
              </Link>
              <Link className={s.linkAction} to={`/compare?session=${encodeURIComponent(session.id)}`}>
                Compare sizes
              </Link>
              <button onClick={() => (isOpen ? setOpenId('') : startRename(session))}>
                {isOpen ? 'Close' : 'Rename & notes'}
              </button>
              <button onClick={() => void copySession(session)} disabled={!session.totalRuns}>
                Copy runs (CSV)
              </button>
              <button
                className={s.danger}
                onClick={() => {
                  setPendingDelete(session);
                  setAlsoRuns(false);
                }}
              >
                Delete
              </button>
            </div>

            {showResults && (
              <div className={s.results}>
                {cells.length === 0 ? (
                  <p className={s.caution}>
                    This session has runs in the log but no timed ones — every run was a warm-up, or
                    the timed runs have aged out of the capped log. Copy the CSV to see what is left.
                  </p>
                ) : (
                  <>
                    <p className={s.coverage}>
                      <b>{coverage.cells}</b> measured {coverage.cells === 1 ? 'cell' : 'cells'} ·{' '}
                      <b>{coverage.runs}</b>
                      {coverage.expected === null ? '' : ` of ${coverage.expected}`} timed runs
                      recorded
                      {coverage.partial > 0 && (
                        <>
                          {' '}
                          · <b className={s.bad}>{coverage.partial}</b>{' '}
                          {coverage.partial === 1 ? 'cell is' : 'cells are'} short of the repetitions
                          this session asked for
                        </>
                      )}
                      . Medians are nearest-rank over the successful timed runs only — warm-ups and
                      errors are excluded, never averaged in.
                    </p>
                    <div className={s.tableWrap}>
                      <table className={s.table}>
                        <thead>
                          <tr>
                            <th>Search</th>
                            <th>Window</th>
                            <th>Size</th>
                            <th className={s.num}>Runs</th>
                            <th className={s.num}>Median</th>
                            <th className={s.num}>Min</th>
                            <th className={s.num}>Max</th>
                            <th className={s.num}>p95</th>
                            <th className={s.num}>Engine</th>
                            <th className={s.num}>Queue</th>
                            <th className={s.num}>Events</th>
                          </tr>
                        </thead>
                        <tbody>
                          {cells.map((cell) => {
                            const done = cell.total.n + cell.errors;
                            const short = cell.expected !== null && done < cell.expected;
                            return (
                              <tr key={cell.key}>
                                <td>{cell.searchName}</td>
                                <td>{cell.windowId}</td>
                                <td>{labelTier(cell.engine)}</td>
                                <td className={`${s.num} ${short ? s.bad : ''}`}>
                                  {done}
                                  {cell.expected === null ? '' : `/${cell.expected}`}
                                  {cell.errors > 0 && (
                                    <span className={s.bad} title={`${cell.errors} failed`}>
                                      {' '}
                                      ✕{cell.errors}
                                    </span>
                                  )}
                                </td>
                                <td className={s.num}>{formatSec(cell.total.median)}</td>
                                <td className={s.num}>{formatSec(cell.total.min)}</td>
                                <td className={s.num}>{formatSec(cell.total.max)}</td>
                                {/*
                                  Blank, not a number, below the support floor: a
                                  nearest-rank p95 over a handful of samples is the
                                  maximum wearing a percentile's name, which is
                                  exactly the wrong thing to hand a customer from a
                                  session that was cut short.
                                */}
                                <td className={s.num} title={cell.total.p95 === null ? 'n too low' : ''}>
                                  {cell.total.p95 === null ? '—' : formatSec(cell.total.p95)}
                                </td>
                                <td className={s.num}>{formatSec(cell.engineMedian)}</td>
                                <td className={s.num}>{formatSec(cell.queueMedian)}</td>
                                <td className={s.num}>
                                  {cell.eventCount === null ? '—' : cell.eventCount.toLocaleString()}
                                  {!cell.consistent && (
                                    <span
                                      className={s.bad}
                                      title="Event counts disagreed between repetitions — the underlying data moved during the run."
                                    >
                                      {' '}
                                      ⚠
                                    </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <span className={s.hint}>
                      One row per search × window × engine size, because a median that pools two
                      sizes or two windows is arithmetically fine and physically meaningless. Times
                      are total — queue wait plus execution, as the server clocked it — with the
                      engine-only and queue medians beside them so a slow total can be attributed. A
                      red run count is a cell with fewer runs than this session asked for; ⚠ means
                      the event count changed between repetitions, so the data moved underneath the
                      measurement. For significance testing and size-over-size deltas, use{' '}
                      <b>Analyse</b>.
                    </span>
                  </>
                )}
              </div>
            )}

            {isOpen && (
              <div className={s.editor}>
                <label htmlFor={`name-${session.id}`}>Session name</label>
                <input
                  id={`name-${session.id}`}
                  className={s.field}
                  value={nameDraft}
                  maxLength={MAX_SESSION_NAME}
                  onChange={(event) => setNameDraft(event.target.value)}
                />
                <span className={s.hint}>
                  Renaming updates this record only. Runs keep the name they were recorded under, so
                  an export you already pasted somewhere stays truthful.
                </span>
                <button
                  className={s.save}
                  onClick={saveName}
                  disabled={nameDraft.trim() === session.name}
                >
                  Save name
                </button>

                <label htmlFor={`notes-${session.id}`}>Notes</label>
                <textarea
                  id={`notes-${session.id}`}
                  className={s.field}
                  rows={3}
                  defaultValue={session.notes}
                  onBlur={(event) => {
                    if (event.target.value !== session.notes) saveNotes(session.id, event.target.value);
                  }}
                />
                <span className={s.hint}>
                  What changed since the last session, and what this one is meant to prove. Included
                  in the CSV export header, so the reader gets the conditions with the numbers.
                </span>
              </div>
            )}
          </section>
        );
      })}

      {/*
        In-app dialog rather than window.confirm: a sandboxed iframe can suppress
        native modals, and a suppressed confirm() returns false — which would make
        Delete look like a dead button.
      */}
      {pendingDelete && (
        <div className={s.modalScrim} role="presentation" onClick={() => setPendingDelete(null)}>
          <div
            className={s.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-session-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-session-title">Delete “{pendingDelete.name}”?</h2>
            <p>
              By default only the session record goes. Its{' '}
              <b>{pendingDelete.totalRuns} recorded runs</b> stay in the run log, keeping the session
              name they were measured under, so nothing loses its provenance.
            </p>
            <label className={s.checkRow}>
              <input
                type="checkbox"
                checked={alsoRuns}
                onChange={(event) => setAlsoRuns(event.target.checked)}
              />
              <span>
                Also delete the {pendingDelete.totalRuns} runs. Do this when the session measured the
                wrong thing — leaving the runs behind would keep counting them toward engine-size
                progression and toward the comparison medians.
              </span>
            </label>
            <div className={s.modalActions}>
              <button onClick={() => setPendingDelete(null)}>Cancel</button>
              <button className={s.danger} onClick={confirmDelete}>
                {alsoRuns ? 'Delete session and runs' : 'Delete session'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
