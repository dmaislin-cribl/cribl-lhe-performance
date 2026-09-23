/**
 * Lakehouse engine tiers.
 *
 * Shared so the workbench, the comparison view and the chart agree on the
 * order, the labels and — importantly — the color each tier wears. Color
 * follows the tier, never its rank in a result set, so hiding a tier never
 * repaints the others.
 */

export const ENGINE_TIERS = ['medium', 'large', 'xlarge', '2xlarge'];

/** Tier the progression must complete before larger tiers unlock. */
export const BASELINE_TIER = 'medium';

const TIER_LABELS: Record<string, string> = {
  medium: 'Medium',
  large: 'Large',
  xlarge: 'X-Large',
  '2xlarge': '2X-Large',
};

/**
 * Ordinal ramp step per tier — light for the smallest engine, dark for the
 * largest, because tier size is an ordered quantity. Defined as CSS custom
 * properties so dark mode substitutes its own validated steps.
 */
const TIER_COLORS: Record<string, string> = {
  medium: 'var(--chart-1)',
  large: 'var(--chart-2)',
  xlarge: 'var(--chart-3)',
  '2xlarge': 'var(--chart-4)',
};

export function labelTier(tier: string): string {
  return TIER_LABELS[tier] ?? tier;
}

export function tierColor(tier: string): string {
  return TIER_COLORS[tier] ?? 'var(--cds-color-fg-muted)';
}
