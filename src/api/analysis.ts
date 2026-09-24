/**
 * Builds the per-engine-size analysis the performance view renders.
 *
 * The one rule this module exists to enforce: **a distribution is only ever
 * assembled from runs that did identical work.** One saved search, one time
 * window, one metric. Pooling two windows into a single p95 produces a number
 * that is arithmetically fine and physically meaningless — it is the average of
 * two different jobs — and it is the easiest mistake to make when the run log is
 * one flat list. So the scope is always narrowed to a single search and a single
 * window before anything is summarised, and the UI defaults to the
 * most-measured pair rather than to "everything".
 *
 * Failures are counted, never summarised: an errored run has no timing to
 * contribute, but a size that failed 12 of 20 runs is a finding, so the count
 * travels beside the statistics.
 */

import type { RunRecord } from './appSettings';
import { countsAgree } from './stats';
import {
  type BudgetResult,
  type BudgetStatistic,
  type EffectSize,
  type ExtendedSummary,
  type HealthNote,
  type MannWhitneyResult,
  type MedianInterval,
  cliffsDelta,
  extendedSummary,
  gradeAgainstBudget,
  hodgesLehmann,
  interpretDelta,
  mannWhitney,
  medianInterval,
  sampleHealth,
  throughputPerSec,
} from './perfStats';
import { canonicalTier, tierIndex } from './tiers';

/** Which server-reported timing the analysis runs on. */
export type AnalysisMetric = 'total' | 'engine';

export const METRIC_FIELD: Record<AnalysisMetric, 'totalMs' | 'engineMs'> = {
  total: 'totalMs',
  engine: 'engineMs',
};

export interface BaselineComparison {
  /** Hodges-Lehmann shift, ms. Negative means this size was faster. */
  shiftMs: number | null;
  /** The shift as a percentage of the baseline median. Negative is faster. */
  percent: number | null;
  /** Cliff's delta. Positive means this size was faster. */
  delta: number | null;
  effect: EffectSize | null;
  test: MannWhitneyResult;
}

export interface SizeAnalysis {
  tier: string;
  summary: ExtendedSummary;
  /** Measured runs in scope that failed, so produced no timing. */
  errors: number;
  /** Whether every successful run matched the same event count. */
  countsAgree: boolean;
  eventCount: number | null;
  /** Events matched per second, at the median time. */
  throughput: number | null;
  interval: MedianInterval | null;
  health: HealthNote[];
  budget: BudgetResult;
  /** Null for the baseline size itself, and when the baseline has no data. */
  vsBaseline: BaselineComparison | null;
}

export interface AnalysisScope {
  searchId: string;
  windowId: string;
  metric: AnalysisMetric;
  baseline: string;
  budgetMs: number | null;
  budgetStatistic: BudgetStatistic;
}

/** Measured, successful, and carrying the timing the scope asks for. */
function timings(runs: RunRecord[], field: 'totalMs' | 'engineMs'): number[] {
  return runs
    .map((run) => run[field])
    .filter((value): value is number => typeof value === 'number');
}

/**
 * Narrow the log to one search and one window. Both are required — see the
 * module note on why pooling is not offered as a convenience.
 */
export function scopeRuns(runs: RunRecord[], searchId: string, windowId: string): RunRecord[] {
  return runs.filter(
    (run) =>
      run.measured &&
      (run.searchId || '(unattributed)') === searchId &&
      run.window === windowId,
  );
}

/**
 * One row per engine size present in scope, smallest first, plus the baseline
 * even when it has nothing — a comparison table that silently omits the column
 * everything is measured against reads as though there were nothing to compare.
 */
export function analyzeByTier(runs: RunRecord[], scope: AnalysisScope): SizeAnalysis[] {
  const field = METRIC_FIELD[scope.metric];
  const inScope = scopeRuns(runs, scope.searchId, scope.windowId);

  const byTier = new Map<string, RunRecord[]>();
  for (const run of inScope) {
    const tier = canonicalTier(run.engine);
    const bucket = byTier.get(tier);
    if (bucket) bucket.push(run);
    else byTier.set(tier, [run]);
  }
  const baseline = canonicalTier(scope.baseline);
  if (!byTier.has(baseline)) byTier.set(baseline, []);

  const baselineOk = (byTier.get(baseline) ?? []).filter((run) => run.status === 'Success');
  const baselineValues = timings(baselineOk, field);

  const tiers = [...byTier.keys()].sort((a, b) => tierIndex(a) - tierIndex(b));

  return tiers.map((tier) => {
    const forTier = byTier.get(tier) ?? [];
    const ok = forTier.filter((run) => run.status === 'Success');
    const values = timings(ok, field);
    const summary = extendedSummary(values);
    const counts = ok.map((run) => run.totalEventCount);
    const agree = countsAgree(counts);
    const eventCount = counts.find((value) => typeof value === 'number') ?? null;
    const errors = forTier.length - ok.length;

    return {
      tier,
      summary,
      errors,
      countsAgree: agree,
      eventCount,
      throughput: throughputPerSec(eventCount, summary.percentiles.p50 ?? null),
      interval: medianInterval(values),
      health: sampleHealth({ summary, errors, countsAgree: agree }),
      budget: gradeAgainstBudget(summary, scope.budgetMs, scope.budgetStatistic),
      vsBaseline:
        tier === baseline || !baselineValues.length || !values.length
          ? null
          : compareToBaseline(baselineValues, values),
    };
  });
}

function compareToBaseline(baseline: number[], candidate: number[]): BaselineComparison {
  const shiftMs = hodgesLehmann(baseline, candidate);
  const baselineMedian = extendedSummary(baseline).percentiles.p50;
  const delta = cliffsDelta(baseline, candidate);
  return {
    shiftMs,
    percent:
      shiftMs === null || baselineMedian === null || baselineMedian === 0
        ? null
        : (shiftMs / baselineMedian) * 100,
    delta,
    effect: interpretDelta(delta),
    test: mannWhitney(baseline, candidate),
  };
}

export interface ScopeOption {
  id: string;
  label: string;
  /** Measured runs available, used to order and to pick a default. */
  runs: number;
}

/**
 * The searches and windows worth offering, ordered most-measured first so the
 * default selection lands on the pair with the most data behind it rather than
 * on whichever id sorts first.
 */
export function analysisOptions(runs: RunRecord[]): {
  searches: ScopeOption[];
  windows: ScopeOption[];
} {
  const measured = runs.filter((run) => run.measured);
  const searches = new Map<string, ScopeOption>();
  const windows = new Map<string, ScopeOption>();

  for (const run of measured) {
    const searchId = run.searchId || '(unattributed)';
    const search = searches.get(searchId);
    if (search) search.runs += 1;
    else searches.set(searchId, { id: searchId, label: run.searchName || 'Unattributed', runs: 1 });

    const window = windows.get(run.window);
    if (window) window.runs += 1;
    else windows.set(run.window, { id: run.window, label: run.window, runs: 1 });
  }

  const byRuns = (a: ScopeOption, b: ScopeOption) => b.runs - a.runs || a.id.localeCompare(b.id);
  return {
    searches: [...searches.values()].sort(byRuns),
    // Windows read better in their own order — T1, T2, … — than by volume, since
    // the ids are a sequence the operator already has a mental model of.
    windows: [...windows.values()].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/**
 * The pair with the most measured runs, for the initial selection. Returns nulls
 * on an empty log so the caller can render its own empty state rather than
 * being handed a scope that matches nothing.
 */
export function defaultScope(runs: RunRecord[]): { searchId: string | null; windowId: string | null } {
  const measured = runs.filter((run) => run.measured);
  if (!measured.length) return { searchId: null, windowId: null };

  const counts = new Map<string, number>();
  for (const run of measured) {
    const key = `${run.searchId || '(unattributed)'}\u0000${run.window}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = '';
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  const [searchId, windowId] = best.split('\u0000');
  return { searchId, windowId };
}
