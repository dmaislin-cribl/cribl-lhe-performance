import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiUrl } from './api/cribl';
import { PerfRunError, runTimedQuery } from './api/perfRun';
import { formatBounds, resolveWindows, type WindowDef } from './api/windows';
import { P95_MIN_SAMPLES, countsAgree, formatSec, summarizeSamples } from './api/stats';
import {
  DEFAULT_CONFIG,
  EMPTY_RUN_LOG,
  hashQuery,
  loadConfig,
  loadRunLog,
  repetitionsFor,
  saveConfig,
  saveRunLog,
  type LabConfig,
  type RunLog,
  type RunRecord,
  type TestMode,
} from './api/appSettings';
import {
  type SweepPlan,
  describeSweep,
  estimateSweepSeconds,
  formatDuration,
  planSweep,
  validateSweep,
} from './api/engineSweep';
import { copyToClipboard, provenanceBlock, runsToCsv } from './api/exportResults';
import {
  MAX_SELECTED,
  deriveDataset,
  loadLibrary,
  retargetSearch,
  saveLibrary,
  selectedSearches,
  type SavedSearch,
  type SearchLibrary,
} from './api/searches';
import {
  BASELINE_TIER,
  FEDERATED,
  canonicalTier,
  describeTier,
  isFederated,
  labelTier,
  mergeDiscoveredTiers,
  tierDef,
  tierIndex,
} from './api/tiers';
import {
  attributeRun,
  buildCatalog,
  classifySearch,
  describeCompute,
  groupDatasets,
  waitedForCompute,
  runsOnTarget,
  type DatasetCatalog,
  type SearchPlacement,
} from './api/federated';
import {
  MAX_SESSION_NAME,
  endSession,
  makeSession,
  suggestSessionName,
  uniqueSessionName,
  upsertSession,
  type SessionRecord,
} from './api/sessions';
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

/** How often a sweep re-reads engine status while waiting for a resize to land. */
const RESIZE_POLL_MS = 10_000;

/**
 * How long a sweep waits for a resize before giving up. Generous, because a
 * Lakehouse resize is a control-plane operation with no published SLA — but
 * finite, because the alternative is a sweep that hangs overnight having
 * measured nothing.
 */
const RESIZE_TIMEOUT_MS = 30 * 60_000;

/** Per-resize allowance in the wall-clock estimate. Deliberately pessimistic. */
const RESIZE_SETTLE_SEC = 180;

/** Where each selected search will run, as the searches card labels it. */
const PLACEMENT_LABEL: Record<SearchPlacement, string> = {
  lakehouse: 'Lakehouse',
  federated: 'Federated',
  mixed: 'Mixed',
  unknown: 'Unclassified',
};

const PLACEMENT_HINT: Record<SearchPlacement, string> = {
  lakehouse: 'Reads a Lakehouse dataset: measured on the engine sizes you tick.',
  federated:
    'Reads remote data (S3, Azure Blob, GCS, Lake, Edge, API …): measured on Federated only — no engine size changes how it runs.',
  mixed: 'Reads both Lakehouse and federated datasets: measured on every target you tick.',
  unknown:
    'The dataset could not be classified (wildcard, no dataset= term, or catalog unavailable): measured on every target, and filed by where the server says it actually ran.',
};

function runId(): string {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

/** Abortable delay, so stopping a sweep does not have to wait out a poll interval. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * A rejected resize is nearly always one of two things, and the operator can act
 * on either — so say which rather than showing a bare status code.
 */
function resizeHint(tierSize: string): string {
  const def = tierDef(tierSize);
  if (def?.byRequest) {
    return ` ${def.label} has to be enabled for your org by Cribl — ask them to turn it on, then retry.`;
  }
  if (def && !def.confirmed) {
    return ` The API identifier for ${def.label} ("${tierSize}") is inferred from Cribl's documentation, which does not publish the literal values. If your workspace names it differently, the engine list will show the real value once it appears there.`;
  }
  return '';
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
  /**
   * A sweep awaiting confirmation, with the windows it would cover. One dialog
   * covers the whole planned series — see engineSweep.ts on why that is still a
   * deliberate resize and not an automatic one.
   */
  const [pendingSweep, setPendingSweep] = useState<{ plan: SweepPlan; defs: WindowDef[] } | null>(
    null,
  );
  const [pendingClear, setPendingClear] = useState(false);
  const [previewAnchor, setPreviewAnchor] = useState(0);
  const [refreshingEngines, setRefreshingEngines] = useState(false);
  /**
   * Name for the next run session. Held separately from the session record so
   * the operator can type it before pressing run, which is when they actually
   * know what they are about to measure. Blank means "use the suggestion".
   */
  const [sessionName, setSessionName] = useState('');
  /**
   * The results table answers "how long did each search take" by default. The
   * distribution columns (p95, CV, spread) are real but they are not what most
   * operators came for, and a table that leads with them reads as noise.
   */
  const [advanced, setAdvanced] = useState(false);
  /** Session id the run table is narrowed to, or '' for every run. */
  const [runFilter, setRunFilter] = useState('');
  /**
   * Dataset catalog, used to sort selected searches into Lakehouse and federated
   * before a run. Null until loaded, or when the read failed — in which case
   * every search is "unknown", runs on every target, and is attributed from the
   * server's job record afterwards.
   */
  const [catalog, setCatalog] = useState<DatasetCatalog | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const runs = log.runs;
  const engine = engines.find((item) => item.id === engineId) ?? null;
  const activeTier = canonicalTier(engine?.tierSize ?? BASELINE_TIER);
  /**
   * Sizes to offer. The documented list plus anything this workspace actually
   * reported, so an org with a size the docs do not name is never limited to
   * what was hardcoded here.
   */
  const offeredTiers = useMemo(
    () => mergeDiscoveredTiers(engines.map((item) => item.tierSize)),
    [engines],
  );
  const searchGroup = config.searchGroup;
  const chosen = useMemo(() => (library ? selectedSearches(library) : []), [library]);

  /**
   * Sessions that actually have runs in the log, with their counts — the only
   * ones worth offering as a filter. Ordered by the log, so newest first.
   */
  const sessionFilters = useMemo(() => {
    const counts = new Map<string, { id: string; name: string; count: number }>();
    for (const run of runs) {
      if (!run.sessionId) continue;
      const seen = counts.get(run.sessionId);
      if (seen) seen.count += 1;
      else counts.set(run.sessionId, { id: run.sessionId, name: run.sessionName || 'Unnamed session', count: 1 });
    }
    return [...counts.values()];
  }, [runs]);

  const shownRuns = useMemo(
    () => (runFilter ? runs.filter((run) => run.sessionId === runFilter) : runs),
    [runs, runFilter],
  );

  /**
   * Read once per search group. Failure is not an error worth a banner: the
   * classification it feeds is advisory, and attribution from the job record
   * still files every run correctly.
   */
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`${apiUrl().replace(/\/$/, '')}/m/${encodeURIComponent(searchGroup)}/search/datasets`, {
      signal: controller.signal,
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { items?: unknown } | null) => setCatalog(body ? buildCatalog(body.items) : null))
      .catch(() => {
        if (!controller.signal.aborted) setCatalog(null);
      });
    return () => controller.abort();
  }, [searchGroup]);

  /** Where each selected search is expected to run. */
  const placements = useMemo(() => {
    const map = new Map<string, SearchPlacement>();
    for (const search of chosen) map.set(search.id, classifySearch(search.text, catalog));
    return map;
  }, [chosen, catalog]);

  /** Selected searches a target should run — see `runsOnTarget`. */
  const searchesForTarget = useCallback(
    (target: string) =>
      chosen.filter((search) => runsOnTarget(placements.get(search.id) ?? 'unknown', target)),
    [chosen, placements],
  );

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
  /** The inventory read on its own, so a sweep can poll it without touching UI state. */
  const fetchEngines = useCallback(
    async (signal?: AbortSignal): Promise<Engine[]> => {
      const response = await fetch(
        `${apiUrl().replace(/\/$/, '')}/m/${encodeURIComponent(searchGroup)}/search/local_search/engines?offset=0&limit=50`,
        { signal },
      );
      if (!response.ok) throw new Error(`Engine inventory failed (${response.status})`);
      const body = (await response.json()) as { items?: Engine[] };
      return body.items ?? [];
    },
    [searchGroup],
  );

  const refreshEngines = useCallback(
    async (signal?: AbortSignal) => {
      setRefreshingEngines(true);
      try {
        const items = await fetchEngines(signal);
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
    [fetchEngines],
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
   * Ask the control plane for a new size. Resolves once the request is accepted —
   * not once it has taken effect, which is what `awaitTier` is for.
   */
  const requestResize = useCallback(
    async (id: string, tierSize: string) => {
      const response = await fetch(
        `${apiUrl().replace(/\/$/, '')}/m/${encodeURIComponent(searchGroup)}/search/local_search/engines/${encodeURIComponent(id)}`,
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id, engineType: 'local', tierSize }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `Resize to ${labelTier(tierSize)} was rejected (${response.status}).${resizeHint(tierSize)}`,
        );
      }
      setEngines((current) =>
        current.map((item) => (item.id === id ? { ...item, tierSize, status: 'resizing' } : item)),
      );
    },
    [searchGroup],
  );

  /**
   * Block until the engine actually reports the requested size AND `ready`.
   *
   * Both halves matter. Timing a matrix while the engine is still `resizing`
   * would attribute those runs to a size that was not yet in place, which is the
   * one failure mode that silently corrupts a comparison rather than breaking it
   * visibly. On timeout this throws and the sweep stops, unmeasured, by design.
   */
  const awaitTier = useCallback(
    async (id: string, tier: string, signal: AbortSignal) => {
      const deadline = Date.now() + RESIZE_TIMEOUT_MS;
      for (;;) {
        await sleep(RESIZE_POLL_MS, signal);
        const items = await fetchEngines(signal);
        setEngines(items);
        const found = items.find((item) => item.id === id);
        if (found && canonicalTier(found.tierSize) === tier && found.status === 'ready') return;
        if (Date.now() > deadline) {
          throw new Error(
            `Engine ${id} did not report Ready on ${labelTier(tier)} within ${Math.round(RESIZE_TIMEOUT_MS / 60_000)} minutes. The sweep stopped instead of timing runs on the wrong size — check the engine in Cribl Cloud and re-run.`,
          );
        }
      }
    },
    [fetchEngines],
  );

  /** Persist the sweep selection, so a long unattended run is not re-ticked each time. */
  const setSweepTiers = useCallback(
    (tiers: string[]) => {
      setConfig((current) => {
        const next: LabConfig = { ...current, sweepTiers: tiers };
        void saveConfig(next);
        return next;
      });
    },
    [],
  );

  /**
   * Append a run and, the first time a query revision is seen, store its full
   * text under the hash the run references. Without that the run log would hold
   * timings produced by a query that is no longer on screen.
   */
  const appendRun = useCallback((record: RunRecord, queryText: string) => {
    setLog((current) => {
      const next: RunLog = {
        ...current,
        runs: [record, ...current.runs],
        queries: current.queries[record.queryHash]
          ? current.queries
          : { ...current.queries, [record.queryHash]: queryText },
      };
      void saveRunLog(next);
      return next;
    });
  }, []);

  /** Add or replace a session record, persisting with the runs in one write. */
  const writeSession = useCallback((session: SessionRecord) => {
    setLog((current) => {
      const next: RunLog = { ...current, sessions: upsertSession(current.sessions, session) };
      void saveRunLog(next);
      return next;
    });
  }, []);

  const closeSession = useCallback((id: string, outcome: 'complete' | 'stopped' | 'failed') => {
    setLog((current) => {
      const next: RunLog = { ...current, sessions: endSession(current.sessions, id, outcome) };
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

  /**
   * Export every recorded run, from the page where the runs appear.
   *
   * Clipboard rather than a file: the sandboxed iframe blocks downloads
   * outright, so there is no `<a download>` route out of here. The provenance
   * header travels with the rows, so a paste into a sheet or a customer doc
   * still records which searches, dataset and build produced the numbers.
   */
  /**
   * Export whatever the table is showing, not always the whole log. The
   * provenance header is scoped to the same rows, so the "# measured runs" line
   * describes the CSV underneath it rather than the history behind it.
   */
  const copyRuns = useCallback(async () => {
    const scope = runFilter
      ? (sessionFilters.find((entry) => entry.id === runFilter)?.name ?? 'one session')
      : 'all runs';
    const text = `${provenanceBlock({ ...log, runs: shownRuns }, { view: scope })}\n${runsToCsv(shownRuns)}`;
    const ok = await copyToClipboard(text);
    if (ok) setMessage(`Copied ${shownRuns.length} runs (${scope}) as CSV to the clipboard.`);
    else setError('The clipboard is unavailable here. Use Compare tiers, or re-try after clicking the page.');
  }, [log, shownRuns, runFilter, sessionFilters]);

  /** One search. Records the outcome either way — a failure is data too. */
  const runOnce = useCallback(
    async (
      search: SavedSearch,
      window: ReturnType<typeof resolveWindows>[number],
      measured: boolean,
      tier: string,
      /** The Lakehouse size the engine is on now, for runs the server says ran locally. */
      engineTier: string,
      session: SessionRecord,
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
        sessionId: session.id,
        sessionName: session.name,
      };
      try {
        const result = await runTimedQuery(query, {
          earliestSec: window.earliestSec,
          latestSec: window.latestSec,
          searchGroup: config.searchGroup,
          signal,
        });
        const { insight, computeWait } = result;
        // Filed by what the server says ran, not by what was planned — a size
        // sweep that launched an S3 search must not record it as a size.
        const attributed = attributeRun({ planned: tier, path: insight.path, engineTier });
        appendRun(
          {
            ...base,
            engine: attributed.target,
            jobId: result.jobId,
            totalMs: result.totalMs,
            engineMs: result.engineMs,
            queueMs: result.queueMs,
            clientMs: Math.round(result.clientMs),
            totalEventCount: result.totalEventCount,
            status: 'Success',
            notes: [measured ? '' : 'Warm-up', attributed.note].filter(Boolean).join(' · '),
            path: insight.path,
            billableCpuMs: insight.billableCpuMs,
            totalCpuMs: insight.totalCpuMs,
            executors: insight.executors,
            // Null, not zero, when the job never reported node statuses: a v1 or
            // Lakehouse job did not "wait 0 s", it just did not say.
            computeCold: computeWait.reported ? computeWait.peakCold : null,
            computeWarm: computeWait.reported ? computeWait.peakWarm : null,
            computeWaitMs: computeWait.reported ? computeWait.waitMs : null,
            providerTypes: insight.providerTypes,
            computeTypes: insight.computeTypes,
            cache: insight.cache,
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
   * Run a set of windows for every selected search, on every engine size in the
   * plan, resizing between sizes.
   *
   * Bounds are resolved ONCE against a single anchor so that every repetition —
   * and every window, every search, and every engine size — measures identical
   * data even if the sweep straddles an hour or day boundary. That is what makes
   * the cross-size comparison legitimate: a sweep can take hours, and re-resolving
   * "last 24 hours" per size would quietly give each size a different day.
   */
  const runSession = useCallback(
    async (defs: WindowDef[], plan: SweepPlan) => {
      if (!chosen.length || !plan.steps.length) return;
      const startingTier = activeTier;
      const target = engine;
      if (plan.resizes > 0 && !target) {
        setError(
          'No engine is selected, so the sweep has nothing to resize. Pick an engine above, or select only the size it already runs.',
        );
        return;
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setRunning(true);
      setError('');
      setMessage('');
      const resolved = resolveWindows(defs, Date.now());
      const sweeping = plan.steps.length > 1;

      /**
       * The session is created and written BEFORE the first run, so a crash or a
       * closed tab still leaves a named record explaining what those orphan runs
       * were. `settleStale` marks it stopped on the next load.
       */
      const session = makeSession({
        name: uniqueSessionName(
          log.sessions,
          sessionName.trim() ||
            suggestSessionName({
              // "Targets" once Federated is in the plan: it is not a size.
              tier: sweeping
                ? `${plan.steps.length} ${plan.steps.some((step) => isFederated(step.tier)) ? 'targets' : 'sizes'}`
                : labelTier(plan.steps[0].tier),
              windowCount: resolved.length,
              searchCount: chosen.length,
            }),
        ),
        // The size the session STARTED on. Each run carries the size it actually
        // ran on, so a sweep is not misattributed to one tier — the notes below
        // record the full series.
        tier: plan.steps[0].tier,
        windowIds: resolved.map((window) => window.id),
        searchNames: chosen.map((search) => search.name),
        repetitions: config.repetitions,
        // What each window actually got, so a session with mixed counts is not
        // recorded as though one number applied to all of it.
        windowRepetitions: Object.fromEntries(
          resolved.map((window) => [window.id, repetitionsFor(config, window.id)]),
        ),
        notes: sweeping ? `Sweep: ${describeSweep(plan)}` : '',
      });
      writeSession(session);
      // Cleared so the next session gets a fresh suggestion rather than silently
      // reusing this name and being renamed to "… 2".
      setSessionName('');

      // Tracked so the restore below knows whether the engine was actually moved,
      // including when a sweep was stopped part way up the series.
      let currentTier = startingTier;
      try {
        let done = 0;
        for (const [index, step] of plan.steps.entries()) {
          const stepLabel = sweeping ? `size ${index + 1} of ${plan.steps.length} · ` : '';
          if (step.needsResize) {
            setProgress(
              `${session.name} · ${stepLabel}resizing engine to ${labelTier(step.tier)} — this can take several minutes`,
            );
            await requestResize(target!.id, step.tier);
            await awaitTier(target!.id, step.tier, controller.signal);
          }
          // Federated does not move the engine, so the size it is on stays the
          // one the restore below compares against.
          if (!isFederated(step.tier)) currentTier = step.tier;
          for (const search of searchesForTarget(step.tier)) {
            for (const window of resolved) {
              setProgress(
                `${session.name} · ${stepLabel}${search.name} · ${window.id} on ${labelTier(step.tier)} · warm-up (${done}/${plan.totalRuns} runs done)`,
              );
              await runOnce(search, window, false, step.tier, currentTier, session, controller.signal);
              done += 1;
              const timed = repetitionsFor(config, window.id);
              for (let repetition = 0; repetition < timed; repetition += 1) {
                setProgress(
                  `${session.name} · ${stepLabel}${search.name} · ${window.id} on ${labelTier(step.tier)} · run ${repetition + 1} of ${timed} (${done}/${plan.totalRuns} total)`,
                );
                await runOnce(search, window, true, step.tier, currentTier, session, controller.signal);
                done += 1;
              }
            }
          }
        }
        closeSession(session.id, 'complete');
        setMessage(
          `“${session.name}” finished: ${chosen.length} ${chosen.length === 1 ? 'search' : 'searches'} × ${resolved.length} ${resolved.length === 1 ? 'window' : 'windows'} on ${plan.steps.map((step) => labelTier(step.tier)).join(', ')}. ${
            plan.steps.length > 1
              ? 'Open Analysis to see whether the differences between those sizes are real.'
              : isFederated(plan.steps[0].tier)
                ? 'Open Analysis for the distribution, billable CPU and compute waits.'
                : 'Open Analysis for the distribution.'
          }`,
        );
      } catch (cause) {
        if (controller.signal.aborted) {
          closeSession(session.id, 'stopped');
          setMessage(
            `“${session.name}” stopped. Completed runs are kept and stay under that name; the session is marked incomplete.`,
          );
        } else {
          closeSession(session.id, 'failed');
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        /**
         * Put the capacity back. This runs on every exit path including a stop or
         * a failure, because the reason to restore — a live engine, and its bill,
         * left parked at the largest size nobody is using — is exactly as true
         * when the sweep ended badly. It is requested, not awaited: the operator
         * does not need to watch a resize they are not measuring.
         */
        if (config.restoreTierAfterSweep && target && currentTier !== startingTier) {
          try {
            await requestResize(target.id, startingTier);
            setMessage(
              (current) =>
                `${current} The engine is being resized back to ${labelTier(startingTier)}; its status refreshes here until it reports Ready.`,
            );
          } catch (cause) {
            setError(
              `Runs are saved, but restoring the engine to ${labelTier(startingTier)} failed: ${cause instanceof Error ? cause.message : String(cause)} — it is still on ${labelTier(currentTier)}. Resize it from the engine list.`,
            );
          }
        }
        setProgress('');
        setRunning(false);
        abortRef.current = null;
      }
    },
    [
      activeTier,
      awaitTier,
      chosen,
      closeSession,
      config,
      engine,
      log.sessions,
      requestResize,
      runOnce,
      searchesForTarget,
      sessionName,
      writeSession,
    ],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  /** A one-off manual resize, outside any sweep. */
  const applyResize = useCallback(
    async (tierSize: string) => {
      setPendingResize(null);
      if (!engine) return;
      try {
        await requestResize(engine.id, tierSize);
        setError('');
        setMessage(
          `Resize to ${labelTier(tierSize)} requested. Engine status refreshes automatically until it reports Ready — do not start its matrix before then.`,
        );
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [engine, requestResize],
  );

  /**
   * The configured window set. Read through one binding so every count, plan and
   * dropdown on this page is looking at the same list even mid-edit — Settings can
   * add or delete a window while this page is open.
   */
  const windows = config.windows;

  /**
   * The workbench does one kind of test at a time — see LabConfig.testMode. The
   * results table follows it: a federated test shows federated runs, a
   * Lakehouse test shows the size the engine is on now.
   */
  const federatedMode = config.testMode === 'federated';
  const shownTarget = federatedMode ? FEDERATED : activeTier;
  const showingFederated = federatedMode;

  const measured = useMemo(
    () => runs.filter((run) => run.measured && run.engine === shownTarget),
    [runs, shownTarget],
  );

  /**
   * One row per selected search per window, on the active tier. Leads with the
   * end-to-end time the server reported, split into queue and engine so a slow
   * result can be attributed without needing the distribution columns.
   */
  /** Selected searches this test will actually run — the rest are skipped, and say why. */
  const runnable = useMemo(
    () => searchesForTarget(federatedMode ? FEDERATED : activeTier),
    [searchesForTarget, federatedMode, activeTier],
  );

  const summary = useMemo(() => {
    // Only what this test runs: a skipped search would sit in the table as
    // "Not run yet" forever, which reads as a run still to come.
    return runnable.flatMap((search) =>
      windows.map((def) => {
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
          cpuMedian: medianOf(ok.map((run) => run.billableCpuMs ?? null)),
          executorsMedian: medianOf(ok.map((run) => run.executors ?? null)),
          // Counted only where the server reported node statuses at all.
          coldRuns: ok.filter((run) => waitedForCompute(run.computeWaitMs) === true).length,
          coldKnown: ok.filter((run) => waitedForCompute(run.computeWaitMs) !== null).length,
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
  }, [runnable, measured, windows]);

  /**
   * Timed runs one engine size needs for full coverage: the sum across windows,
   * since each window can carry its own count.
   */
  const target = useMemo(
    () => windows.reduce((sum, def) => sum + repetitionsFor(config, def.id), 0),
    [config, windows],
  );

  /**
   * Successful measured runs only. A size with nothing but failures has no
   * coverage, and the progress readout should say so rather than counting
   * attempts.
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

  const selectedDef = windows.find((def) => def.id === selectedWindow) ?? windows[0];
  const activeDone = completedFor(activeTier) >= target;

  // Preview-only anchor, kept in state so render stays pure. A run resolves
  // its own anchor at start time; this just shows what the bounds would be.
  const previewBounds = useMemo(
    () => (previewAnchor ? formatBounds(resolveWindows([selectedDef], previewAnchor)[0]) : '—'),
    [selectedDef, previewAnchor],
  );

  const plannedRuns = runnable.length * (repetitionsFor(config, selectedDef.id) + 1);
  const datasetGroups = useMemo(() => groupDatasets(catalog), [catalog]);

  /**
   * Sizes the next run covers. Falls back to whatever the engine is on, so an
   * empty selection still runs something rather than doing nothing silently.
   */
  const sweepTiers = useMemo(
    () =>
      federatedMode ? [FEDERATED] : config.sweepTiers.length ? config.sweepTiers : [activeTier],
    [federatedMode, config.sweepTiers, activeTier],
  );

  const planFor = useCallback(
    (defs: WindowDef[]) =>
      planSweep({
        selected: sweepTiers,
        currentTier: activeTier,
        searches: chosen.length,
        searchesFor: (tier) => searchesForTarget(tier).length,
        runsPerWindow: defs.map((def) => repetitionsFor(config, def.id)),
      }),
    [sweepTiers, activeTier, chosen.length, config, searchesForTarget],
  );

  /** Median of every timed run so far, used only for the wall-clock estimate. */
  const medianRunMs = useMemo(
    () =>
      medianOf(
        runs.filter((run) => run.measured && run.status === 'Success').map((run) => run.totalMs),
      ),
    [runs],
  );

  /**
   * Start a run. A plan that needs no resize starts immediately; anything that
   * would touch live capacity goes through the confirmation first, however many
   * sizes it covers.
   */
  const startRun = useCallback(
    (defs: WindowDef[]) => {
      const plan = planFor(defs);
      const problem = validateSweep({
        selected: plan.steps.map((step) => step.tier),
        hasSearches: chosen.length > 0,
        steps: plan.steps,
      });
      if (problem) {
        setError(problem);
        return;
      }
      setError('');
      if (plan.resizes > 0) setPendingSweep({ plan, defs });
      else void runSession(defs, plan);
    },
    [planFor, chosen.length, runSession],
  );

  /**
   * Placeholder for the session name box: what the session would be called if
   * the operator names nothing. Shown rather than prefilled, so an untouched box
   * reads as "a name will be generated" instead of as a name they chose.
   */
  const suggestedName = useMemo(
    () =>
      suggestSessionName({
        tier: sweepTiers.length === 1 ? labelTier(sweepTiers[0]) : `${sweepTiers.length} sizes`,
        windowCount: 1,
        searchCount: Math.max(1, runnable.length),
      }),
    [sweepTiers, runnable.length],
  );

  /** Switch test type. Persisted: an operator running federated tests keeps doing so. */
  const setTestMode = useCallback((next: TestMode) => {
    setConfig((current) => {
      const updated: LabConfig = { ...current, testMode: next };
      void saveConfig(updated);
      return updated;
    });
    setError('');
  }, []);

  /**
   * Point a selected search at another dataset from its picker. A search that
   * already has measured runs is copied rather than edited — see
   * `retargetSearch` for why editing it in place would corrupt Analysis.
   */
  const retarget = useCallback(
    async (search: SavedSearch, datasetId: string) => {
      if (!library || !datasetId) return;
      const hasRuns = runs.some((run) => run.searchId === search.id && run.measured);
      const result = retargetSearch(library, search.id, datasetId, hasRuns);
      if (result.library === library) return;
      setLibrary(result.library);
      const created = result.library.searches.find((entry) => entry.id === result.searchId);
      try {
        await saveLibrary(result.library);
        setError('');
        setMessage(
          result.copied
            ? `“${search.name}” already has measured runs, so it was kept unchanged; a copy, “${created?.name}”, now runs against ${datasetId} in its place.`
            : `“${search.name}” now runs against ${datasetId}.`,
        );
      } catch (cause) {
        setError(`Could not save the dataset change: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    },
    [library, runs],
  );

  return (
    <div className={s.page}>
      <header className={s.header}>
        <div>
          <div className={s.eyebrow}>
            CRIBL SEARCH / PERFORMANCE TESTING
            <span className={s.version} title={`app id: ${__APP_ID__}`}>
              v{__APP_VERSION__}
            </span>
          </div>
          <h1>{__APP_DISPLAY_NAME__}</h1>
          <p>
            Measures <b>how long each search takes, start to finish</b>, using the server&rsquo;s own
            clock rather than a browser stopwatch. Each time is split into waiting in the queue and
            execution. Every search runs several times so a single slow run cannot be mistaken for
            the real figure.
          </p>
        </div>
        {federatedMode ? (
          <div className={s.engineBadge}>
            <span className={`${s.dot} ${s.ready}`} />
            Federated search · no engine used
          </div>
        ) : (
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
        )}
      </header>

      {/* Two different tests, chosen first, because everything below depends on
          it: which searches run, whether an engine is involved, what is recorded. */}
      <div className={s.modeBar} role="radiogroup" aria-label="What to test">
        {(
          [
            ['lakehouse', 'Lakehouse engine sizes', 'Searches over Lakehouse datasets, timed on one or more engine sizes.'],
            [
              'federated',
              'Federated search',
              'Searches over remote data — S3, Azure Blob, GCS, Cribl Lake, Edge, APIs — on the federated executors. No engine is used.',
            ],
          ] as const
        ).map(([value, title, detail]) => (
          <button
            key={value}
            role="radio"
            aria-checked={config.testMode === value}
            className={`${s.modeOption} ${config.testMode === value ? s.modeActive : ''}`}
            disabled={running}
            onClick={() => setTestMode(value)}
          >
            <b>{title}</b>
            <small>{detail}</small>
          </button>
        ))}
      </div>

      {progress && <div className={s.notice}>{progress}</div>}
      {message && <div className={s.notice}>{message}</div>}
      {error && <div className={s.error}>{error}</div>}

      <section className={s.toolbar}>
        <div className={s.sessionField}>
          <label htmlFor="sessionName">Session name</label>
          <input
            id="sessionName"
            value={sessionName}
            maxLength={MAX_SESSION_NAME}
            placeholder={suggestedName}
            onChange={(event) => setSessionName(event.target.value)}
            disabled={running}
            title="What this run session is measuring. Saved with the runs and renameable later."
          />
        </div>
        <div>
          <label htmlFor="window">Time window</label>
          <select
            id="window"
            // The resolved def, not the raw state: the window this was set to can
            // be deleted in Settings while this page is open, and a select whose
            // value matches no option renders blank while the run uses windows[0].
            value={selectedDef.id}
            onChange={(event) => setSelectedWindow(event.target.value)}
            disabled={running}
          >
            {windows.map((def) => (
              <option key={def.id} value={def.id}>
                {def.id} · {def.label}
              </option>
            ))}
          </select>
        </div>
        {!federatedMode && engines.length > 1 && (
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
          onClick={() => startRun([selectedDef])}
          disabled={running || !runnable.length}
          title={runnable.length ? undefined : 'None of the selected searches can run in this test — see the searches below.'}
        >
          {running ? 'Running…' : `Time ${runnable.length} ${runnable.length === 1 ? 'search' : 'searches'}`}
        </button>
        <button
          className={s.secondary}
          onClick={() => startRun(windows)}
          disabled={running || !runnable.length}
        >
          All {windows.length} windows
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
        <Link className={s.linkButtonPlain} to="/analysis">
          Analysis
        </Link>
      </section>

      <div className={s.grid}>
        <section className={s.card}>
          <div className={s.cardHeader}>
            <div>
              <h2>Searches being timed</h2>
              <span className={s.muted}>
                {runnable.length
                  ? `${plannedRuns} runs per window: ${repetitionsFor(config, selectedDef.id)} timed plus one warm-up for each of ${runnable.length} ${runnable.length === 1 ? 'search' : 'searches'}`
                  : `Nothing selected runs in a ${federatedMode ? 'federated' : 'Lakehouse'} test — see below`}
              </span>
            </div>
            <Link className={s.tagLink} to="/searches">
              Edit
            </Link>
          </div>

          {!library && <p className={s.muted}>Loading saved searches…</p>}

          {/* The app ships with no searches, so this is the first thing a new
              install shows. It has to say what to do, not just that a list is
              empty. */}
          {library && !library.searches.length && (
            <div className={s.empty}>
              <p>
                <b>No test searches yet.</b> This app deliberately ships without any — a benchmark
                should measure your searches against your data, not a sample that happens to be
                here.
              </p>
              <Link className={s.linkButton} to="/searches">
                Add your first search
              </Link>
            </div>
          )}

          {library && library.searches.length > 0 && !chosen.length && (
            <div className={s.empty}>
              <p>
                <b>Nothing selected to run.</b> {library.searches.length}{' '}
                {library.searches.length === 1 ? 'search is' : 'searches are'} saved — tick up to{' '}
                {MAX_SELECTED} of them to measure.
              </p>
              <Link className={s.linkButton} to="/searches">
                Choose searches
              </Link>
            </div>
          )}

          {chosen.map((search) => {
            const placement = placements.get(search.id) ?? 'unknown';
            const current = deriveDataset(search.text);
            const inCatalog = Boolean(catalog?.has(current));
            const skipped = !runnable.some((entry) => entry.id === search.id);
            return (
            <div className={`${s.searchItem} ${skipped ? s.searchSkipped : ''}`} key={search.id}>
              <div className={s.searchName}>
                <b>{search.name}</b>
                <span className={s.tag} title={PLACEMENT_HINT[placement]}>
                  {PLACEMENT_LABEL[placement]}
                </span>
              </div>
              {/* Which dataset this search tests, grouped by where it lives. Only
                  shown once the catalog is in: without it there is nothing to
                  group, and the plain label below says what the search reads. */}
              {datasetGroups.length > 0 ? (
                <div className={s.datasetPick}>
                  <label htmlFor={`dataset-${search.id}`}>Dataset</label>
                  <select
                    id={`dataset-${search.id}`}
                    value={inCatalog ? current : ''}
                    disabled={running}
                    onChange={(event) => void retarget(search, event.target.value)}
                  >
                    {!inCatalog && (
                      <option value="">
                        {current ? `${current} (not a single catalog dataset — edit in Manage searches)` : 'Choose a dataset…'}
                      </option>
                    )}
                    {datasetGroups.map((group) => (
                      <optgroup key={group.label} label={group.label}>
                        {group.ids.map((id) => (
                          <option key={id} value={id}>
                            {id}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
              ) : (
                <span className={s.muted}>{current || 'no dataset term'}</span>
              )}
              {skipped && (
                <span className={s.skipNote}>
                  {federatedMode
                    ? 'Skipped in a federated test: this reads a Lakehouse dataset. Pick a dataset under a “Federated” group, or switch to Lakehouse engine sizes.'
                    : 'Skipped in a Lakehouse test: this reads remote data, which no engine size affects. Pick a Lakehouse dataset, or switch to Federated search.'}
                </span>
              )}
              {!skipped && placement === 'unknown' && (
                <span className={s.muted}>
                  Can&rsquo;t tell from the catalog where this runs, so it runs, and each run is filed
                  by where the server says it executed.
                </span>
              )}
              {/* Half a pair measured is half a comparison: say so before the run,
                  not after it, when the missing column is already a re-run away. */}
              {library && search.counterpartId && !chosen.some((entry) => entry.id === search.counterpartId) && (
                <span className={s.muted}>
                  Paired with “{library.searches.find((entry) => entry.id === search.counterpartId)?.name}”,
                  which is not selected. Select it too to measure both copies of the data in this
                  session.
                </span>
              )}
              <pre className={s.searchText}>{search.text}</pre>
            </div>
            );
          })}

          <div className={s.boundsNote}>
            <b>{selectedDef.id}</b> bounds if started now: <span className={s.mono}>{previewBounds}</span>
            <span className={s.muted}>
              Resolved to fixed timestamps when a session starts, so every run — and every search —
              covers exactly the same data.
            </span>
          </div>

        </section>

        {federatedMode ? (
          <section className={`${s.card} ${s.federatedCard}`}>
            <div className={s.cardHeader}>
              <div>
                <h2>Federated search test</h2>
                <span className={s.muted}>
                  Times the selected searches on Cribl Search&rsquo;s federated executors, against data
                  that stays where it is. No Lakehouse engine is used or resized, and engine size has
                  no effect on these figures.
                </span>
              </div>
              <span className={`${s.tag} ${completedFor(FEDERATED) >= target ? s.tagGood : ''}`}>
                {completedFor(FEDERATED)} timed so far
              </span>
            </div>

            {/* The one line that says what pressing run does. Never "0 searches"
                without saying why and what to change. */}
            <p className={s.planLine}>
              {runnable.length ? (
                <>
                  <b>Next run:</b> Federated search · {runnable.length}{' '}
                  {runnable.length === 1 ? 'search' : 'searches'} × {selectedDef.id} ({selectedDef.label}) ·{' '}
                  {plannedRuns} runs ({repetitionsFor(config, selectedDef.id)} timed + 1 warm-up each) · est.{' '}
                  {formatDuration(
                    estimateSweepSeconds({ plan: planFor([selectedDef]), medianRunMs, resizeSettleSec: 0 }),
                  )}
                  {medianRunMs === null && ' (no timing history yet)'}
                </>
              ) : (
                <>
                  <b>Nothing to run yet.</b> None of the selected searches reads a federated dataset.
                  Pick one from a search&rsquo;s <b>Dataset</b> list, under a &ldquo;Federated&rdquo;
                  group.
                </>
              )}
            </p>

            <dl className={s.factList}>
              <div>
                <dt>Each run records</dt>
                <dd>
                  Total time (queue + execution), <b>billable CPU-seconds</b> — what the search costs —
                  how many executors it fanned out to, and how long it waited for compute nodes to
                  start.
                </dd>
              </div>
              <div>
                <dt>Start-up time</dt>
                <dd>
                  Executors that have been idle take time to start. The warm-up run absorbs most of
                  it; a timed run that still waited is marked, and Analysis can exclude or isolate
                  those runs.
                </dd>
              </div>
              <div>
                <dt>Against Lakehouse</dt>
                <dd>
                  Pair this search with its Lakehouse copy (Manage searches → Counterpart), run one
                  session in each test type, then compare them in Analysis.
                </dd>
              </div>
            </dl>
          </section>
        ) : (
        <section className={s.card}>
          <div className={s.cardHeader}>
            <div>
              <h2>Engine sizes to test</h2>
              <span className={s.muted}>
                Tick every size this run should measure. The sweep always runs them smallest first,
                resizing between them.
              </span>
            </div>
            {/* Coverage of the size the engine is on now — the one an operator is
                most likely mid-way through — not a fixed size they may never test. */}
            <span className={`${s.tag} ${activeDone ? s.tagGood : ''}`}>
              {labelTier(activeTier)} {activeDone ? 'complete' : 'active'}
            </span>
          </div>

          <div className={s.progress}>
            <div style={{ width: `${Math.min(100, (completedFor(activeTier) / target) * 100)}%` }} />
          </div>

          {/* Select-all is the request in one click; it is also the most expensive
              thing on this page, so the plan line below states what it costs. */}
          <div className={s.sweepBar}>
            <button
              onClick={() => setSweepTiers(offeredTiers)}
              disabled={running || sweepTiers.length === offeredTiers.length}
            >
              Select all {offeredTiers.length}
            </button>
            {/* Clears the selection rather than pinning today's size, so it keeps
                following the engine if someone resizes it outside this app. */}
            <button
              onClick={() => setSweepTiers([])}
              disabled={running || config.sweepTiers.length === 0}
            >
              Current size only
            </button>
            <label className={s.restore} title="Resize the engine back when the sweep ends">
              <input
                type="checkbox"
                checked={config.restoreTierAfterSweep}
                disabled={running}
                onChange={(event) => {
                  const next: LabConfig = { ...config, restoreTierAfterSweep: event.target.checked };
                  setConfig(next);
                  void saveConfig(next);
                }}
              />
              Restore {labelTier(activeTier)} afterwards
            </label>
          </div>

          <div className={s.tierList}>
            {offeredTiers.map((tier, index) => {
              const def = tierDef(tier);
              const isActive = tier === activeTier;
              // Which way the standalone resize button moves the engine. No size is
              // gated behind another: any size can be measured on its own, in any
              // order, and a sweep that includes several runs them smallest first.
              const larger = tierIndex(tier) > tierIndex(activeTier);
              const picked = sweepTiers.includes(tier);
              return (
                <div className={s.tier} key={tier}>
                  <input
                    type="checkbox"
                    className={s.tierPick}
                    checked={picked}
                    // The last remaining size cannot be unticked: a sweep of nothing
                    // is not a state worth being able to reach through a checkbox
                    // that then refuses to let anything run.
                    disabled={running || (picked && sweepTiers.length === 1)}
                    aria-label={`Measure on ${labelTier(tier)}`}
                    onChange={(event) =>
                      setSweepTiers(
                        event.target.checked
                          ? [...sweepTiers, tier]
                          : sweepTiers.filter((entry) => entry !== tier),
                      )
                    }
                  />
                  <span className={isActive ? s.current : ''}>{index + 1}</span>
                  <strong>{labelTier(tier)}</strong>
                  <small>
                    {isActive
                      ? `${engine?.status ?? 'active'} · ${completedFor(tier)}/${target} timed`
                      : completedFor(tier)
                        ? `${completedFor(tier)}/${target} timed`
                        : def?.dailyGb
                          ? def.dailyGb < 1000
                            ? `${def.dailyGb.toLocaleString()} GB/day`
                            : `${(def.dailyGb / 1000).toLocaleString()} TB/day`
                          : 'Reported by this workspace'}
                    {def?.byRequest && ' · by request'}
                  </small>
                  {!isActive && (
                    <button
                      disabled={!engine || running}
                      onClick={() => setPendingResize(tier)}
                      title={`Resize this engine to ${describeTier(tier)} now, without running anything`}
                    >
                      {larger ? 'Increase' : 'Decrease'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* What pressing run will actually do, in one line, before it is pressed. */}
          <p className={s.planLine}>
            {runnable.length ? (
              <>
                <b>Next run:</b> {describeSweep(planFor([selectedDef]))}
                {' · est. '}
                {formatDuration(
                  estimateSweepSeconds({
                    plan: planFor([selectedDef]),
                    medianRunMs,
                    resizeSettleSec: RESIZE_SETTLE_SEC,
                  }),
                )}
                {medianRunMs === null && ' (no timing history yet)'}
              </>
            ) : (
              <>
                <b>Nothing to run on an engine.</b> Every selected search reads remote data, which no
                engine size affects. Pick a Lakehouse dataset on a search, or switch to{' '}
                <b>Federated search</b> above.
              </>
            )}
          </p>

          <p className={s.callout}>
            Resizing is a live control-plane action and is never silent: a sweep that changes size
            asks once, listing every size it will pass through, and nothing is resized until you
            confirm. Any size can be measured on its own, in any order. 4XLarge and above are not
            offered because Cribl only grants them through a support request; 3XLarge needs Cribl to
            enable it for your org, and the API names for sizes this app has not yet seen are
            inferred from the docs — a rejected resize is reported rather than hidden.
          </p>
        </section>
        )}
      </div>

      <section className={s.card}>
        <div className={s.cardHeader}>
          <div>
            <h2>How long each search took — {labelTier(shownTarget)}</h2>
            <span className={s.muted}>
              Server-measured, start to finish. <b>Typical</b> is the middle run: half were faster,
              half slower.
              {showingFederated &&
                ' Federated searches are billed per CPU-second, so the cost columns matter as much as the time.'}
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
              <th title={showingFederated ? 'Part of the total spent executing on the federated executors' : 'Part of the total spent executing on the engine'}>
                {showingFederated ? 'Of which execution' : 'Of which engine'}
              </th>
              {showingFederated && (
                <>
                  <th title="Median billable CPU-seconds per run — what a federated search costs">
                    Billable CPU
                  </th>
                  <th title="Median executors the search fanned out to, coordinator excluded">
                    Executors
                  </th>
                  <th title="Timed runs that spent time waiting for compute nodes, out of those whose job reported it (compute v1 does not). The main source of federated variance; Analysis can split them out.">
                    Waited for compute
                  </th>
                </>
              )}
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
                {showingFederated && (
                  <>
                    <td>{formatSec(row.cpuMedian)}</td>
                    <td>{row.executorsMedian === null ? '—' : Math.round(row.executorsMedian)}</td>
                    <td>{row.coldKnown ? `${row.coldRuns}/${row.coldKnown}` : '—'}</td>
                  </>
                )}
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
              Saved automatically, newest first · total is queue + engine as the server reported them
            </span>
          </div>
          <div className={s.headerActions}>
            {/* Filter by session, because the question is almost always "the runs
                from that one benchmark", not "everything ever measured here". */}
            {sessionFilters.length > 0 && (
              <select
                aria-label="Filter runs by session"
                value={runFilter}
                onChange={(event) => setRunFilter(event.target.value)}
              >
                <option value="">All sessions ({runs.length} runs)</option>
                {sessionFilters.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} ({entry.count})
                  </option>
                ))}
              </select>
            )}
            <Link to="/sessions">Sessions</Link>
            <Link to="/compare">Compare tiers</Link>
            <button onClick={() => void copyRuns()} disabled={!shownRuns.length}>
              {runFilter ? 'Copy these runs (CSV)' : 'Copy all runs (CSV)'}
            </button>
            <button onClick={() => setPendingClear(true)} disabled={running || !runs.length}>
              Clear history
            </button>
          </div>
        </div>
        <table>
          <thead>
            <tr>
              <th>When</th>
              <th>Session</th>
              <th>Search</th>
              <th>Engine</th>
              <th>Window</th>
              <th>Total s</th>
              <th>Queue s</th>
              <th>Engine s</th>
              <th title="Provider · federated compute version · cold/warm executors · cache">Compute</th>
              <th title="Billable CPU-seconds">CPU s</th>
              <th>Events</th>
              <th>Status</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {shownRuns.slice(0, 25).map((run) => (
              <tr key={run.id}>
                <td className={s.mono}>{run.at.slice(11, 19)}Z</td>
                <td>{run.sessionName || <span className={s.muted}>no session</span>}</td>
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
                <td className={s.muted}>{describeCompute(run) || '—'}</td>
                <td>{formatSec(run.billableCpuMs ?? null)}</td>
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
        {runs.length > 0 && !shownRuns.length && (
          <div className={s.empty}>
            That session has no runs left in the log. <button className={s.linkish} onClick={() => setRunFilter('')}>Show all sessions</button>
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
            {tierDef(pendingResize)?.byRequest && (
              <p>
                <b>{labelTier(pendingResize)} is available by request.</b> If Cribl has not enabled it
                for this org the control plane rejects the change — nothing is resized, and the
                rejection is reported here.
              </p>
            )}
            {tierDef(pendingResize) && !tierDef(pendingResize)?.confirmed && (
              <p>
                Cribl documents this size but not the literal API value it is sent as, so this app
                uses <code>{pendingResize}</code>. A wrong guess fails cleanly with a rejection.
              </p>
            )}
            {tierIndex(pendingResize) < tierIndex(engine.tierSize) && (
              <p>
                This is a <b>reduction</b>. Measurements already recorded on{' '}
                {labelTier(engine.tierSize)} are kept — they are attributed to the size they ran on,
                not to the engine's current one.
              </p>
            )}
            <div className={s.modalActions}>
              <button onClick={() => setPendingResize(null)}>Cancel</button>
              <button className={s.primary} onClick={() => void applyResize(pendingResize)}>
                Resize to {labelTier(pendingResize)}
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        One confirmation for the whole series. It has to list every size the
        sweep passes through, because after this click the app resizes live
        capacity several times unattended.
      */}
      {pendingSweep && (
        <div className={s.modalScrim} role="presentation" onClick={() => setPendingSweep(null)}>
          <div
            className={s.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="sweep-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="sweep-title">
              {pendingSweep.plan.steps.length === 1
                ? `Resize and measure on ${labelTier(pendingSweep.plan.steps[0].tier)}?`
                : `Sweep ${pendingSweep.plan.steps.length} engine sizes?`}
            </h2>
            <p>
              This measures {chosen.length} {chosen.length === 1 ? 'search' : 'searches'} across{' '}
              {pendingSweep.defs.length} {pendingSweep.defs.length === 1 ? 'window' : 'windows'} on:
            </p>
            <ol className={s.sweepSteps}>
              {pendingSweep.plan.steps.map((step) => (
                <li key={step.tier}>
                  <b>{labelTier(step.tier)}</b>
                  {isFederated(step.tier)
                    ? ' — federated executors, no resize'
                    : step.needsResize
                      ? ' — resize first'
                      : ' — already the current size'}
                  {` · ${step.searches} ${step.searches === 1 ? 'search' : 'searches'}`}
                </li>
              ))}
            </ol>
            <p>
              <b>{pendingSweep.plan.resizes}</b>{' '}
              {pendingSweep.plan.resizes === 1 ? 'resize' : 'resizes'} of live Lakehouse capacity for{' '}
              <b>{engine?.id}</b>, <b>{pendingSweep.plan.totalRuns}</b> runs in total, roughly{' '}
              <b>
                {formatDuration(
                  estimateSweepSeconds({
                    plan: pendingSweep.plan,
                    medianRunMs,
                    resizeSettleSec: RESIZE_SETTLE_SEC,
                  }),
                )}
              </b>
              . Billing and query performance change for every consumer of this engine while it runs,
              not just this lab. The estimate assumes larger sizes are no faster, so it is an upper
              bound.
            </p>
            {pendingSweep.plan.byRequest.length > 0 && (
              <p>
                <b>{pendingSweep.plan.byRequest.map(labelTier).join(' and ')}</b>{' '}
                {pendingSweep.plan.byRequest.length === 1 ? 'is' : 'are'} available by request. If
                Cribl has not enabled{' '}
                {pendingSweep.plan.byRequest.length === 1 ? 'it' : 'them'} for this org the resize is
                rejected and the sweep stops there — earlier sizes stay measured.
              </p>
            )}
            {pendingSweep.plan.unconfirmed.length > 0 && (
              <p>
                Cribl documents{' '}
                {pendingSweep.plan.unconfirmed.map((tier) => labelTier(tier)).join(', ')} but not the
                literal API value, so this app sends{' '}
                {pendingSweep.plan.unconfirmed.map((tier) => (
                  <code key={tier}>{tier}</code>
                ))}
                . A wrong guess fails cleanly with a rejection.
              </p>
            )}
            <p>
              {config.restoreTierAfterSweep
                ? `When it finishes — or if you stop it — the engine is resized back to ${labelTier(activeTier)}.`
                : `The engine will be LEFT on ${labelTier(pendingSweep.plan.steps[pendingSweep.plan.steps.length - 1].tier)} afterwards, because "restore afterwards" is off.`}
            </p>
            <div className={s.modalActions}>
              <button onClick={() => setPendingSweep(null)}>Cancel</button>
              <button
                className={s.primary}
                onClick={() => {
                  const { plan, defs } = pendingSweep;
                  setPendingSweep(null);
                  void runSession(defs, plan);
                }}
              >
                Start ({pendingSweep.plan.totalRuns} runs)
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
