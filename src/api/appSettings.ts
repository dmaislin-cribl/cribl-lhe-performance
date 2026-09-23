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

const CONFIG_KEY = 'settings';
const RUNS_KEY = 'runs';

/** Newest-first run history is capped so the KV value cannot grow without bound. */
export const MAX_RUNS = 2000;

export interface LabConfig {
  dataset: string;
  query: string;
  repetitions: number;
  cacheState: string;
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
}

export const DEFAULT_QUERY =
  'where hostname has "baidu" or hostname has "qq" or hostname has "aliyuncs"\n' +
  '   or hostname has "yixinfa" or hostname has "pingxiaobao"\n' +
  '   or hostname has "tougeping" or hostname has "eselltech"\n' +
  '| summarize events = count() by hostname\n' +
  '| sort by events desc';

export const DEFAULT_CONFIG: LabConfig = {
  dataset: 'Fortinet_Syslog',
  query: DEFAULT_QUERY,
  repetitions: 20,
  cacheState: 'Unknown',
};

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length ? value : fallback;
}

/** Stored values are merged over defaults, so a new field needs no migration. */
export function normalizeConfig(stored: Partial<LabConfig> | null): LabConfig {
  return {
    dataset: asString(stored?.dataset, DEFAULT_CONFIG.dataset),
    query: asString(stored?.query, DEFAULT_CONFIG.query),
    repetitions:
      typeof stored?.repetitions === 'number' && stored.repetitions > 0
        ? Math.min(200, Math.floor(stored.repetitions))
        : DEFAULT_CONFIG.repetitions,
    cacheState: asString(stored?.cacheState, DEFAULT_CONFIG.cacheState),
  };
}

export async function loadConfig(): Promise<LabConfig> {
  return normalizeConfig(await kvGet<Partial<LabConfig>>(CONFIG_KEY));
}

export async function saveConfig(config: LabConfig): Promise<void> {
  await kvPut(CONFIG_KEY, config);
}

export async function loadRuns(): Promise<RunRecord[]> {
  const stored = await kvGet<{ runs?: RunRecord[] }>(RUNS_KEY);
  return Array.isArray(stored?.runs) ? stored.runs : [];
}

export async function saveRuns(runs: RunRecord[]): Promise<void> {
  await kvPut(RUNS_KEY, { runs: runs.slice(0, MAX_RUNS) });
}
