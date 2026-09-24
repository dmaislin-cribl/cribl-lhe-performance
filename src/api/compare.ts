/**
 * Cross-tier aggregation.
 *
 * Comparing engine tiers is the reason this lab exists, but the workbench only
 * ever summarised the tier currently selected — so the actual deliverable, "what
 * did we buy by going from Medium to 2X-Large", had to be assembled by hand.
 * This module derives that comparison from the durable run log.
 *
 * Two derived figures beyond the raw medians:
 *
 *   - speedup, baseline median / tier median. >1 means the larger tier is
 *     faster. Reported against the baseline tier so every column is read the
 *     same way.
 *   - msPerHour, median divided by the window's width in hours. If a tier
 *     scales linearly with the scanned range this is flat across windows; a
 *     rising curve is the interesting finding, and it is invisible in raw
 *     medians because those rise with window size regardless.
 */

import type { RunRecord } from './appSettings';
import { countsAgree, summarizeSamples, type SampleSummary } from './stats';
import type { WindowDef } from './windows';

export interface Cell {
  stats: SampleSummary;
  errors: number;
  /** False when repetitions disagreed on the matching event count. */
  consistent: boolean;
  eventCount: number | null;
  /** Median ms per hour of window width — flat means linear scaling. */
  msPerHour: number | null;
  /** Baseline median / this median. Null without both. */
  speedup: number | null;
}

export interface ComparisonRow {
  window: WindowDef;
  /** Keyed by tier. Always contains an entry for every requested tier. */
  cells: Record<string, Cell>;
}

/**
 * Which recorded time to compare. `totalMs` — start to finish, queue included —
 * is the default because it is the time the operator actually waited; `engineMs`
 * isolates execution when the question is specifically about engine capacity.
 */
export type TimingField = 'totalMs' | 'engineMs';

/** Runs eligible to be treated as measurements of a tier/window pair. */
function samplesFor(
  runs: RunRecord[],
  tier: string,
  windowId: string,
  field: TimingField = 'totalMs',
) {
  const forPair = runs.filter(
    (run) => run.measured && run.engine === tier && run.window === windowId,
  );
  const ok = forPair.filter((run) => run.status === 'Success');
  return {
    errors: forPair.length - ok.length,
    // Only server-reported times count; a null timing is not a measurement.
    values: ok.map((run) => run[field]).filter((value): value is number => typeof value === 'number'),
    counts: ok.map((run) => run.totalEventCount),
  };
}

export function buildComparison(
  runs: RunRecord[],
  windows: WindowDef[],
  tiers: string[],
  baselineTier: string,
  field: TimingField = 'totalMs',
): ComparisonRow[] {
  return windows.map((window) => {
    const hours = window.spanMs / 3_600_000;
    const baseline = summarizeSamples(samplesFor(runs, baselineTier, window.id, field).values).median;

    const cells: Record<string, Cell> = {};
    for (const tier of tiers) {
      const { errors, values, counts } = samplesFor(runs, tier, window.id, field);
      const stats = summarizeSamples(values);
      cells[tier] = {
        stats,
        errors,
        consistent: countsAgree(counts),
        eventCount: counts.find((value): value is number => typeof value === 'number') ?? null,
        msPerHour: stats.median === null ? null : stats.median / hours,
        speedup:
          baseline === null || stats.median === null || stats.median === 0
            ? null
            : baseline / stats.median,
      };
    }
    return { window, cells };
  });
}

/** Tiers that actually have at least one measurement, in the given order. */
export function tiersWithData(
  runs: RunRecord[],
  tiers: string[],
  field: TimingField = 'totalMs',
): string[] {
  return tiers.filter((tier) =>
    runs.some(
      (run) =>
        run.engine === tier &&
        run.measured &&
        run.status === 'Success' &&
        typeof run[field] === 'number',
    ),
  );
}

/**
 * Saved searches present in a run log, most-measured first, so a picker can
 * default to the case the operator has actually been working on. Names come from
 * the runs rather than the library: a search deleted from the library still has
 * runs that need labelling.
 */
export function searchesInLog(runs: RunRecord[]): { id: string; name: string; runs: number }[] {
  const counts = new Map<string, { id: string; name: string; runs: number }>();
  for (const run of runs) {
    if (!run.measured || run.status !== 'Success') continue;
    const id = run.searchId || '(unattributed)';
    const existing = counts.get(id);
    if (existing) existing.runs += 1;
    else counts.set(id, { id, name: run.searchName || 'Unnamed search', runs: 1 });
  }
  return [...counts.values()].sort((a, b) => b.runs - a.runs);
}

/**
 * Whether a comparison is safe to present. A tier measured under a different
 * query, dataset or event count is not comparable to the baseline, however
 * clean its numbers look.
 */
export interface ComparabilityWarning {
  kind: 'query' | 'dataset' | 'counts' | 'partial';
  detail: string;
}

export function checkComparability(
  runs: RunRecord[],
  rows: ComparisonRow[],
  tiers: string[],
  /**
   * Timed runs the config expects for a given window. A function rather than one
   * number because windows carry their own repetition counts — a single expected
   * value would flag every deliberately-shortened window as a thin sample.
   */
  expectedFor: (windowId: string) => number,
): ComparabilityWarning[] {
  const warnings: ComparabilityWarning[] = [];
  const measured = runs.filter((run) => run.measured && run.status === 'Success');

  const queries = new Set(measured.map((run) => run.queryHash));
  if (queries.size > 1) {
    warnings.push({
      kind: 'query',
      detail: `${queries.size} different search definitions appear in this run log. Timings from different queries are not comparable.`,
    });
  }

  const datasets = new Set(measured.map((run) => run.dataset));
  if (datasets.size > 1) {
    warnings.push({
      kind: 'dataset',
      detail: `Runs span ${datasets.size} datasets (${[...datasets].join(', ')}).`,
    });
  }

  const inconsistent = rows.filter((row) => tiers.some((tier) => !row.cells[tier].consistent));
  if (inconsistent.length) {
    warnings.push({
      kind: 'counts',
      detail: `Event counts disagreed between repetitions for ${inconsistent
        .map((row) => row.window.id)
        .join(', ')} — the underlying data moved during the run.`,
    });
  }

  const partial = rows.flatMap((row) => {
    const expected = expectedFor(row.window.id);
    return tiers
      .filter((tier) => row.cells[tier].stats.n > 0 && row.cells[tier].stats.n < expected)
      .map((tier) => `${row.window.id}/${tier} (${row.cells[tier].stats.n}/${expected})`);
  });
  if (partial.length) {
    warnings.push({
      kind: 'partial',
      detail: `${partial.slice(0, 6).join(', ')}${partial.length > 6 ? ` and ${partial.length - 6} more` : ''} — fewer repetitions than configured, so those medians rest on a thinner sample than the rest of the table.`,
    });
  }

  return warnings;
}
