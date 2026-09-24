/**
 * Lakehouse engine sizes.
 *
 * Shared so the workbench, the comparison view and the chart agree on the order,
 * the labels and — importantly — the color each size wears. Color follows the
 * size, never its rank in a result set, so hiding a size never repaints the
 * others.
 *
 * The list runs Nano (75 GB/day) to 3XLarge (14 TB/day), smallest to largest.
 *
 * **4XLarge, 5XLarge and 6XLarge are documented but deliberately absent.** Cribl
 * only grants them through a support request, so an operator cannot resize into
 * one from this app — offering them would produce a sweep step that is certain to
 * be rejected mid-series, after the smaller sizes have already been measured.
 * `mergeDiscoveredTiers` still folds them in if an org is actually running one.
 *
 * Two caveats worth knowing before trusting a resize:
 *
 *   - **The API identifiers are only confirmed for the middle of the range.**
 *     Cribl's docs name the sizes but do not publish the literal `tierSize`
 *     strings. `medium`, `large`, `xlarge` and `2xlarge` are the values this app
 *     has actually seen from the engines endpoint. The rest are inferred, and
 *     `aliases` carries the plausible alternate spellings so a live engine
 *     reporting `xxlarge` or `x-small` still labels correctly instead of showing
 *     up as an extra unknown size. `canonicalTier` does that folding.
 *   - **Not every size is enabled on every org.** A resize to a size the org is
 *     not entitled to is rejected by the control plane, so the UI offers the
 *     documented range and reports the rejection rather than pretending to know
 *     the entitlement.
 *
 * Because of the first caveat, the offered list is a *floor*, not a closed set:
 * `mergeDiscoveredTiers` folds in any `tierSize` the API reports that is not
 * listed here, so the app can never present fewer sizes than the workspace
 * actually has.
 */

export interface TierDef {
  /** The `tierSize` value sent to and received from the API. */
  id: string;
  /** Display name, as Cribl's documentation writes it. */
  label: string;
  /** Documented daily ingest capacity in GB, or null when not published. */
  dailyGb: number | null;
  /** Needs a request to Cribl before the org can select it. */
  byRequest: boolean;
  /** Other spellings that mean this same size, folded in by `canonicalTier`. */
  aliases: string[];
  /**
   * Whether this app has observed this exact `id` coming back from the engines
   * endpoint. Unconfirmed ids are still offered — they are the documented sizes
   * — but the UI can warn that a resize may be rejected on the spelling alone.
   */
  confirmed: boolean;
}

export const TIERS: TierDef[] = [
  { id: 'nano', label: 'Nano', dailyGb: 75, byRequest: false, aliases: [], confirmed: false },
  { id: 'micro', label: 'Micro', dailyGb: 150, byRequest: false, aliases: [], confirmed: false },
  {
    id: 'xsmall',
    label: 'XSmall',
    dailyGb: 300,
    byRequest: false,
    aliases: ['x-small', 'xs', '1xsmall'],
    confirmed: false,
  },
  { id: 'small', label: 'Small', dailyGb: 600, byRequest: false, aliases: [], confirmed: false },
  { id: 'medium', label: 'Medium', dailyGb: 1200, byRequest: false, aliases: [], confirmed: true },
  { id: 'large', label: 'Large', dailyGb: 2400, byRequest: false, aliases: [], confirmed: true },
  { id: 'xlarge', label: 'XLarge', dailyGb: 4800, byRequest: false, aliases: ['1xlarge'], confirmed: true },
  {
    id: '2xlarge',
    label: 'XXLarge',
    dailyGb: 9600,
    byRequest: false,
    aliases: ['xxlarge'],
    confirmed: true,
  },
  {
    id: '3xlarge',
    label: '3XLarge',
    dailyGb: 14_000,
    byRequest: true,
    aliases: ['xxxlarge'],
    confirmed: false,
  },
];

/** Size ids, smallest to largest. */
export const ENGINE_TIERS: string[] = TIERS.map((tier) => tier.id);

/**
 * Default comparison baseline — the size other sizes are reported *against* in the
 * analysis view. It is a starting point for a reader, not a gate: any size can be
 * measured on its own, in any order, and the baseline is switchable per view.
 */
export const BASELINE_TIER = 'medium';

const BY_ID = new Map<string, TierDef>();
for (const tier of TIERS) {
  BY_ID.set(tier.id, tier);
  for (const alias of tier.aliases) BY_ID.set(alias, tier);
}

/**
 * Fold an API-reported size onto the id this app uses, so one engine does not
 * appear as two sizes because the control plane spells it differently. Unknown
 * values are returned lowercased and unchanged — better an honest unrecognised
 * size than a wrong match.
 */
export function canonicalTier(value: string): string {
  const key = value.trim().toLowerCase();
  return BY_ID.get(key)?.id ?? key;
}

export function tierDef(tier: string): TierDef | null {
  return BY_ID.get(tier.trim().toLowerCase()) ?? null;
}

export function labelTier(tier: string): string {
  return tierDef(tier)?.label ?? tier;
}

/** "XLarge · 4.8 TB/day" for a picker, or just the label when capacity is unknown. */
export function describeTier(tier: string): string {
  const def = tierDef(tier);
  if (!def) return tier;
  // Below a terabyte, say GB. "0.075 TB/day" for Nano is technically right and
  // unreadable; the docs write these sizes in GB and so does the picker.
  const capacity =
    def.dailyGb === null
      ? ''
      : def.dailyGb < 1000
        ? ` · ${def.dailyGb.toLocaleString()} GB/day`
        : ` · ${(def.dailyGb / 1000).toLocaleString()} TB/day`;
  return `${def.label}${capacity}${def.byRequest ? ' · by request' : ''}`;
}

export function tierIndex(tier: string): number {
  const index = ENGINE_TIERS.indexOf(canonicalTier(tier));
  // Unknown sizes sort last rather than first, so a surprise value from the API
  // does not claim to be smaller than Small.
  return index === -1 ? ENGINE_TIERS.length : index;
}

/**
 * Sizes to offer: the documented list plus anything the API actually reported.
 * Keeps the documented order and appends unrecognised sizes at the end.
 */
export function mergeDiscoveredTiers(observed: string[]): string[] {
  const extra: string[] = [];
  for (const value of observed) {
    const id = canonicalTier(value);
    if (!id || BY_ID.has(id) || extra.includes(id)) continue;
    extra.push(id);
  }
  return [...ENGINE_TIERS, ...extra];
}

/**
 * Ordinal ramp step per size — light for the smallest engine, dark for the
 * largest, because engine size is an ordered quantity. This is a **sequential**
 * palette, so the check that applies is monotonic lightness, not the adjacent
 * pair separation a categorical palette owes; nine levels of one hue cannot
 * meet a categorical floor and should not be judged against it. Identity is
 * never color-alone regardless: the chart always ships a legend, end labels
 * where they fit, a naming tooltip, and the comparison table beside it.
 *
 * Defined as CSS custom properties so dark mode substitutes its own steps
 * validated against the dark surface, rather than inverting these.
 *
 * Adding a size means **re-stepping the whole ramp**, not appending to it: the
 * light end is already at the 2:1 contrast floor against the surface, so a new
 * step has to come out of the interior lightness budget.
 */
const TIER_COLORS: Record<string, string> = {
  nano: 'var(--chart-1)',
  micro: 'var(--chart-2)',
  xsmall: 'var(--chart-3)',
  small: 'var(--chart-4)',
  medium: 'var(--chart-5)',
  large: 'var(--chart-6)',
  xlarge: 'var(--chart-7)',
  '2xlarge': 'var(--chart-8)',
  '3xlarge': 'var(--chart-9)',
};

export function tierColor(tier: string): string {
  return TIER_COLORS[canonicalTier(tier)] ?? 'var(--cds-color-fg-muted)';
}

/**
 * Plotting every size at once is unreadable — nine steps of one hue are
 * genuinely hard to tell apart, and the remedy is fewer series rather than more
 * hues. The comparison view uses this to cap what it draws and to tell the
 * operator to narrow the selection; the table still shows everything.
 */
export const MAX_CHARTED_TIERS = 4;
