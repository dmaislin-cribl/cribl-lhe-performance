/**
 * Federated search: what a job reports about where and how it ran, and which
 * saved searches belong to which measurement target.
 *
 * ## There is no "run this federated" switch
 *
 * Cribl Search decides where a query executes from the datasets it names. A
 * `cribl_search` (Lakehouse) dataset runs on the Lakehouse engine; S3, Azure
 * Blob, GCS, Cribl Lake, Edge, API and the other providers run on the federated
 * executors and are billed per CPU-second. So "measure on Federated" cannot mean
 * sending a flag — it means running the searches whose datasets are federated,
 * and checking afterwards that they really were.
 *
 * That gives two halves, both here as pure functions:
 *
 *   - **Before a run**, `classifySearch` reads the dataset catalog and sorts each
 *     selected search into lakehouse / federated / mixed / unknown, so a size
 *     sweep does not spend an hour timing an S3 search that no engine size can
 *     speed up, and the Federated step does not time a Lakehouse search and call
 *     it federated.
 *   - **After a run**, `parseJobInsight` reads the job record the server keeps,
 *     and `attributeRun` labels the run by what the server says happened, not by
 *     what was planned. The catalog can be stale, a wildcard can resolve to
 *     anything, and a measurement filed under the wrong target corrupts a
 *     comparison silently — so the server's account wins.
 *
 * ## What the job record carries (observed, not documented)
 *
 * `GET /search/jobs/{id}` on a finished job returns, beside the timings:
 *
 *   - `metadata.computeTypes` — `{ local: n }` for Lakehouse, `{ v1: n }` or
 *     `{ v2: n }` for federated. The cleanest single signal of where it ran.
 *   - `metadata.providerTypes` — `cribl_search`, `s3`, `azure_blob`, `gcs`,
 *     `cribl_edge`, `api_http`, `cribl_lake` …
 *   - `cpuMetrics.billableCPUSeconds` — what the search costs. Zero on Lakehouse,
 *     which is billed by engine size instead. **Only on the job list**
 *     (`GET /search/jobs?earliest=…`): the single-job read never carries
 *     `cpuMetrics`, however long after completion it is made. Checked live — the
 *     list has it within a second of completion.
 *   - `cpuMetrics.executorsCPUSeconds` — one key per executor plus `COORDINATOR`,
 *     so the key count is the fan-out.
 *   - `stages[].cacheStatusByDatasetId` — `{ usedCache, cacheStatus }` per dataset.
 *
 * ## Waiting for compute
 *
 * `pendingComputeNodeStatuses` `{ countCold, countWarm }` is a **live** count of
 * the compute nodes a running job is still waiting for — not a tally of how it
 * started. It appears on the job record and the results header while the job
 * runs, and reads `0/0` once it finishes, so a read taken at the end reports
 * "no wait" for every job. (Observed: an Azure Blob job showed one pending node
 * for ~95 s of a 101 s run, then 0/0 at completion.) It has to be sampled during
 * the run, which `trackComputeWait` does from the polls the runner already makes.
 *
 * That wait is the single biggest source of federated variance — a measured S3
 * search took 29.5 s waiting, then ~1.1 s warm — so it is recorded per run and
 * Analysis can split on it. Two limits: it is sampled at the poll cadence, so a
 * wait shorter than one poll interval can be missed, and compute v1 jobs do not
 * report the field at all, which is recorded as "not reported", never "no wait".
 *
 * Every field is optional in practice — the lakehouse header omits the compute
 * node statuses entirely — so every parser here returns null rather than zero
 * for "not reported". Zero cold nodes and "the server did not say" are
 * different findings.
 */

import { deriveDataset } from './searches';
import { FEDERATED, isFederated } from './tiers';

/** Where a job executed, according to the server. Empty when it did not say. */
export type ExecutionPath = 'lakehouse' | 'federated' | 'mixed' | '';

/** Where a saved search is expected to execute, from the dataset catalog. */
export type SearchPlacement = 'lakehouse' | 'federated' | 'mixed' | 'unknown';

export interface JobInsight {
  path: ExecutionPath;
  /** Billable CPU, ms — kept in ms so every existing seconds formatter reads it. */
  billableCpuMs: number | null;
  /** Total CPU across coordinator and executors, ms. */
  totalCpuMs: number | null;
  /** Executors the search fanned out to, coordinator excluded. */
  executors: number | null;
  /** Distinct provider types the job touched, sorted. */
  providerTypes: string[];
  /** Distinct compute types (`local`, `v1`, `v2`), sorted. */
  computeTypes: string[];
  /** `hit`, `miss`, `mixed` across the datasets the job read, or '' unreported. */
  cache: 'hit' | 'miss' | 'mixed' | '';
}

/** Compute-node waiting observed across one job's polls. */
export interface ComputeWait {
  /** Whether the job ever reported pending node statuses. False on compute v1 and Lakehouse. */
  reported: boolean;
  /** Most cold / warm nodes the job was waiting for at once. */
  peakCold: number;
  peakWarm: number;
  /** Time spent with at least one node pending, ms, at poll resolution. */
  waitMs: number;
}

export const NO_COMPUTE_WAIT: ComputeWait = { reported: false, peakCold: 0, peakWarm: 0, waitMs: 0 };

export const EMPTY_INSIGHT: JobInsight = {
  path: '',
  billableCpuMs: null,
  totalCpuMs: null,
  executors: null,
  providerTypes: [],
  computeTypes: [],
  cache: '',
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Keys of a count map like `{ s3: 1 }`, sorted so two runs compare equal. */
function keysOf(value: unknown): string[] {
  const map = record(value);
  return map ? Object.keys(map).sort() : [];
}

/** Lakehouse is `local`; anything else that is reported is a federated compute type. */
export function pathFromComputeTypes(computeTypes: string[]): ExecutionPath {
  if (!computeTypes.length) return '';
  const local = computeTypes.some((type) => type === 'local');
  const remote = computeTypes.some((type) => type !== 'local');
  if (local && remote) return 'mixed';
  return local ? 'lakehouse' : 'federated';
}

/**
 * Read the parts of a finished job record this app reports. Accepts either the
 * bare job or the `{ items: [job] }` envelope the jobs endpoint returns.
 */
export function parseJobInsight(payload: unknown): JobInsight {
  const outer = record(payload);
  if (!outer) return EMPTY_INSIGHT;
  const job = Array.isArray(outer.items) ? record(outer.items[0]) : outer;
  if (!job) return EMPTY_INSIGHT;

  const metadata = record(job.metadata);
  const computeTypes = keysOf(metadata?.computeTypes);
  const providerTypes = keysOf(metadata?.providerTypes);

  const cpu = record(job.cpuMetrics);
  const billable = finiteNumber(cpu?.billableCPUSeconds);
  const total = finiteNumber(cpu?.totalCPUSeconds);
  const perExecutor = record(cpu?.executorsCPUSeconds);
  const executors = perExecutor
    ? Object.keys(perExecutor).filter((key) => key !== 'COORDINATOR').length
    : null;

  const cacheFlags: boolean[] = [];
  for (const stage of Array.isArray(job.stages) ? job.stages : []) {
    const byDataset = record(record(stage)?.cacheStatusByDatasetId);
    for (const entry of Object.values(byDataset ?? {})) {
      const flag = record(entry)?.usedCache;
      if (typeof flag === 'boolean') cacheFlags.push(flag);
    }
  }
  const cache: JobInsight['cache'] = !cacheFlags.length
    ? ''
    : cacheFlags.every(Boolean)
      ? 'hit'
      : cacheFlags.some(Boolean)
        ? 'mixed'
        : 'miss';

  return {
    path: pathFromComputeTypes(computeTypes),
    // Rounded to whole ms: the API reports float-noise seconds (56.05499999999999).
    billableCpuMs: billable === null ? null : Math.round(billable * 1000),
    totalCpuMs: total === null ? null : Math.round(total * 1000),
    executors,
    providerTypes,
    computeTypes,
    cache,
  };
}

/** Pending node counts from a job record, or null when it does not carry them. */
export function readPendingNodes(job: unknown): { cold: number; warm: number } | null {
  const statuses = record(record(job)?.pendingComputeNodeStatuses);
  if (!statuses) return null;
  return { cold: finiteNumber(statuses.countCold) ?? 0, warm: finiteNumber(statuses.countWarm) ?? 0 };
}

/**
 * Fold one poll into the running tally. `sinceLastMs` is the time since the
 * previous poll: a job seen waiting is credited with that whole interval, which
 * is the best a sampled signal can say.
 */
export function trackComputeWait(state: ComputeWait, job: unknown, sinceLastMs: number): ComputeWait {
  const pending = readPendingNodes(job);
  if (!pending) return state;
  const waiting = pending.cold + pending.warm > 0;
  return {
    reported: true,
    peakCold: Math.max(state.peakCold, pending.cold),
    peakWarm: Math.max(state.peakWarm, pending.warm),
    waitMs: state.waitMs + (waiting ? Math.max(0, Math.round(sinceLastMs)) : 0),
  };
}

/**
 * Whether a run waited for compute nodes. Null when the job never reported node
 * statuses — Lakehouse and compute v1 jobs do not — so "unknown" never reads as
 * "no wait".
 */
export function waitedForCompute(waitMs: number | null | undefined): boolean | null {
  return typeof waitMs === 'number' ? waitMs > 0 : null;
}

/** The job record for one id, out of a job-list payload. */
export function findJob(payload: unknown, jobId: string): Record<string, unknown> | null {
  const items = record(payload)?.items;
  if (!Array.isArray(items)) return null;
  return (items.map(record).find((item) => item?.id === jobId) ?? null) as Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Dataset catalog
// ---------------------------------------------------------------------------

/** The fields of a dataset definition classification needs. */
export interface DatasetDef {
  id: string;
  type?: string;
  provider?: string;
  /** Member datasets, on a `cribl_meta` dataset such as `default`. */
  datasets?: string[];
}

export type DatasetCatalog = Map<string, DatasetDef>;

export function buildCatalog(items: unknown): DatasetCatalog {
  const catalog: DatasetCatalog = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    const entry = record(item);
    if (!entry || typeof entry.id !== 'string') continue;
    catalog.set(entry.id, {
      id: entry.id,
      type: typeof entry.type === 'string' ? entry.type : undefined,
      provider: typeof entry.provider === 'string' ? entry.provider : undefined,
      datasets: Array.isArray(entry.datasets)
        ? entry.datasets.filter((member): member is string => typeof member === 'string')
        : undefined,
    });
  }
  return catalog;
}

/**
 * Lakehouse or federated for one dataset id, or null when the catalog does not
 * know it. A `cribl_meta` dataset is resolved through its members.
 */
export function classifyDataset(
  catalog: DatasetCatalog,
  id: string,
  seen: Set<string> = new Set(),
): SearchPlacement | null {
  const def = catalog.get(id);
  if (!def || seen.has(id)) return null;
  seen.add(id);
  if (def.type === 'cribl_meta') {
    const placements = (def.datasets ?? []).map((member) => classifyDataset(catalog, member, seen));
    return combine(placements);
  }
  return def.type === 'cribl_search' || def.provider === 'lakehouse' ? 'lakehouse' : 'federated';
}

function combine(placements: (SearchPlacement | null)[]): SearchPlacement {
  if (!placements.length || placements.some((entry) => entry === null || entry === 'unknown')) {
    return 'unknown';
  }
  const set = new Set(placements);
  if (set.has('mixed') || set.size > 1) return 'mixed';
  return [...set][0] as SearchPlacement;
}

/**
 * Where a saved search is expected to run. `unknown` covers every case the text
 * cannot settle on its own — no `dataset=` term, a wildcard, an id the catalog
 * does not list, or no catalog at all — and an unknown search is run on every
 * target and attributed afterwards by `attributeRun`.
 */
export function classifySearch(text: string, catalog: DatasetCatalog | null): SearchPlacement {
  if (!catalog || !catalog.size) return 'unknown';
  const named = deriveDataset(text);
  if (!named || /[*?]/.test(named)) return 'unknown';
  return combine(
    named
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => classifyDataset(catalog, id)),
  );
}

/**
 * Whether a search should run on a target. Lakehouse searches on sizes,
 * federated searches on Federated; mixed and unknown on both, because either
 * half could be the one being measured and the server's report settles it.
 */
export function runsOnTarget(placement: SearchPlacement, target: string): boolean {
  if (placement === 'mixed' || placement === 'unknown') return true;
  return isFederated(target) ? placement === 'federated' : placement === 'lakehouse';
}

/**
 * The target a run is filed under, plus a note when that differs from the plan.
 *
 * The server's account of where the job ran beats the plan: a run the server
 * says was federated is a Federated measurement whichever step launched it, and
 * a run the server says was local is a measurement of whatever size the engine
 * was on at the time. A mixed or unreported path keeps the planned target.
 */
export function attributeRun(input: {
  planned: string;
  path: ExecutionPath;
  /** The Lakehouse size the engine was on when the run executed. */
  engineTier: string;
}): { target: string; note: string } {
  const { planned, path, engineTier } = input;
  if (path === 'federated' && !isFederated(planned)) {
    return {
      target: FEDERATED,
      note: 'Server reports federated execution; filed under Federated, not the engine size.',
    };
  }
  if (path === 'lakehouse' && isFederated(planned)) {
    return {
      target: engineTier,
      note: 'Server reports Lakehouse execution; filed under the engine size, not Federated.',
    };
  }
  if (path === 'mixed') {
    return {
      target: planned,
      note: 'Read both Lakehouse and federated datasets; the time covers both.',
    };
  }
  return { target: planned, note: '' };
}

/** "s3 · v2 · waited 28.0s for compute" — the compact line a run table can afford. */
export function describeCompute(fields: {
  providerTypes?: string[];
  computeTypes?: string[];
  computeWaitMs?: number | null;
  cache?: string;
}): string {
  const parts: string[] = [];
  if (fields.providerTypes?.length) parts.push(fields.providerTypes.join('+'));
  const remote = (fields.computeTypes ?? []).filter((type) => type !== 'local');
  if (remote.length) parts.push(remote.join('+'));
  const waited = waitedForCompute(fields.computeWaitMs);
  if (waited !== null) {
    parts.push(waited ? `waited ${((fields.computeWaitMs ?? 0) / 1000).toFixed(1)}s for compute` : 'no compute wait');
  }
  if (fields.cache === 'hit') parts.push('cache hit');
  return parts.join(' · ');
}
