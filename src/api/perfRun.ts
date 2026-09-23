/**
 * Timed search-job runner for benchmarking.
 *
 * Why this exists instead of `runQuery` from @criblio/app-utils/search:
 * `runQuery` is the right tool for fetching data, but it is the wrong
 * instrument for measuring engine performance.
 *
 *   - It polls on a 400 ms interval, so any wall-clock timing taken around it
 *     is quantised to 400 ms — larger than the gap between engine tiers on
 *     short windows.
 *   - Its 48 s internal timeout is not overridable, so wide windows on a
 *     small engine fail as timeouts rather than producing a measurement.
 *   - It discards the first line of the results payload, which is exactly the
 *     line carrying the server's authoritative job timings and true event
 *     counts.
 *
 * The search API returns, as line 0 of `GET /search/jobs/{id}/results`:
 *
 *   {"isFinished":true,"limit":5,"offset":0,"persistedEventCount":5,
 *    "totalEventCount":5,
 *    "job":{"id":"...","earliest":1790164800,"latest":1790168400,
 *           "timeCreated":1790175453932,"timeStarted":1790175454048,
 *           "timeCompleted":1790175455020,"status":"completed"}}
 *
 * `timeCompleted - timeStarted` is the engine's own execution time, measured
 * server-side. It excludes queueing, HTTP round-trips, our poll cadence and
 * result transfer — all of which a browser stopwatch would fold in. That is
 * the number this app reports.
 */

import { apiUrl } from './cribl';

/** AGENTS.md: search endpoints use the `default_search` group. */
export const SEARCH_BASE = '/m/default_search/search';

export interface JobTimings {
  id: string;
  status: string;
  timeCreated?: number;
  timeStarted?: number;
  timeCompleted?: number;
  earliest?: number | string;
  latest?: number | string;
}

export interface ResultsHeader {
  isFinished?: boolean;
  totalEventCount?: number;
  persistedEventCount?: number;
  job?: JobTimings;
}

export interface TimedRun {
  jobId: string;
  /** Terminal job status as reported by the server. */
  status: string;
  /** Authoritative engine execution time, ms. Null if the server omitted it. */
  engineMs: number | null;
  /** Time spent queued before execution began, ms. */
  queueMs: number | null;
  /** Browser wall clock for the whole exchange. Diagnostic only — never the headline metric. */
  clientMs: number;
  /** True matching event count, independent of the result fetch limit. */
  totalEventCount: number | null;
  /** Rows actually transferred (capped by `sampleRows`). */
  returnedRows: number;
  rows: Record<string, unknown>[];
  /** Bounds as the server echoed them, so a misread window is visible in the log. */
  echoedEarliest: number | string | null;
  echoedLatest: number | string | null;
}

export interface TimedRunOptions {
  earliestSec: number;
  latestSec: number;
  /**
   * How many rows to actually transfer. Kept small by default: true counts
   * come from the header, so pulling a large page only adds transfer time and
   * result-store pressure without improving the measurement.
   */
  sampleRows?: number;
  /** Poll cadence, ms. Does not affect measurement accuracy — timings are server-side. */
  pollIntervalMs?: number;
  /** Give wide windows on small engines room to finish. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

export class PerfRunError extends Error {
  readonly jobId?: string;
  constructor(message: string, jobId?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'PerfRunError';
    this.jobId = jobId;
  }
}

function base(): string {
  return `${apiUrl().replace(/\/$/, '')}${SEARCH_BASE}`;
}

function firstItem(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object') return {};
  const record = payload as Record<string, unknown>;
  if (Array.isArray(record.items)) {
    const item = record.items[0];
    return item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
  }
  return record;
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'canceled';
}

/**
 * Split a results payload into its metadata header and its event rows.
 *
 * Exported for unit testing — this parsing is the load-bearing part of the
 * measurement and must not depend on a live deployment to verify.
 */
export function parseResultsPayload(raw: string): {
  header: ResultsHeader;
  rows: Record<string, unknown>[];
} {
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  if (!lines.length) return { header: {}, rows: [] };

  let header: ResultsHeader = {};
  try {
    const parsed: unknown = JSON.parse(lines[0]);
    // The header is the only line carrying `job`/`totalEventCount`. If line 0
    // looks like an event instead, treat the payload as headerless rather than
    // silently dropping a row.
    if (parsed && typeof parsed === 'object' && ('job' in parsed || 'totalEventCount' in parsed)) {
      header = parsed as ResultsHeader;
    } else {
      return { header: {}, rows: parseRows(lines, 0) };
    }
  } catch {
    return { header: {}, rows: parseRows(lines, 0) };
  }
  return { header, rows: parseRows(lines, 1) };
}

function parseRows(lines: string[], from: number): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (let index = from; index < lines.length; index += 1) {
    try {
      const parsed: unknown = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rows.push(parsed as Record<string, unknown>);
      }
    } catch {
      // A truncated trailing line is not worth failing a whole measurement over.
    }
  }
  return rows;
}

/** Non-negative difference, or null when either endpoint is missing. */
function span(from?: number, to?: number): number | null {
  if (typeof from !== 'number' || typeof to !== 'number') return null;
  const value = to - from;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new PerfRunError('Run canceled'));
    };
    if (signal?.aborted) {
      clearTimeout(timer);
      reject(new PerfRunError('Run canceled'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function call(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(`${base()}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new PerfRunError(`${method} ${path} failed (${response.status}): ${text.slice(0, 300)}`);
  }
  return text;
}

/**
 * Run one search job and report the engine's own execution time.
 *
 * Bounds must already be absolute (see windows.ts) so that repetitions of the
 * same window are guaranteed to hit identical data.
 */
export async function runTimedQuery(query: string, options: TimedRunOptions): Promise<TimedRun> {
  const {
    earliestSec,
    latestSec,
    sampleRows = 200,
    pollIntervalMs = 500,
    timeoutMs = 600_000,
    signal,
  } = options;

  const clientStart = performance.now();
  const created = firstItem(
    JSON.parse(
      await call('POST', '/jobs', { query, earliest: earliestSec, latest: latestSec }, signal),
    ),
  );
  const jobId = typeof created.id === 'string' ? created.id : '';
  if (!jobId) throw new PerfRunError('Search job response did not include an id');

  const jobPath = `/jobs/${encodeURIComponent(jobId)}`;
  // Cancel server-side on abort so we release the worker-pool slot. Fired
  // without the aborted signal, or the cancellation would abort itself.
  const cancel = () => void call('DELETE', jobPath).catch(() => undefined);
  signal?.addEventListener('abort', cancel, { once: true });

  try {
    let status = typeof created.status === 'string' ? created.status : 'queued';
    const deadline = Date.now() + timeoutMs;
    while (!isTerminal(status)) {
      if (Date.now() >= deadline) {
        cancel();
        throw new PerfRunError(`Job ${jobId} exceeded the ${timeoutMs} ms run budget`, jobId);
      }
      await sleep(pollIntervalMs, signal);
      const polled = firstItem(JSON.parse(await call('GET', jobPath, undefined, signal)));
      status = typeof polled.status === 'string' ? polled.status : status;
    }

    // Fetch results even on a non-completed status: the header still carries
    // the timings, which is what makes a failure diagnosable.
    const raw = await call(
      'GET',
      `${jobPath}/results?offset=0&limit=${Math.max(1, sampleRows)}`,
      undefined,
      signal,
    );
    const { header, rows } = parseResultsPayload(raw);
    const job: Partial<JobTimings> = header.job ?? {};
    const clientMs = performance.now() - clientStart;

    if (status !== 'completed') {
      throw new PerfRunError(`Job ${jobId} ended with status: ${status}`, jobId);
    }

    return {
      jobId,
      status,
      engineMs: span(job.timeStarted, job.timeCompleted),
      queueMs: span(job.timeCreated, job.timeStarted),
      clientMs,
      totalEventCount: typeof header.totalEventCount === 'number' ? header.totalEventCount : null,
      returnedRows: rows.length,
      rows,
      echoedEarliest: job.earliest ?? null,
      echoedLatest: job.latest ?? null,
    };
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
