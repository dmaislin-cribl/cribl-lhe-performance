import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiUrl } from './api/cribl';
import { PerfRunError, runTimedQuery } from './api/perfRun';
import { WINDOWS, formatBounds, resolveWindows, type WindowDef } from './api/windows';
import { P95_MIN_SAMPLES, countsAgree, formatSec, summarizeSamples } from './api/stats';
import {
  DEFAULT_CONFIG,
  EMPTY_RUN_LOG,
  hashQuery,
  loadConfig,
  loadRunLog,
  saveConfig,
  saveRunLog,
  type LabConfig,
  type RunLog,
  type RunRecord,
} from './api/appSettings';
import {
  deriveDataset,
  loadLibrary,
  selectedSearches,
  type SavedSearch,
  type SearchLibrary,
} from './api/searches';
import { BASELINE_TIER, ENGINE_TIERS, labelTier } from './api/tiers';
import s from './App.module.css';

interface Engine {
  id: string;
  tierSize: string;
  status: string;
  effectiveStatus?: string;
}

/** While an engine is mid-resize its status changes server-side with no event
 *  to observe, so poll until everything settles — then stop. */
const ENGINE_POLL_MS = 15_000;

function runId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Middle value of a sample set, or null. Used for the plain-language figures. */
function medianOf(values: (number | null)[]): number | null {
  return summarizeSamples(values.filter((value): value is number => typeof value === 'number')).median;
}

export default function App() {
  const [config, setConfig] = useState<LabConfig>(DEFAULT_CONFIG);
  const [library, setLibrary] = useState<SearchLibrary | null>(null);
  const [log, setLog] = useState<RunLog>(EMPTY_RUN_LOG);
  const [engines, setEngines] = useState<Engine[]>([]);
  const [engineId, setEngineId] = useState('');
  const [selectedWindow, setSelectedWindow] = useState('T1');
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [pendingResize, setPendingResize] = useState<string | null>(null);
  const [pendingClear, setPendingClear] = useState(false);
  const [previewAnchor, setPreviewAnchor] = useState(0);
  const [refreshingEngines, setRefreshingEngines] = useState(false);
  /**
   * The results table answers "how long did each search take" by default. The
   * distribution columns (p95, CV, spread) are real but they are not what most
   * operators came for, and a table that leads with them reads as noise.
   */
  const [advanced, setAdvanced] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const configSaveTimer = useRef<number | undefined>(undefined);

  const runs = log.runs;
  const engine = engines.find((item) => item.id === engineId) ?? null;
  const activeTier = engine?.tierSize ?? BASELINE_TIER;
  const searchGroup = config.searchGroup;
  const chosen = useMemo(() => (library ? selectedSearches(library) : []), [library]);

  useEffect(() => {
    void loadConfig().then(setConfig);
    void loadRunLog().then(setLog);
    void loadLibrary().then(setLibrary);
  }, []);

  /**
   * Engine inventory. Also the only way to see a resize land: the control plane
   * reports `resizing` -> `ready` with nothing to subscribe to, so this is
   * called on demand and on an interval while anything is unsettled.
   */
  const refreshEngines = useCallback(
    async (signal?: AbortSignal) => {
      setRefreshingEngines(true);
      try {
        const response = await fetch(
          `${apiUrl().replace(/\/$/, '')}/m/${encodeURIComponent(searchGroup)}/search/local_search/engines?offset=0&limit=50`,
          { signal },
        );
        if (!response.ok) throw new Error(`Engine inventory failed (${response.status})`);
        const body = (await response.json()) as { items?: Engine[] };
        const items = body.items ?? [];
        setEngines(items);
        // Keep the operator's selection across refreshes; only pick on first load.
        setEngineId((current) => {
          if (current && items.some((item) => item.id === current)) return current;
          const ready = items.find((item) => item.status === 'ready');
          return (ready ?? items[0])?.id ?? '';
        });
        if (!items.length) setMessage('No Lakehouse engines are visible in this workspace.');
      } catch (cause) {
        if (signal?.aborted) return;
        setMessage(
          `Engine inventory is unavailable (${cause instanceof Error ? cause.message : String(cause)}). Runs are still recorded, but the tier label may be wrong.`,
        );
      } finally {
        setRefreshingEngines(false);
      }
    },
    [searchGroup],
  );

  // Aborts on unmount so a slow response cannot resolve into an unmounted
  // component, and refetches if the operator changes the search group.
  useEffect(() => {
    const controller = new AbortController();
    void refreshEngines(controller.signal);
    return () => controller.abort();
  }, [refreshEngines]);

  // Poll only while something is unsettled — a steady Ready engine needs no traffic.
  const settling = engines.some((item) => item.status !== 'ready');
  useEffect(() => {
    if (!settling || running) return;
    const controller = new AbortController();
    const timer = window.setInterval(() => void refreshEngines(controller.signal), ENGINE_POLL_MS);
    return () => {
      window.clearInterval(timer);
      controller.abort();
    };
  }, [settling, running, refreshEngines]);

  // Abort any in-flight run if the user navigates away mid-matrix.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Keep the previewed bounds roughly current without reading the clock during
  // render. Ticks a little inside the hour so a boundary crossing shows up.
  useEffect(() => {
    setPreviewAnchor(Date.now());
    const timer = window.setInterval(() => setPreviewAnchor(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  /**
   * Config edits update local state immediately and persist on a trailing
   * debounce — previously each keystroke wrote the whole blob to the KV store.
   */
  const updateConfig = useCallback((patch: Partial<LabConfig>) => {
    setConfig((current) => {
      const next = { ...current, ...patch };
      window.clearTimeout(configSaveTimer.current);
      configSaveTimer.current = window.setTimeout(() => void saveConfig(next), 600);
      return next;
    });
  }, []);

  /**
   * Append a run and, the first time a query revision is seen, store its full
   * text under the hash the run references. Without that the run log would hold
   * timings produced by a query that is no longer on screen.
   */
  const appendRun = useCallback((record: RunRecord, queryText: string) => {
    setLog((current) => {
      const next: RunLog = {
        runs: [record, ...current.runs],
        queries: current.queries[record.queryHash]
          ? current.queries
          : { ...current.queries, [record.queryHash]: queryText },
      };
      void saveRunLog(next);
      return next;
    });
  }, []);

  const clearHistory = useCallback(() => {
    setPendingClear(false);
    setLog(EMPTY_RUN_LOG);
    void saveRunLog(EMPTY_RUN_LOG);
    setMessage('Run history cleared. Saved searches and configuration are unchanged.');
  }, []);

  /** One search. Records the outcome either way — a failure is data too. */
  const runOnce = useCallback(
    async (
      search: SavedSearch,
      window: ReturnType<typeof resolveWindows>[number],
      measured: boolean,
      tier: string,
      signal: AbortSignal,
    ) => {
      const started = performance.now();
      const query = search.text.trim();
      const base: Omit<
        RunRecord,
        'totalMs' | 'engineMs' | 'queueMs' | 'totalEventCount' | 'status' | 'notes' | 'jobId'
      > = {
        id: runId(),
        engine: tier,
        window: window.id,
        earliestSec: window.earliestSec,
        latestSec: window.latestSec,
        clientMs: null,
        measured,
        at: new Date().toISOString(),
        dataset: deriveDataset(query),
        queryHash: hashQuery(query),
        searchGroup: config.searchGroup,
        searchId: search.id,
        searchName: search.name,
      };
      try {
        const result = await runTimedQuery(query, {
          earliestSec: window.earliestSec,
          latestSec: window.latestSec,
          searchGroup: config.searchGroup,
          signal,
        });
        appendRun(
          {
            ...base,
            jobId: result.jobId,
            totalMs: result.totalMs,
            engineMs: result.engineMs,
            queueMs: result.queueMs,
            clientMs: Math.round(result.clientMs),
            totalEventCount: result.totalEventCount,
            status: 'Success',
            notes: measured ? '' : 'Warm-up',
          },
          query,
        );
      } catch (cause) {
        if (signal.aborted) throw cause;
        appendRun(
          {
            ...base,
            jobId: cause instanceof PerfRunError ? (cause.jobId ?? '') : '',
            totalMs: null,
            engineMs: null,
            queueMs: null,
            clientMs: Math.round(performance.now() - started),
            totalEventCount: null,
            status: 'Error',
            notes: cause instanceof Error ? cause.message : String(cause),
          },
          query,
        );
      }
    },
    [appendRun, config.searchGroup],
  );

  /**
   * Run a set of windows for every selected search. Bounds are resolved ONCE
   * against a single anchor so that every repetition — and every window, and
   * every search — measures identical data even if the session straddles an hour
   * or day boundary.
   */
  const runSession = useCallback(
    async (defs: WindowDef[]) => {
      if (!chosen.length) return;
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setError('');
      setMessage('');
      const tier = activeTier;
      const resolved = resolveWindows(defs, Date.now());
      const perSearch = resolved.length * (config.repetitions + 1);
      try {
        let done = 0;
        for (const search of chosen) {
          for (const window of resolved) {
            setProgress(
              `${search.name} · ${window.id} on ${labelTier(tier)} · warm-up (${done}/${perSearch * chosen.length} searches run)`,
            );
            await runOnce(search, window, false, tier, controller.signal);
            done += 1;
            for (let repetition = 0; repetition < config.repetitions; repetition += 1) {
              setProgress(
                `${search.name} · ${window.id} on ${labelTier(tier)} · run ${repetition + 1} of ${config.repetitions} (${done}/${perSearch * chosen.length} total)`,
              );
              await runOnce(search, window, true, tier, controller.signal);
              done += 1;
            }
          }
        }
        setMessage(
          `Done: ${chosen.length} ${chosen.length === 1 ? 'search' : 'searches'} × ${resolved.length} ${resolved.length === 1 ? 'window' : 'windows'} on ${labelTier(tier)}.`,
        );
      } catch (cause) {
        if (controller.signal.aborted) {
          setMessage('Run stopped. Completed runs are kept; incomplete sets are flagged.');
        } else {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        setProgress('');
        setRunning(false);
        abortRef.current = null;
      }
    },
    [activeTier, chosen, config.repetitions, runOnce],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const applyResize = useCallback(
    async (tierSize: string) => {
      setPendingResize(null);
      if (!engine) return;
      try {
        const response = await fetch(
          `${apiUrl().replace(/\/$/, '')}/m/${encodeURIComponent(searchGroup)}/search/local_search/engines/${encodeURIComponent(engine.id)}`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: engine.id, engineType: 'local', tierSize }),
          },
        );
        if (!response.ok) throw new Error(`Resize request failed (${response.status})`);
        setEngines((current) =>
          current.map((item) =>
            item.id === engine.id ? { ...item, tierSize, status: 'resizing' } : item,
          ),
        );
        setError('');
        setMessage(
          `Resize to ${labelTier(tierSize)} requested. Engine status refreshes automatically until it reports Ready — do not start its matrix before then.`,
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [engine, searchGroup],
  );

  const measured = useMemo(
    () => runs.filter((run) => run.measured && run.engine === activeTier),
    [runs, activeTier],
  );

  /**
   * One row per selected search per window, on the active tier. Leads with the
   * end-to-end time the server reported, split into queue and engine so a slow
   * result can be attributed without needing the distribution columns.
   */
  const summary = useMemo(() => {
    return chosen.flatMap((search) =>
      WINDOWS.map((def) => {
        const forRow = measured.filter((run) => run.searchId === search.id && run.window === def.id);
        const ok = forRow.filter((run) => run.status === 'Success');
        const totals = ok
          .map((run) => run.totalMs)
          .filter((value): value is number => typeof value === 'number');
        const counts = ok.map((run) => run.totalEventCount);
        const bounds = ok[0] ?? forRow[0];
        return {
          key: `${search.id}:${def.id}`,
          search,
          def,
          total: summarizeSamples(totals),
          engineMedian: medianOf(ok.map((run) => run.engineMs)),
          queueMedian: medianOf(ok.map((run) => run.queueMs)),
          errors: forRow.length - ok.length,
          consistent: countsAgree(counts),
          eventCount: counts.find((value) => typeof value === 'number') ?? null,
          bounds: bounds
            ? formatBounds({
                ...def,
                earliestSec: bounds.earliestSec,
                latestSec: bounds.latestSec,
                earliestIso: new Date(bounds.earliestSec * 1000).toISOString(),
                latestIso: new Date(bounds.latestSec * 1000).toISOString(),
              })
            : '—',
        };
      }),
    );
  }, [chosen, measured]);

  const target = WINDOWS.length * config.repetitions;

  /**
   * Successful measured runs only. Counting attempts would let a tier of
   * consecutive failures unlock the larger — and more expensive — tiers.
   */
  const completedFor = useCallback(
    (tier: string) =>
      runs.filter(
        (run) =>
          run.engine === tier &&
          run.measured &&
          run.status === 'Success' &&
          typeof run.totalMs === 'number',
      ).length,
    [runs],
  );

  const baselineDone = completedFor(BASELINE_TIER) >= target;
  const selectedDef = WINDOWS.find((def) => def.id === selectedWindow) ?? WINDOWS[0];

  // Preview-only anchor, kept in state so render stays pure. A run resolves
  // its own anchor at start time; this just shows what the bounds would be.
  const previewBounds = useMemo(
    () => (previewAnchor ? formatBounds(resolveWindows([selectedDef], previewAnchor)[0]) : '—'),
    [selectedDef, previewAnchor],
  );

  const plannedRuns = chosen.length * (config.repetitions + 1);

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <div className={s.eyebrow}>
            SEARCH / PERFORMANCE LAB
            <span className={s.version} title={`app id: ${__APP_ID__}`}>
              v{__APP_VERSION__}
            </span>
          </div>
          <h1>{__APP_DISPLAY_NAME__}</h1>
          <p>
            Measures <b>how long each search takes, start to finish</b>, using the server&rsquo;s own
            clock rather than a browser stopwatch. Each time is split into waiting in the queue and
            running on the engine. Every search runs several times so a single slow run cannot be
            mistaken for the real figure.
          </p>
        </div>
        <div className={s.engineBadge}>
          <span className={`${s.dot} ${engine?.status === 'ready' ? s.ready : ''}`} />
          {engine ? `${labelTier(engine.tierSize)} · ${engine.status}` : 'No engine selected'}
          <button
            className={s.refresh}
            onClick={() => void refreshEngines()}
            disabled={refreshingEngines}
            title="Re-read engine status from the control plane"
          >
            {refreshingEngines ? 'Checking…' : 'Refresh'}
          </button>
        </div>
      </header>

      {progress && <div className={s.notice}>{progress}</div>}
      {message && <div className={s.notice}>{message}</div>}
      {error && <div className={s.error}>{error}</div>}

      <section className={s.toolbar}>
        <div>
          <label htmlFor="window">Time window</label>
          <select
            id="window"
            value={selectedWindow}
            onChange={(event) => setSelectedWindow(event.target.value)}
            disabled={running}
          >
            {WINDOWS.map((def) => (
              <option key={def.id} value={def.id}>
                {def.id} · {def.label}
              </option>
            ))}
          </select>
        </div>
        {engines.length > 1 && (
          <div>
            <label htmlFor="engine">Engine</label>
            <select
              id="engine"
              value={engineId}
              onChange={(event) => setEngineId(event.target.value)}
              disabled={running}
            >
              {engines.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.id} · {labelTier(item.tierSize)} · {item.status}
                </option>
              ))}
            </select>
          </div>
        )}
        <button
          className={s.primary}
          onClick={() => void runSession([selectedDef])}
          disabled={running || !chosen.length}
        >
          {running ? 'Running…' : `Time ${chosen.length} ${chosen.length === 1 ? 'search' : 'searches'}`}
        </button>
        <button
          className={s.secondary}
          onClick={() => void runSession(WINDOWS)}
          disabled={running || !chosen.length}
        >
          All {WINDOWS.length} windows
        </button>
        {running && (
          <button onClick={stop} className={s.stop}>
            Stop
          </button>
        )}
        <Link className={s.linkButton} to="/searches">
          Manage searches
        </Link>
        <Link className={s.linkButtonPlain} to="/compare">
          Compare tiers
        </Link>
      </section>

      <div className={s.grid}>
        <section className={s.card}>
          <div className={s.cardHeader}>
            <div>
              <h2>Searches being timed</h2>
              <span className={s.muted}>
                {plannedRuns} searches per window ({config.repetitions} timed runs plus one warm-up
                each)
              </span>
            </div>
            <Link className={s.tagLink} to="/searches">
              Edit
            </Link>
          </div>

          {!library && <p className={s.muted}>Loading saved searches…</p>}
          {library &&
            chosen.map((search) => (
              <div className={s.searchItem} key={search.id}>
                <div className={s.searchName}>
                  <b>{search.name}</b>
                  <span className={s.muted}>{deriveDataset(search.text) || 'no dataset term'}</span>
                </div>
                <pre className={s.searchText}>{search.text}</pre>
              </div>
            ))}

          <div className={s.boundsNote}>
            <b>{selectedDef.id}</b> bounds if started now: <span className={s.mono}>{previewBounds}</span>
            <span className={s.muted}>
              Resolved to fixed timestamps when a session starts, so every run — and every search —
              covers exactly the same data.
            </span>
          </div>

          <label htmlFor="dataset">Default dataset for new searches</label>
          <input
            id="dataset"
            value={config.dataset}
            onChange={(event) => updateConfig({ dataset: event.target.value })}
            disabled={running}
          />
        </section>

        <section className={s.card}>
          <div className={s.cardHeader}>
            <div>
              <h2>Engine progression</h2>
              <span className={s.muted}>Start at Medium; advance only after completion</span>
            </div>
            <span className={`${s.tag} ${baselineDone ? s.tagGood : ''}`}>
              {baselineDone ? 'Medium complete' : 'Medium active'}
            </span>
          </div>

          <div className={s.progress}>
            <div style={{ width: `${Math.min(100, (completedFor(BASELINE_TIER) / target) * 100)}%` }} />
          </div>

          <div className={s.tierList}>
            {ENGINE_TIERS.map((tier, index) => (
              <div className={s.tier} key={tier}>
                <span className={tier === activeTier ? s.current : ''}>{index + 1}</span>
                <strong>{labelTier(tier)}</strong>
                <small>
                  {tier === activeTier
                    ? `${engine?.status ?? 'active'} · ${completedFor(tier)}/${target} timed`
                    : completedFor(tier)
                      ? `${completedFor(tier)}/${target} timed`
                      : tier === BASELINE_TIER || baselineDone
                        ? 'Available after resize'
                        : 'Locked until Medium completes'}
                </small>
                {tier !== BASELINE_TIER && (
                  <button
                    disabled={!baselineDone || !engine || engine.tierSize === tier || running}
                    onClick={() => setPendingResize(tier)}
                  >
                    Increase
                  </button>
                )}
              </div>
            ))}
          </div>

          <p className={s.callout}>
            Resize is a deliberate live control-plane action. The app never changes engine size
            automatically, and only unlocks larger tiers once Medium has {target} successful timed
            runs.
          </p>
        </section>
      </div>

      <section className={s.card}>
        <div className={s.cardHeader}>
          <div>
            <h2>How long each search took — {labelTier(activeTier)}</h2>
            <span className={s.muted}>
              Server-measured, start to finish. <b>Typical</b> is the middle run: half were faster,
              half slower.
            </span>
          </div>
          <div className={s.headerActions}>
            <span className={s.tag}>{measured.length} timed runs</span>
            <button onClick={() => setAdvanced(!advanced)}>
              {advanced ? 'Hide statistics' : 'Show statistics'}
            </button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>Search</th>
              <th>Window</th>
              <th title="How many timed runs this figure is based on">Runs</th>
              <th>Typical total</th>
              <th>Fastest</th>
              <th>Slowest</th>
              <th title="Part of the total spent waiting before the engine started">Of which queue</th>
              <th title="Part of the total spent executing on the engine">Of which engine</th>
              <th>Events</th>
              {advanced && (
                <>
                  <th title={`95th percentile: only meaningful with ${P95_MIN_SAMPLES}+ runs`}>p95</th>
                  <th title="Run-to-run variability as a percentage of the typical time">Variability</th>
                  <th title="Absolute time range actually searched">Bounds (UTC)</th>
                </>
              )}
              <th>Failed</th>
              <th>Same data each run</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((row) => (
              <tr key={row.key}>
                <td>{row.search.name}</td>
                <td>
                  <b>{row.def.id}</b>
                  <small>{row.def.label}</small>
                </td>
                <td>{row.total.n || '—'}</td>
                <td>
                  <b>{formatSec(row.total.median)}</b>
                </td>
                <td>{formatSec(row.total.min)}</td>
                <td>{formatSec(row.total.max)}</td>
                <td className={s.muted}>{formatSec(row.queueMedian)}</td>
                <td>{formatSec(row.engineMedian)}</td>
                <td>{row.eventCount === null ? '—' : row.eventCount.toLocaleString()}</td>
                {advanced && (
                  <>
                    <td>
                      {row.total.p95 === null ? (
                        <span
                          className={s.muted}
                          title={`Needs ${P95_MIN_SAMPLES} runs, have ${row.total.n}`}
                        >
                          n&lt;{P95_MIN_SAMPLES}
                        </span>
                      ) : (
                        formatSec(row.total.p95)
                      )}
                    </td>
                    <td>{row.total.cv === null ? '—' : `${(row.total.cv * 100).toFixed(1)}%`}</td>
                    <td className={s.mono}>{row.bounds}</td>
                  </>
                )}
                <td>{row.errors || '—'}</td>
                <td>
                  {!row.total.n ? (
                    'Not run yet'
                  ) : row.consistent ? (
                    <span className={s.success}>Yes</span>
                  ) : (
                    <span className={s.failure}>No — data changed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {advanced && (
          <dl className={s.glossary}>
            <div>
              <dt>Typical (median)</dt>
              <dd>
                The middle run once they are sorted by time. Preferred over an average because one
                unusually slow run cannot drag it.
              </dd>
            </div>
            <div>
              <dt>Runs (n)</dt>
              <dd>How many timed runs the row is based on. More runs, more trustworthy figure.</dd>
            </div>
            <div>
              <dt>p95</dt>
              <dd>
                The time 95 runs in 100 come in under — a &ldquo;bad but not freak&rdquo; case. Withheld
                below {P95_MIN_SAMPLES} runs, where it would just repeat the slowest run.
              </dd>
            </div>
            <div>
              <dt>Variability</dt>
              <dd>
                How much run-to-run time scatters, as a percentage of the typical time. Under ~10% is
                steady; above ~30% the environment is noisy and the figures are soft.
              </dd>
            </div>
            <div>
              <dt>Bounds</dt>
              <dd>
                The exact time range searched, as absolute timestamps. Identical across runs by
                design, so comparisons are not confounded by the clock moving.
              </dd>
            </div>
            <div>
              <dt>Same data each run</dt>
              <dd>
                Whether every run matched the same number of events. &ldquo;No&rdquo; means the
                underlying data changed mid-session, so the times are not strictly comparable.
              </dd>
            </div>
          </dl>
        )}
      </section>

      <section className={s.card}>
        <div className={s.cardHeader}>
          <div>
            <h2>Every run</h2>
            <span className={s.muted}>
              Newest first · total is queue + engine as the server reported them
            </span>
          </div>
          <div className={s.headerActions}>
            <Link to="/compare">Compare tiers</Link>
            <button onClick={() => setPendingClear(true)} disabled={running || !runs.length}>
              Clear history
            </button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Search</th>
              <th>Engine</th>
              <th>Window</th>
              <th>Total s</th>
              <th>Queue s</th>
              <th>Engine s</th>
              <th>Events</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, 25).map((run) => (
              <tr key={run.id}>
                <td className={s.mono}>{run.at.slice(11, 19)}Z</td>
                <td>
                  {run.searchName || '—'}
                  <small className={s.mono}>{run.jobId || 'no job id'}</small>
                </td>
                <td>{labelTier(run.engine)}</td>
                <td>{run.window}</td>
                <td>
                  <b>{formatSec(run.totalMs)}</b>
                </td>
                <td className={s.muted}>{formatSec(run.queueMs)}</td>
                <td>{formatSec(run.engineMs)}</td>
                <td>{run.totalEventCount === null ? '—' : run.totalEventCount.toLocaleString()}</td>
                <td>
                  <span className={run.status === 'Success' ? s.success : s.failure}>
                    {run.status}
                  </span>
                </td>
                <td>{run.notes || (run.measured ? 'Timed' : 'Warm-up')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!runs.length && (
          <div className={s.empty}>
            No runs yet. Pick a window and press <b>Time {chosen.length || ''} searches</b>.
          </div>
        )}
      </section>

      {/*
        An in-app dialog, not window.confirm: this app runs in a sandboxed
        iframe, where native modals can be suppressed outright. A suppressed
        confirm() returns false, which would make the resize silently do
        nothing and look like a broken button.
      */}
      {pendingResize && engine && (
        <div className={s.modalScrim} role="presentation" onClick={() => setPendingResize(null)}>
          <div
            className={s.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="resize-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="resize-title">Resize Lakehouse engine?</h2>
            <p>
              This changes live Lakehouse capacity for <b>{engine.id}</b>, from{' '}
              <b>{labelTier(engine.tierSize)}</b> to <b>{labelTier(pendingResize)}</b>. Billing and
              query performance change for every consumer of this engine, not just this lab.
            </p>
            <div className={s.modalActions}>
              <button onClick={() => setPendingResize(null)}>Cancel</button>
              <button className={s.primary} onClick={() => void applyResize(pendingResize)}>
                Resize to {labelTier(pendingResize)}
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingClear && (
        <div className={s.modalScrim} role="presentation" onClick={() => setPendingClear(false)}>
          <div
            className={s.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="clear-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="clear-title">Clear run history?</h2>
            <p>
              This deletes all {runs.length} recorded runs, including every tier already measured, and
              cannot be undone. Your saved searches are kept. Export from <b>Compare tiers</b> first if
              the results still matter.
            </p>
            <div className={s.modalActions}>
              <button onClick={() => setPendingClear(false)}>Cancel</button>
              <button className={s.stop} onClick={clearHistory}>
                Delete {runs.length} runs
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
