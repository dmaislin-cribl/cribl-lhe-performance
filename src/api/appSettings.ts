/**
 * App persistence via the Cribl KV store.
 *
 * Config and run history are kept under SEPARATE keys. They were one blob,
 * which meant every keystroke in the dataset or query field rewrote the entire
 * run log, and every finished run rewrote the config. Splitting them keeps a
 * config edit cheap and stops the two writers from clobbering each other.
 *
 * Uses the local `kv` helper rather than @criblio/app-utils/settings, which
 * hardcodes a single key — see kv.ts for the details.
 */

import { kvGet, kvPut } from './kv';
import type { BudgetStatistic } from './perfStats';
import { normalizeSessions, settleStale, type SessionRecord } from './sessions';
import { canonicalTier } from './tiers';
import { DEFAULT_WINDOWS, normalizeWindows, type WindowDef } from './windows';

const CONFIG_KEY = 'settings';
const RUNS_KEY = 'runs';

/** Newest-first run history is capped so the KV value cannot grow without bound. */
export const MAX_RUNS = 2000;

export interface LabConfig {
  /** Default timed runs per search per window, for any window without an override. */
  repetitions: number;
  /**
   * Per-window timed run counts, keyed by window id, overriding `repetitions`.
   *
   * Sparse on purpose: a window absent from this map uses the default, so raising
   * the default still raises every window the operator never singled out.
   *
   * The reason to vary it at all is that the windows do not cost the same. A
   * 14-day window on a small engine can take minutes per run, so 20 repetitions of
   * it is an hour of wall clock, while 20 repetitions of the 1-hour window is a
   * couple of minutes. Being forced to pick one number for both means either
   * over-sampling the cheap windows or giving up a p95 on the expensive ones.
   */
  windowRepetitions: Record<string, number>;
  /**
   * The time windows every run measures, ascending by span. Editable, because the
   * right ramp depends on the dataset: two weeks is not measurable against four
   * days of retention, and an hour does not stress a 14 TB/day engine. See
   * windows.ts for why the set is not a fixture.
   */
  windows: WindowDef[];
  cacheState: string;
  /**
   * Search worker group. policies.yml is written for any `:gid`, so this is
   * not required to be `default_search` — it was only hardcoded.
   */
  searchGroup: string;
  /**
   * Engine sizes the next run sweeps across, smallest first. Persisted because a
   * sweep is a long unattended job an operator repeats — re-ticking six sizes
   * before every run is how one gets missed and a comparison ends up with a
   * hole in it.
   */
  sweepTiers: string[];
  /**
   * Resize the engine back to the size it started at once a sweep finishes.
   * Default on: a sweep that ends on the largest size leaves live Lakehouse
   * capacity — and its bill — parked at the top until somebody notices.
   */
  restoreTierAfterSweep: boolean;
  /**
   * Acceptance budget in milliseconds, or null for none. This is the QA gate:
   * the number a release is allowed to take before it is a regression.
   */
  budgetMs: number | null;
  /** Which percentile the budget is applied to. Tails are what budgets are for. */
  budgetStatistic: BudgetStatistic;
}

export interface RunRecord {
  id: string;
  jobId: string;
  /** Engine tier the run executed on. */
  engine: string;
  /** Window id, e.g. "T3". */
  window: string;
  /** Absolute bounds actually searched, epoch seconds. */
  earliestSec: number;
  latestSec: number;
  /** Start to finish, server-side: queue wait plus execution, ms. The headline. */
  totalMs: number | null;
  /** Authoritative server-side engine execution time, ms. */
  engineMs: number | null;
  /** Queue wait before execution, ms. */
  queueMs: number | null;
  /** Browser wall clock, ms. Diagnostic context, not the headline metric. */
  clientMs: number | null;
  /** True matching event count, independent of the sample fetch limit. */
  totalEventCount: number | null;
  status: 'Success' | 'Error';
  notes: string;
  /** False for warm-up runs, which are excluded from every statistic. */
  measured: boolean;
  at: string;
  /**
   * Provenance. Without these, editing the query silently makes every earlier
   * timing unattributable — the run log would show numbers produced by a query
   * that is no longer on screen. The hash keys into `RunLog.queries`, so the
   * full text is stored once rather than per run.
   */
  dataset: string;
  queryHash: string;
  searchGroup: string;
  /**
   * Which saved search produced this run, and its name at the time. The id can
   * be deleted from the library and the name can be edited, so neither is
   * authoritative — `queryHash` is. They exist so a run log still reads as
   * "which test case was this" rather than a bare hash.
   */
  searchId: string;
  searchName: string;
  /**
   * The named run session this run belongs to, and its name at the time. Same
   * discipline as the search fields: the id joins to `RunLog.sessions`, the name
   * is a label that survives the session being deleted. Empty for runs recorded
   * before sessions existed.
   */
  sessionId: string;
  sessionName: string;
}

export interface RunLog {
  runs: RunRecord[];
  /** queryHash -> full search logic, for runs recorded under an older query. */
  queries: Record<string, string>;
  /**
   * Named run sessions. Stored in this record rather than a key of their own so
   * a run and its session are written together and cannot diverge — see
   * sessions.ts.
   */
  sessions: SessionRecord[];
}

export const DEFAULT_CONFIG: LabConfig = {
  repetitions: 20,
  // Empty means every window uses the default. See LabConfig.windowRepetitions.
  windowRepetitions: {},
  windows: [...DEFAULT_WINDOWS],
  cacheState: 'Unknown',
  searchGroup: 'default_search',
  /**
   * Empty means "whatever size the engine is right now" — the workbench falls back
   * to the live `tierSize` rather than a hardcoded size. That is both the safe
   * default (a fresh install is zero clicks from resizing a live engine, not one)
   * and the useful one: the size the org actually runs is the size an operator
   * came here to measure. Ticking any box pins the selection instead.
   */
  sweepTiers: [],
  restoreTierAfterSweep: true,
  budgetMs: null,
  budgetStatistic: 'p95',
};

const BUDGET_STATISTICS: BudgetStatistic[] = ['p50', 'p90', 'p95', 'p99'];

export const EMPTY_RUN_LOG: RunLog = { runs: [], queries: {}, sessions: [] };

/**
 * Short stable digest of the search logic (djb2, base36). Only needs to
 * distinguish one query revision from another within this app, so a
 * non-cryptographic hash keeps it synchronous and dependency-free.
 */
export function hashQuery(query: string): string {
  let hash = 5381;
  for (let index = 0; index < query.length; index += 1) {
    hash = ((hash << 5) + hash + query.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length ? value : fallback;
}

/** Clamp to the range the repetition inputs accept, or null if it is not a count. */
function asRepetitions(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) return null;
  return Math.min(200, Math.floor(value));
}

/**
 * Timed runs for one window: its override, or the default when it has none.
 *
 * Every caller that plans, estimates or counts runs must go through this rather
 * than reading `config.repetitions` — that is what keeps the progress line, the
 * plan estimate and the loop that actually runs from disagreeing about how many
 * runs a window gets.
 */
export function repetitionsFor(config: LabConfig, windowId: string): number {
  return config.windowRepetitions[windowId] ?? config.repetitions;
}

/** Stored values are merged over defaults, so a new field needs no migration. */
export function normalizeConfig(stored: Partial<LabConfig> | null): LabConfig {
  return {
    repetitions: asRepetitions(stored?.repetitions) ?? DEFAULT_CONFIG.repetitions,
    // Each entry is validated independently: one unusable override is dropped and
    // that window falls back to the default, rather than discarding the whole map
    // and silently resetting windows the operator did set deliberately.
    windowRepetitions: Object.fromEntries(
      Object.entries(stored?.windowRepetitions ?? {}).flatMap(([id, value]) => {
        const count = asRepetitions(value);
        return count === null || !id.trim() ? [] : [[id, count] as const];
      }),
    ),
    windows: normalizeWindows(stored?.windows),
    cacheState: asString(stored?.cacheState, DEFAULT_CONFIG.cacheState),
    searchGroup: asString(stored?.searchGroup, DEFAULT_CONFIG.searchGroup),
    // Canonicalised and deduplicated on the way in, so a stored alias cannot
    // make one size appear as two in the sweep plan.
    sweepTiers: Array.isArray(stored?.sweepTiers)
      ? [
          ...new Set(
            stored.sweepTiers
              .filter((tier): tier is string => typeof tier === 'string' && tier.trim().length > 0)
              .map(canonicalTier),
          ),
        ]
      : [...DEFAULT_CONFIG.sweepTiers],
    restoreTierAfterSweep:
      typeof stored?.restoreTierAfterSweep === 'boolean'
        ? stored.restoreTierAfterSweep
        : DEFAULT_CONFIG.restoreTierAfterSweep,
    // A non-positive budget is treated as no budget rather than as a gate
    // nothing can pass.
    budgetMs:
      typeof stored?.budgetMs === 'number' && Number.isFinite(stored.budgetMs) && stored.budgetMs > 0
        ? Math.round(stored.budgetMs)
        : null,
    budgetStatistic:
      stored?.budgetStatistic && BUDGET_STATISTICS.includes(stored.budgetStatistic)
        ? stored.budgetStatistic
        : DEFAULT_CONFIG.budgetStatistic,
  };
}

/**
 * Cap the history and drop query texts nothing references any more, so the
 * lookup table cannot outlive the runs that needed it.
 *
 * Sessions are kept even when pruning removed their last run: a session the
 * operator named and may have shown a customer should not disappear because the
 * log rolled over, and a named session with zero runs reads honestly as one
 * whose measurements have aged out. Only sessions that never recorded anything
 * *and* are not in the log's session list get dropped, which is to say none.
 */
export function pruneRunLog(log: RunLog, max = MAX_RUNS): RunLog {
  const runs = log.runs.slice(0, max);
  const live = new Set(runs.map((run) => run.queryHash));
  const queries: Record<string, string> = {};
  for (const [hash, text] of Object.entries(log.queries)) {
    if (live.has(hash)) queries[hash] = text;
  }
  return { runs, queries, sessions: log.sessions };
}

export async function loadConfig(): Promise<LabConfig> {
  return normalizeConfig(await kvGet<Partial<LabConfig>>(CONFIG_KEY));
}

/**
 * Written as a merge over whatever is stored, not a replacement. `query` used to
 * live in this record and is still the seed for the search library on a
 * pre-library install (see searches.ts) — a plain overwrite from a Settings save
 * would destroy it before the library was ever built.
 */
export async function saveConfig(config: LabConfig): Promise<void> {
  const stored = (await kvGet<Record<string, unknown>>(CONFIG_KEY)) ?? {};
  await kvPut(CONFIG_KEY, { ...stored, ...config });
}

export async function loadRunLog(): Promise<RunLog> {
  const stored = await kvGet<Partial<RunLog>>(RUNS_KEY);
  return {
    runs: Array.isArray(stored?.runs) ? stored.runs : [],
    queries:
      stored?.queries && typeof stored.queries === 'object' ? (stored.queries as Record<string, string>) : {},
    // A session still marked `running` was interrupted by a reload or a closed
    // tab, never by finishing — settle it so its partial set is not read as whole.
    sessions: settleStale(normalizeSessions(stored?.sessions)),
  };
}

export async function saveRunLog(log: RunLog): Promise<void> {
  await kvPut(RUNS_KEY, pruneRunLog(log));
}
