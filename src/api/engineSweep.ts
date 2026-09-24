/**
 * Multi-size sweep planning: run the same matrix across several engine sizes in
 * one go, resizing between them.
 *
 * Before this, the workbench measured whichever size the engine happened to be,
 * and comparing sizes meant an operator manually resizing, waiting, re-running,
 * and remembering to do it in the same order for every search. That is a
 * multi-hour babysitting job in which the easiest mistake — re-running one size
 * with a different selection — produces a comparison table that looks fine and
 * is wrong.
 *
 * The planning is kept here, as pure functions, because the interesting parts are
 * the ordering and the deduplication, and both need to be testable without a live
 * control plane to resize.
 *
 * ## Why strictly ascending
 *
 * Sweeps run smallest to largest, always. It is not the cheapest order in
 * resizes — starting from a large engine means one resize down before the climb
 * — but it is the order that:
 *
 *   - establishes the baseline before anything expensive runs, so a sweep that is
 *     stopped early has spent its time on the cheap end and still produced the
 *     column everything else is measured against;
 *   - fails cheaply: a broken query or a bad window is discovered on Nano, not
 *     eight resizes into 14 TB/day;
 *   - reads the same way every time, so two sweeps a week apart are comparable
 *     without checking which order each one used.
 *
 * ## Why the resize is never silent
 *
 * A resize changes live Lakehouse capacity and the bill for every consumer of
 * that engine, not just this lab. A sweep does several of them unattended, so the
 * confirmation it asks for lists every size it will pass through — see
 * `describeSweep`. The app still never resizes without that confirmation; what
 * changed is that one confirmation can now cover a planned series instead of
 * forcing one dialog per step.
 */

import { canonicalTier, labelTier, tierDef, tierIndex } from './tiers';

export interface SweepStep {
  /** Engine size this step measures. */
  tier: string;
  /**
   * Whether the engine has to be resized before this step. False only for a
   * first step that is already the engine's current size.
   */
  needsResize: boolean;
}

export interface SweepPlan {
  steps: SweepStep[];
  /** How many resizes the sweep performs, excluding any restore afterwards. */
  resizes: number;
  /** Timed plus warm-up runs across the whole sweep. */
  totalRuns: number;
  /** Sizes in the plan that Cribl must enable for the org first. */
  byRequest: string[];
  /** Sizes whose literal API identifier this app has not confirmed. */
  unconfirmed: string[];
}

/**
 * Order the selected sizes into steps. Ascending by documented size, with
 * unknown sizes last (`tierIndex` puts them there), and deduplicated so a
 * selection carrying both an alias and its canonical id measures once.
 */
export function planSweep(input: {
  selected: string[];
  currentTier: string;
  searches: number;
  /**
   * Timed runs for each window in the run, one entry per window. An array rather
   * than a count × a repetition number, because windows can carry different
   * repetition counts — a 14-day window is minutes per run where the 1-hour window
   * is seconds, so one number for both is either waste or an unusable sample.
   */
  runsPerWindow: number[];
}): SweepPlan {
  const { selected, currentTier, searches, runsPerWindow } = input;
  // Canonicalised before deduplication: `xxlarge` and `2xlarge` are one size, and
  // deduplicating the raw strings would measure it twice with a pointless resize
  // in between.
  const unique = [...new Set(selected.map(canonicalTier))].sort(
    (a, b) => tierIndex(a) - tierIndex(b),
  );
  const current = canonicalTier(currentTier);

  const steps: SweepStep[] = unique.map((tier, index) => ({
    tier,
    // Only the first step can already be in place; every later step follows a
    // resize by construction, because the list is deduplicated.
    needsResize: !(index === 0 && tier === current),
  }));

  // One unmeasured warm-up per window on top of its timed runs.
  const runsPerSearch = runsPerWindow.reduce((sum, timed) => sum + timed + 1, 0);

  return {
    steps,
    resizes: steps.filter((step) => step.needsResize).length,
    totalRuns: steps.length * searches * runsPerSearch,
    byRequest: unique.filter((tier) => tierDef(tier)?.byRequest),
    unconfirmed: unique.filter((tier) => {
      const def = tierDef(tier);
      return def ? !def.confirmed : false;
    }),
  };
}

/**
 * Whether a sweep is allowed to start, and why not when it is not.
 *
 * Only the two things that make a sweep impossible are checked: no size to
 * measure, and no search to measure it with.
 *
 * There used to be a third rule — nothing above Medium until Medium had a full
 * set of timed runs — on the theory that nobody should spend the largest engine's
 * capacity on a query that was never checked cheaply. It was removed: an operator
 * measuring the size their org actually runs, which is the normal case, was
 * blocked by a message about a size they had no reason to test, and the honest
 * answer to "is this comparable?" belongs in the analysis view, which already
 * reports sample size and refuses to quote a statistic the sample cannot support.
 * Do not reintroduce it.
 *
 * Returns null when the sweep may proceed.
 */
export function validateSweep(input: { selected: string[]; hasSearches: boolean }): string | null {
  const { selected, hasSearches } = input;
  if (!selected.length) return 'Select at least one engine size to test.';
  if (!hasSearches) return 'Select at least one search to measure.';
  return null;
}

/** One-line plan summary for a confirmation dialog or a progress line. */
export function describeSweep(plan: SweepPlan): string {
  if (!plan.steps.length) return 'Nothing selected.';
  const sizes = plan.steps.map((step) => labelTier(step.tier)).join(' → ');
  return `${sizes} · ${plan.resizes} ${plan.resizes === 1 ? 'resize' : 'resizes'} · ${plan.totalRuns} searches`;
}

/**
 * Rough wall-clock estimate, seconds, from the median time already observed.
 *
 * Deliberately crude and labelled as an estimate everywhere it is shown: the
 * whole point of the sweep is that larger sizes are faster by an unknown factor,
 * so extrapolating from one size's median overestimates. An overestimate is the
 * safe direction for someone deciding whether to start a long unattended run.
 */
export function estimateSweepSeconds(input: {
  plan: SweepPlan;
  medianRunMs: number | null;
  resizeSettleSec: number;
}): number | null {
  const { plan, medianRunMs, resizeSettleSec } = input;
  if (medianRunMs === null || !plan.steps.length) return null;
  return Math.round((plan.totalRuns * medianRunMs) / 1000 + plan.resizes * resizeSettleSec);
}

/** "1h 12m" / "8m" / "45s" — an estimate reads badly in bare seconds. */
export function formatDuration(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return 'unknown';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
