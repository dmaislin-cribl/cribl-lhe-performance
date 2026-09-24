import { describe, expect, it } from 'vitest';
import {
  BASELINE_TIER,
  ENGINE_TIERS,
  MAX_CHARTED_TIERS,
  TIERS,
  canonicalTier,
  describeTier,
  labelTier,
  mergeDiscoveredTiers,
  tierColor,
  tierDef,
  tierIndex,
} from './tiers';

describe('the tier table', () => {
  it('offers every size an operator can actually resize into', () => {
    expect(ENGINE_TIERS).toEqual([
      'nano',
      'micro',
      'xsmall',
      'small',
      'medium',
      'large',
      'xlarge',
      '2xlarge',
      '3xlarge',
    ]);
  });

  it('leaves out the sizes only Cribl support can grant', () => {
    // Offering them would put a step in the sweep plan that is certain to be
    // rejected mid-series, after the smaller sizes were already measured.
    for (const id of ['4xlarge', '5xlarge', '6xlarge']) {
      expect(ENGINE_TIERS).not.toContain(id);
      expect(tierDef(id)).toBeNull();
    }
  });

  it('is ordered smallest to largest by documented capacity', () => {
    const capacities = TIERS.map((tier) => tier.dailyGb ?? Infinity);
    expect(capacities).toEqual([...capacities].sort((a, b) => a - b));
  });

  it('includes the default comparison baseline', () => {
    expect(ENGINE_TIERS).toContain(BASELINE_TIER);
  });

  it('gives every size a distinct chart step, so color follows size not rank', () => {
    const colors = ENGINE_TIERS.map(tierColor);
    expect(new Set(colors).size).toBe(ENGINE_TIERS.length);
  });

  it('marks only the sizes actually observed from the API as confirmed', () => {
    const confirmed = TIERS.filter((tier) => tier.confirmed).map((tier) => tier.id);
    expect(confirmed).toEqual(['medium', 'large', 'xlarge', '2xlarge']);
  });

  it('marks the size that needs a request to Cribl', () => {
    const byRequest = TIERS.filter((tier) => tier.byRequest).map((tier) => tier.id);
    expect(byRequest).toEqual(['3xlarge']);
  });
});

describe('canonicalTier', () => {
  it('folds an alternate spelling onto one id, so one engine is not two sizes', () => {
    expect(canonicalTier('xxlarge')).toBe('2xlarge');
    expect(canonicalTier('1xlarge')).toBe('xlarge');
    expect(canonicalTier('x-small')).toBe('xsmall');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(canonicalTier('  Medium ')).toBe('medium');
  });

  it('returns an unknown value unchanged rather than guessing a match', () => {
    expect(canonicalTier('9xlarge')).toBe('9xlarge');
  });
});

describe('labelTier and describeTier', () => {
  it('labels documented sizes as the docs write them', () => {
    expect(labelTier('2xlarge')).toBe('XXLarge');
    expect(labelTier('xxlarge')).toBe('XXLarge');
  });

  it('falls back to the raw value for an unrecognised size', () => {
    expect(labelTier('9xlarge')).toBe('9xlarge');
    expect(describeTier('9xlarge')).toBe('9xlarge');
    expect(tierDef('9xlarge')).toBeNull();
  });

  it('adds capacity, and flags the sizes Cribl has to enable', () => {
    expect(describeTier('large')).toBe('Large · 2.4 TB/day');
    expect(describeTier('3xlarge')).toContain('by request');
  });

  it('writes sub-terabyte capacity in GB, since 0.075 TB/day is unreadable', () => {
    expect(describeTier('nano')).toBe('Nano · 75 GB/day');
    expect(describeTier('small')).toBe('Small · 600 GB/day');
  });
});

describe('tierIndex', () => {
  it('orders by size', () => {
    expect(tierIndex('small')).toBeLessThan(tierIndex('medium'));
    expect(tierIndex('2xlarge')).toBeLessThan(tierIndex('3xlarge'));
    expect(tierIndex('nano')).toBeLessThan(tierIndex('micro'));
  });

  it('sorts an unknown size last, never below Small', () => {
    expect(tierIndex('9xlarge')).toBe(ENGINE_TIERS.length);
    expect(tierIndex('9xlarge')).toBeGreaterThan(tierIndex('3xlarge'));
  });
});

describe('mergeDiscoveredTiers', () => {
  it('is the documented list when the API reports nothing new', () => {
    expect(mergeDiscoveredTiers(['medium', 'large'])).toEqual(ENGINE_TIERS);
    expect(mergeDiscoveredTiers([])).toEqual(ENGINE_TIERS);
  });

  it('appends a size this app has never heard of, so the list is a floor', () => {
    expect(mergeDiscoveredTiers(['12xlarge'])).toEqual([...ENGINE_TIERS, '12xlarge']);
  });

  it('does not append an aliased size as a duplicate', () => {
    expect(mergeDiscoveredTiers(['xxlarge'])).toEqual(ENGINE_TIERS);
  });

  it('reports one unknown size once, however often the API repeats it', () => {
    expect(mergeDiscoveredTiers(['12xlarge', '12XLARGE', ''])).toEqual([...ENGINE_TIERS, '12xlarge']);
  });
});

describe('MAX_CHARTED_TIERS', () => {
  it('is below the number of sizes, since plotting all of one hue is unreadable', () => {
    expect(MAX_CHARTED_TIERS).toBeLessThan(ENGINE_TIERS.length);
  });
});
