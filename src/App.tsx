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

/** Full KQL for a window: only the bounds differ between windows. */
function buildQuery(config: LabConfig): string {
  return `dataset="${config.dataset}"\n| ${config.query}`;
}

export default function App() {
  const [config, setConfig] = useState<LabConfig>(DEFAULT_CONFIG);
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

  const abortRef = useRef<AbortController | null>(null);
  const configSaveTimer = useRef<number | undefined>(undefined);

  const runs = log.runs;
  const engine = engines.find((item) => item.id === engineId) ?? null;
  const activeTier = engine?.tierSize ?? BASELINE_TIER;
  const searchGroup = config.searchGroup;

  useEffect(() => {
    void loadConfig().then(setConfig);
    void loadRunLog().then(setLog);
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
    setMessage('Run history cleared. Configuration is unchanged.');
  }, []);

  /** One search. Records the outcome either way — a failure is data too. */
  const runOnce = useCallback(
    async (
      window: ReturnType<typeof resolveWindows>[number],
      measured: boolean,
      tier: string,
      signal: AbortSignal,
    ) => {
      const started = performance.now();
      const query = buildQuery(config);
      const base: Omit<RunRecord, 'engineMs' | 'queueMs' | 'totalEventCount' | 'status' | 'notes' | 'jobId'> = {
        id: runId(),
        engine: tier,
        window: window.id,
        earliestSec: window.earliestSec,
        latestSec: window.latestSec,
        clientMs: null,
        measured,
        at: new Date().toISOString(),
        dataset: config.dataset,
        queryHash: hashQuery(query),
        searchGroup: config.searchGroup,
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
    [appendRun, config],
  );

  /**
   * Run a set of windows. Bounds are resolved ONCE against a single anchor so
   * that every repetition — and every window — searches identical data even if
   * the session straddles an hour or day boundary.
   */
  const runSession = useCallback(
    async (defs: WindowDef[]) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setError('');
      setMessage('');
      const tier = activeTier;
      const resolved = resolveWindows(defs, Date.now());
      try {
        for (const [index, window] of resolved.entries()) {
          setProgress(
            `${window.id} (${index + 1}/${resolved.length}) on ${labelTier(tier)} · warm-up + ${config.repetitions} measured`,
          );
          await runOnce(window, false, tier, controller.signal);
          for (let repetition = 0; repetition < config.repetitions; repetition += 1) {
            setProgress(
              `${window.id} (${index + 1}/${resolved.length}) on ${labelTier(tier)} · repetition ${repetition + 1}/${config.repetitions}`,
            );
            await runOnce(window, true, tier, controller.signal);
          }
        }
        setMessage(
          resolved.length === 1
            ? `${resolved[0].id} complete on ${labelTier(tier)}.`
            : `${labelTier(tier)} matrix complete across ${resolved.length} windows.`,
        );
      } catch (cause) {
        if (controller.signal.aborted) {
          setMessage('Run stopped. Completed repetitions are kept; partial sample sets are flagged.');
        } else {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        setProgress('');
        setRunning(false);
        abortRef.current = null;
      }
    },
    [activeTier, config.repetitions, runOnce],
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

  const summary = useMemo(() => {
    return WINDOWS.map((def) => {
      const forWindow = measured.filter((run) => run.window === def.id);
      const ok = forWindow.filter((run) => run.status === 'Success');
      // Only server-reported engine times are eligible as measurements.
      const samples = ok
        .map((run) => run.engineMs)
        .filter((value): value is number => typeof value === 'number');
      const stats = summarizeSamples(samples);
      const counts = ok.map((run) => run.totalEventCount);
      const bounds = ok[0] ?? forWindow[0];
      return {
        def,
        stats,
        errors: forWindow.length - ok.length,
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
    });
  }, [measured]);

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
          typeof run.engineMs === 'number',
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

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <div className={s.eyebrow}>SEARCH / PERFORMANCE LAB</div>
          <h1>Lakehouse Engine Performance Test</h1>
          <p>
            Runs the hostname search across fixed time windows and reports the{' '}
            <b>engine&rsquo;s own execution time</b> as measured server-side, not a browser
            stopwatch. Bounds are resolved to absolute timestamps once per session so every
            repetition searches identical data.
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
          <label htmlFor="window">Window</label>
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
        <button className={s.primary} onClick={() => void runSession([selectedDef])} disabled={running}>
          {running ? 'Running…' : 'Run selected window'}
        </button>
        <button className={s.secondary} onClick={() => void runSession(WINDOWS)} disabled={running}>
          Run {labelTier(activeTier)} matrix
        </button>
        {running && (
          <button onClick={stop} className={s.stop}>
            Stop
          </button>
        )}
        <Link className={s.linkButton} to="/compare">
          Compare tiers
        </Link>
        <Link className={s.linkButtonPlain} to="/settings">
          Configure
        </Link>
      </section>

      <div className={s.grid}>
        <section className={s.card}>
          <div className={s.cardHeader}>
            <div>
              <h2>Test definition</h2>
              <span className={s.muted}>Only the time bounds vary by window</span>
            </div>
            <span className={s.tag}>7 terms</span>
          </div>

          <label htmlFor="dataset">Dataset</label>
          <input
            id="dataset"
            value={config.dataset}
            onChange={(event) => updateConfig({ dataset: event.target.value })}
            disabled={running}
          />

          <label htmlFor="preview">Complete search for {selectedDef.id}</label>
          <textarea
            id="preview"
            className={s.queryPreview}
            rows={9}
            readOnly
            value={`${buildQuery(config)}\n\n-- bounds (absolute, resolved at run start)\n-- ${previewBounds}`}
          />

          <label htmlFor="logic">Search logic (editable)</label>
          <textarea
            id="logic"
            rows={6}
            value={config.query}
            onChange={(event) => updateConfig({ query: event.target.value })}
            disabled={running}
          />

          <div className={s.meta}>
            <span>
              Cache: <b>{config.cacheState}</b>
            </span>
            <span>
              Repetitions: <b>{config.repetitions}</b>
            </span>
            <span>
              Metric: <b>server timeCompleted − timeStarted</b>
            </span>
          </div>
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
                    ? `${engine?.status ?? 'active'} · ${completedFor(tier)}/${target} measured`
                    : completedFor(tier)
                      ? `${completedFor(tier)}/${target} measured`
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
            automatically, and only unlocks larger tiers once Medium has {target} successful
            measured runs.
          </p>
        </section>
      </div>

      <section className={s.card}>
        <div className={s.cardHeader}>
          <div>
            <h2>Summary by window — {labelTier(activeTier)}</h2>
            <span className={s.muted}>
              Server-measured engine time over successful measured runs. p95 needs{' '}
              {P95_MIN_SAMPLES}+ samples; below that only min/median/max are meaningful.
            </span>
          </div>
          <span className={s.tag}>{measured.length} measured runs</span>
        </div>
        <table>
          <thead>
            <tr>
              <th>Window</th>
              <th>Bounds (UTC)</th>
              <th>n</th>
              <th>Median s</th>
              <th>Min s</th>
              <th>Max s</th>
              <th>p95 s</th>
              <th>CV</th>
              <th>Events</th>
              <th>Errors</th>
              <th>Integrity</th>
            </tr>
          </thead>
          <tbody>
            {summary.map(({ def, stats, errors, consistent, eventCount, bounds }) => (
              <tr key={def.id}>
                <td>
                  <b>{def.id}</b>
                  <small>{def.label}</small>
                </td>
                <td className={s.mono}>{bounds}</td>
                <td>{stats.n || '—'}</td>
                <td>{formatSec(stats.median)}</td>
                <td>{formatSec(stats.min)}</td>
                <td>{formatSec(stats.max)}</td>
                <td>
                  {stats.p95 === null ? (
                    <span className={s.muted} title={`Needs ${P95_MIN_SAMPLES} samples, have ${stats.n}`}>
                      n&lt;{P95_MIN_SAMPLES}
                    </span>
                  ) : (
                    formatSec(stats.p95)
                  )}
                </td>
                <td>{stats.cv === null ? '—' : `${(stats.cv * 100).toFixed(1)}%`}</td>
                <td>{eventCount === null ? '—' : eventCount.toLocaleString()}</td>
                <td>{errors || '—'}</td>
                <td>
                  {!stats.n ? (
                    'Awaiting runs'
                  ) : consistent ? (
                    <span className={s.success}>Counts agree</span>
                  ) : (
                    <span className={s.failure}>Counts differ</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className={s.card}>
        <div className={s.cardHeader}>
          <div>
            <h2>Individual run log</h2>
            <span className={s.muted}>
              Durable history · newest first · queue time is reported separately and never charged
              to the engine
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
              <th>Run ID</th>
              <th>Job</th>
              <th>Engine</th>
              <th>Window</th>
              <th>Engine s</th>
              <th>Queue s</th>
              <th>Client s</th>
              <th>Events</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {runs.slice(0, 25).map((run) => (
              <tr key={run.id}>
                <td className={s.mono}>{run.id}</td>
                <td className={s.mono}>{run.jobId || '—'}</td>
                <td>{labelTier(run.engine)}</td>
                <td>
                  {run.window}
                  <small>{new Date(run.earliestSec * 1000).toISOString().slice(0, 16)}Z</small>
                </td>
                <td>
                  <b>{formatSec(run.engineMs)}</b>
                </td>
                <td>{formatSec(run.queueMs)}</td>
                <td className={s.muted}>{formatSec(run.clientMs)}</td>
                <td>{run.totalEventCount === null ? '—' : run.totalEventCount.toLocaleString()}</td>
                <td>
                  <span className={run.status === 'Success' ? s.success : s.failure}>
                    {run.status}
                  </span>
                </td>
                <td>{run.notes || (run.measured ? 'Measured' : 'Warm-up')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!runs.length && (
          <div className={s.empty}>
            No runs yet. Start with the selected window or run the {labelTier(activeTier)} matrix.
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
              cannot be undone. Export from <b>Compare tiers</b> first if the results still matter.
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
