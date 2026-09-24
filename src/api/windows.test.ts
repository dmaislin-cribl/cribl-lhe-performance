import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOWS,
  formatBounds,
  MAX_SPAN_COUNT,
  makeWindow,
  nextWindowId,
  normalizeWindows,
  resolveWindow,
  resolveWindows,
} from './windows';

// 2026-09-23T13:37:11.500Z — deliberately mid-hour and mid-day so snapping
// has something to do.
const ANCHOR = Date.UTC(2026, 8, 23, 13, 37, 11, 500);

describe('resolveWindow', () => {
  it('ends an hour-snapped window at the last fully-elapsed hour', () => {
    const resolved = resolveWindow(
      makeWindow('T1', 1, 'hour', 'hour'),
      ANCHOR,
    );
    expect(resolved.latestIso).toBe('2026-09-23T12:00:00.000Z');
    expect(resolved.earliestIso).toBe('2026-09-23T11:00:00.000Z');
  });

  it('ends a day-snapped window at the last fully-elapsed UTC day', () => {
    const resolved = resolveWindow(makeWindow('T5', 24, 'hour', 'day'), ANCHOR);
    expect(resolved.latestIso).toBe('2026-09-22T00:00:00.000Z');
    expect(resolved.earliestIso).toBe('2026-09-21T00:00:00.000Z');
  });

  it('emits epoch seconds spanning exactly spanMs', () => {
    const resolved = resolveWindow(makeWindow('T2', 4, 'hour', 'hour'), ANCHOR);
    expect(resolved.latestSec - resolved.earliestSec).toBe(4 * 3600);
    expect(Number.isInteger(resolved.earliestSec)).toBe(true);
  });

  // This is the drift bug the absolute-bounds change exists to prevent: two
  // anchors either side of an hour boundary must not silently produce the same
  // label over different data.
  it('is stable within an hour and shifts by exactly one hour across the boundary', () => {
    const def = makeWindow('T1', 1, 'hour', 'hour');
    const early = resolveWindow(def, Date.UTC(2026, 8, 23, 13, 0, 0, 1));
    const late = resolveWindow(def, Date.UTC(2026, 8, 23, 13, 59, 59, 999));
    const next = resolveWindow(def, Date.UTC(2026, 8, 23, 14, 0, 0, 0));
    expect(early.latestSec).toBe(late.latestSec);
    expect(next.latestSec - late.latestSec).toBe(3600);
  });
});

describe('resolveWindows', () => {
  it('resolves every window against one anchor so a matrix run is self-consistent', () => {
    const resolved = resolveWindows(DEFAULT_WINDOWS, ANCHOR);
    expect(resolved).toHaveLength(8);

    const hourEnds = new Set(
      resolved.filter((w) => w.snap === 'hour').map((w) => w.latestSec),
    );
    const dayEnds = new Set(resolved.filter((w) => w.snap === 'day').map((w) => w.latestSec));
    expect(hourEnds.size).toBe(1);
    expect(dayEnds.size).toBe(1);
  });

  it('keeps the documented window widths', () => {
    const widths = resolveWindows(DEFAULT_WINDOWS, ANCHOR).map((w) => (w.latestSec - w.earliestSec) / 3600);
    expect(widths).toEqual([1, 4, 8, 12, 24, 48, 168, 336]);
  });
});

describe('formatBounds', () => {
  it('renders a compact UTC range', () => {
    const resolved = resolveWindow(makeWindow('T1', 1, 'hour', 'hour'), ANCHOR);
    expect(formatBounds(resolved)).toBe('2026-09-23 11:00 → 12:00Z');
  });
});

describe('makeWindow', () => {
  it('derives the label and span from the count and unit', () => {
    expect(makeWindow('T9', 6, 'hour', 'hour')).toMatchObject({
      label: '6 hours',
      spanMs: 6 * 3_600_000,
      spanCount: 6,
      spanUnit: 'hour',
    });
    expect(makeWindow('T9', 1, 'day', 'day').label).toBe('1 day');
  });

  it('clamps a nonsense count rather than producing an unsearchable window', () => {
    expect(makeWindow('T9', 0, 'hour', 'hour').spanCount).toBe(1);
    expect(makeWindow('T9', 9999, 'day', 'day').spanCount).toBe(MAX_SPAN_COUNT);
  });
});

describe('normalizeWindows', () => {
  it('falls back to the defaults for a missing or empty set', () => {
    expect(normalizeWindows(undefined)).toEqual(DEFAULT_WINDOWS);
    expect(normalizeWindows([])).toEqual(DEFAULT_WINDOWS);
  });

  it('recovers spanCount/spanUnit from a pre-upgrade record that had only spanMs', () => {
    const [only] = normalizeWindows([{ id: 'T1', label: 'stale', spanMs: 4 * 3_600_000, snap: 'hour' }]);
    expect(only).toMatchObject({ spanCount: 4, spanUnit: 'hour', label: '4 hours' });
  });

  it('drops duplicate ids, which would otherwise merge into one sample set', () => {
    const windows = normalizeWindows([
      { id: 'T1', spanCount: 1, spanUnit: 'hour', snap: 'hour' },
      { id: 'T1', spanCount: 9, spanUnit: 'hour', snap: 'hour' },
    ]);
    expect(windows).toHaveLength(1);
    expect(windows[0].spanCount).toBe(1);
  });

  it('sorts ascending by span so the cheap window runs and plots first', () => {
    const windows = normalizeWindows([
      { id: 'B', spanCount: 7, spanUnit: 'day', snap: 'day' },
      { id: 'A', spanCount: 30, spanUnit: 'hour', snap: 'hour' },
    ]);
    expect(windows.map((w) => w.id)).toEqual(['A', 'B']);
  });

  it('drops entries that could not be searched', () => {
    expect(normalizeWindows([{ id: '  ', spanCount: 2, spanUnit: 'hour' }, null, 'x'])).toEqual(
      DEFAULT_WINDOWS,
    );
  });
});

describe('nextWindowId', () => {
  it('returns the first unused T<n>, never one already carrying runs', () => {
    expect(nextWindowId(DEFAULT_WINDOWS)).toBe('T9');
    expect(nextWindowId([makeWindow('T1', 1, 'hour', 'hour'), makeWindow('T3', 3, 'hour', 'hour')])).toBe('T2');
  });
});
