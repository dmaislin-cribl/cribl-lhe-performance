/**
 * Per-session results: the numbers one press of a run button actually produced.
 *
 * Sessions used to be metadata only — name, counts, outcome — so the one question
 * an operator has about a session ("what did it measure?") was answerable only by
 * exporting its CSV or by going to Compare and reproducing the right filters from
 * memory. That is worst for the sessions that need it most: a stopped one, where
 * the point is *which* cells got measured before it was interrupted.
 *
 * So this assembles a cell per search × window × engine size, with the sample
 * behind it stated rather than implied. Rules that hold it honest:
 *
 *   - Cells are keyed on `engine` from the run, not on the session's starting
 *     tier. A session can sweep sizes, and folding two sizes into one median is
 *     arithmetically fine and physically meaningless.
 *   - Warm-ups are excluded from every statistic and errors are counted, never
 *     averaged in. A failed run has no timing to contribute.
 *   - `expected` comes from the session's own recorded repetition counts, so a
 *     partial cell reads as "12 of 20" rather than as a complete measurement of
 *     something cheaper. Records written before per-window counts fall back to the
 *     session's single `repetitions`.
 *   - p95 is left null below `P95_MIN_SAMPLES`; see stats.ts. A stopped session is
 *     exactly the case where quoting a nearest-rank p95 would be reporting the
 *     maximum under a percentile's name.
 */

import type { RunRecord } from './appSettings';
import type { SessionRecord } from './sessions';
import { countsAgree, summarizeSamples, type SampleSummary } from './stats';

export interface SessionResultCell {
  /** Stable row key for React. */
  key: string;
  searchId: string;
  searchName: string;
  windowId: string;
  /** Engine size this cell was measured on. */
  engine: string;
  /** Timed runs the session intended for this window, or null if unrecorded. */
  expected: number | null;
  /** Distribution of `totalMs` over the successful timed runs. */
  total: SampleSummary;
  /** Medians of the split, for attributing a slow total. */
  engineMedian: number | null;
  queueMedian: number | null;
  /** Timed runs that errored. Not part of any statistic. */
  errors: number;
  /** Whether every repetition saw the same event count. False means the data moved. */
  consistent: boolean;
  eventCount: number | null;
  /** Bounds actually searched, from the first run in the cell. */
  earliestSec: number | null;
  latestSec: number | null;
}

function medianOf(values: (number | null)[]): number | null {
  return summarizeSamples(values.filter((value): value is number => typeof value === 'number'))
    .median;
}

/**
 * Timed runs the session meant to do for one window.
 *
 * Null rather than a guess when the session recorded neither a per-window count
 * nor a default: "12 runs" is honest, "12 of ?" is honest, and "12 of 20" against
 * a number nobody recorded is not.
 */
export function expectedRuns(session: SessionRecord, windowId: string): number | null {
  const override = session.windowRepetitions?.[windowId];
  if (typeof override === 'number') return override;
  return typeof session.repetitions === 'number' && session.repetitions > 0
    ? session.repetitions
    : null;
}

/**
 * Cells for one session, ordered by search, then by the configured window order,
 * then by engine size.
 *
 * `windowOrder` and `engineOrder` are passed in rather than imported so this stays
 * a pure leaf and so a window the operator has since deleted still appears —
 * unknown ids sort last, in the order the runs recorded them, instead of
 * vanishing from the session that measured them.
 */
export function sessionResults(
  runs: RunRecord[],
  session: SessionRecord,
  windowOrder: string[],
  engineOrder: string[],
): SessionResultCell[] {
  const mine = runs.filter((run) => run.sessionId === session.id && run.measured);
  const groups = new Map<string, RunRecord[]>();
  for (const run of mine) {
    const key = `${run.searchId}\u0000${run.window}\u0000${run.engine}`;
    const seen = groups.get(key);
    if (seen) seen.push(run);
    else groups.set(key, [run]);
  }

  const rank = (order: string[], value: string, fallback: number) => {
    const at = order.indexOf(value);
    return at === -1 ? order.length + fallback : at;
  };
  const windowSeen = [...new Set(mine.map((run) => run.window))];
  const engineSeen = [...new Set(mine.map((run) => run.engine))];

  const cells = [...groups.entries()].map(([key, group]) => {
    const first = group[0];
    const ok = group.filter((run) => run.status === 'Success');
    const totals = ok
      .map((run) => run.totalMs)
      .filter((value): value is number => typeof value === 'number');
    const counts = ok.map((run) => run.totalEventCount);
    const bounds = ok[0] ?? first;
    return {
      key,
      searchId: first.searchId,
      // The name as recorded, not as the library reads today: the search can have
      // been renamed or deleted since, and the session should still say what it ran.
      searchName: first.searchName || first.searchId || '(unnamed search)',
      windowId: first.window,
      engine: first.engine,
      expected: expectedRuns(session, first.window),
      total: summarizeSamples(totals),
      engineMedian: medianOf(ok.map((run) => run.engineMs)),
      queueMedian: medianOf(ok.map((run) => run.queueMs)),
      errors: group.length - ok.length,
      consistent: countsAgree(counts),
      eventCount: counts.find((value): value is number => typeof value === 'number') ?? null,
      earliestSec: typeof bounds?.earliestSec === 'number' ? bounds.earliestSec : null,
      latestSec: typeof bounds?.latestSec === 'number' ? bounds.latestSec : null,
    };
  });

  return cells.sort(
    (a, b) =>
      a.searchName.localeCompare(b.searchName) ||
      rank(windowOrder, a.windowId, windowSeen.indexOf(a.windowId)) -
        rank(windowOrder, b.windowId, windowSeen.indexOf(b.windowId)) ||
      rank(engineOrder, a.engine, engineSeen.indexOf(a.engine)) -
        rank(engineOrder, b.engine, engineSeen.indexOf(b.engine)),
  );
}

export interface SessionCoverage {
  /** Cells with at least one successful timed run. */
  cells: number;
  /** Cells that got fewer timed runs than the session intended. */
  partial: number;
  /** Timed runs recorded against the runs intended, where that is known. */
  runs: number;
  expected: number | null;
}

/**
 * One-line honesty check for a session: how much of what it set out to measure it
 * actually has. This is what makes a stopped session usable — the reader sees the
 * shortfall instead of inferring it from a missing row.
 */
export function sessionCoverage(cells: SessionResultCell[]): SessionCoverage {
  let runs = 0;
  let expected: number | null = 0;
  let partial = 0;
  for (const cell of cells) {
    runs += cell.total.n + cell.errors;
    if (cell.expected === null) expected = null;
    else if (expected !== null) expected += cell.expected;
    if (cell.expected !== null && cell.total.n + cell.errors < cell.expected) partial += 1;
  }
  return { cells: cells.filter((cell) => cell.total.n > 0).length, partial, runs, expected };
}
