import { describe, expect, it } from 'vitest';
import { ENGINE_TIERS } from './tiers';
import {
  describeSweep,
  estimateSweepSeconds,
  formatDuration,
  planSweep,
  validateSweep,
} from './engineSweep';

const shape = { searches: 1, runsPerWindow: [4] };

describe('planSweep', () => {
  it('orders steps smallest to largest regardless of selection order', () => {
    const plan = planSweep({
      selected: ['2xlarge', 'small', 'large'],
      currentTier: 'small',
      ...shape,
    });
    expect(plan.steps.map((step) => step.tier)).toEqual(['small', 'large', '2xlarge']);
  });

  it('skips the resize when the first step is already the engine size', () => {
    const plan = planSweep({ selected: ['small', 'large'], currentTier: 'small', ...shape });
    expect(plan.steps[0].needsResize).toBe(false);
    expect(plan.steps[1].needsResize).toBe(true);
    expect(plan.resizes).toBe(1);
  });

  it('resizes down to the smallest size first when the engine starts large', () => {
    const plan = planSweep({ selected: ['small', 'large'], currentTier: 'large', ...shape });
    expect(plan.steps[0]).toEqual({ tier: 'small', needsResize: true });
    expect(plan.resizes).toBe(2);
  });

  it('deduplicates a size selected twice', () => {
    const plan = planSweep({ selected: ['large', 'large'], currentTier: 'small', ...shape });
    expect(plan.steps).toHaveLength(1);
  });

  it('folds an alias onto the size it names rather than measuring it twice', () => {
    // xxlarge is an alias of 2xlarge, so this is one size, not two.
    const plan = planSweep({ selected: ['2xlarge', 'xxlarge'], currentTier: 'small', ...shape });
    expect(plan.steps).toHaveLength(1);
  });

  it('counts warm-ups in the total, one per search per window per size', () => {
    const plan = planSweep({
      selected: ['small', 'large'],
      currentTier: 'small',
      searches: 2,
      runsPerWindow: [4, 4, 4],
    });
    expect(plan.totalRuns).toBe(2 * 2 * 3 * (4 + 1));
  });

  it('totals a mixed set of per-window counts rather than assuming one number', () => {
    // 50 timed on the cheap window, 5 on the expensive one, each plus a warm-up.
    const plan = planSweep({
      selected: ['medium', 'large'],
      currentTier: 'medium',
      searches: 2,
      runsPerWindow: [50, 5],
    });
    expect(plan.totalRuns).toBe(2 * 2 * (51 + 6));
  });

  it('names the sizes needing Cribl to enable them, and the unconfirmed identifiers', () => {
    const plan = planSweep({
      selected: ['medium', '3xlarge'],
      currentTier: 'medium',
      ...shape,
    });
    expect(plan.byRequest).toEqual(['3xlarge']);
    // medium is observed from the API; 3xlarge is inferred from the docs.
    expect(plan.unconfirmed).toEqual(['3xlarge']);
  });

  it('is empty for an empty selection', () => {
    const plan = planSweep({ selected: [], currentTier: 'medium', ...shape });
    expect(plan.steps).toEqual([]);
    expect(plan.totalRuns).toBe(0);
  });
});

describe('validateSweep', () => {
  it('requires a size and a search', () => {
    expect(validateSweep({ selected: [], hasSearches: true })).toContain('engine size');
    expect(validateSweep({ selected: ['medium'], hasSearches: false })).toContain('search');
  });

  it('gates nothing else — any size, in any order, on its own', () => {
    // The Medium-first rule is gone for good. A sweep of one large size, with no
    // smaller size ever measured, is a legitimate thing to ask for: it is what an
    // operator measuring the size their org actually runs is doing.
    for (const selected of [['3xlarge'], ['nano'], ['2xlarge', 'micro'], ENGINE_TIERS]) {
      expect(validateSweep({ selected, hasSearches: true })).toBeNull();
    }
  });
});

describe('describeSweep', () => {
  it('reads as the route the engine takes', () => {
    const plan = planSweep({ selected: ['small', 'large'], currentTier: 'small', ...shape });
    expect(describeSweep(plan)).toContain('Small → Large');
    expect(describeSweep(plan)).toContain('1 resize');
  });

  it('says so when nothing is selected', () => {
    expect(describeSweep(planSweep({ selected: [], currentTier: 'medium', ...shape }))).toBe(
      'Nothing selected.',
    );
  });
});

describe('estimateSweepSeconds', () => {
  it('adds settling time per resize to the run time', () => {
    const plan = planSweep({ selected: ['small', 'large'], currentTier: 'small', ...shape });
    // 2 sizes x 1 search x 1 window x 5 runs = 10 runs at 1s, plus one 60s resize.
    expect(estimateSweepSeconds({ plan, medianRunMs: 1000, resizeSettleSec: 60 })).toBe(70);
  });

  it('is null before anything has been measured', () => {
    const plan = planSweep({ selected: ['small'], currentTier: 'small', ...shape });
    expect(estimateSweepSeconds({ plan, medianRunMs: null, resizeSettleSec: 60 })).toBeNull();
  });
});

describe('formatDuration', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(600)).toBe('10m');
    expect(formatDuration(4320)).toBe('1h 12m');
  });

  it('says unknown rather than printing NaN', () => {
    expect(formatDuration(null)).toBe('unknown');
    expect(formatDuration(Number.NaN)).toBe('unknown');
  });
});
