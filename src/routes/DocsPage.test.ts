/**
 * The documentation page has no logic to test — but it has a failure mode: a
 * threshold gets retyped into the prose, the constant later changes, and the app
 * ships a help page that contradicts the software. There is no DOM test setup in
 * this repo (every other test is a pure module), so this guards the property that
 * actually matters by reading the source: the figures are imported, not typed.
 */

import { describe, expect, it } from 'vitest';
import { MIN_COMPARE_SAMPLES, quantileMinSamples } from '../api/perfStats';
import { P95_MIN_SAMPLES } from '../api/stats';
// Vite's `?raw` rather than node:fs — the app tsconfig types only `vite/client`,
// and a test is not a reason to pull Node's types into the app's build.
import source from './DocsPage.tsx?raw';

describe('DocsPage', () => {
  it.each([
    'MAX_RUNS',
    'MIN_COMPARE_SAMPLES',
    'REPORTED_PERCENTILES',
    'quantileMinSamples',
    'MAX_SELECTED',
    'P95_MIN_SAMPLES',
    'TIERS',
    'DEFAULT_WINDOWS',
    'MAX_WINDOWS',
  ])('reads %s from the code that enforces it rather than restating it', (name) => {
    expect(source).toContain(name);
  });

  it('documents the engine size table from TIERS, so a size cannot be missing from it', () => {
    // The map over TIERS is the whole point: adding or removing a size updates the
    // documentation in the same commit as the code.
    expect(source).toMatch(/TIERS\.map/);
  });

  it('agrees with the statistics module about the p95 floor', () => {
    // If these ever diverge the prose sentence "the default exists because it is
    // the smallest sample a p95 can be quoted from" becomes false.
    expect(P95_MIN_SAMPLES).toBe(quantileMinSamples(0.95));
    expect(MIN_COMPARE_SAMPLES).toBeLessThan(P95_MIN_SAMPLES);
  });
});
