import { describe, expect, it } from 'vitest';
import { WINDOWS, formatBounds, resolveWindow, resolveWindows } from './windows';

// 2026-09-23T13:37:11.500Z — deliberately mid-hour and mid-day so snapping
// has something to do.
const ANCHOR = Date.UTC(2026, 8, 23, 13, 37, 11, 500);

describe('resolveWindow', () => {
  it('ends an hour-snapped window at the last fully-elapsed hour', () => {
    const resolved = resolveWindow(
      { id: 'T1', label: '1 hour', spanMs: 3_600_000, snap: 'hour' },
      ANCHOR,
    );
    expect(resolved.latestIso).toBe('2026-09-23T12:00:00.000Z');
    expect(resolved.earliestIso).toBe('2026-09-23T11:00:00.000Z');
  });

  it('ends a day-snapped window at the last fully-elapsed UTC day', () => {
    const resolved = resolveWindow({ id: 'T5', label: '24 hours', spanMs: 86_400_000, snap: 'day' }, ANCHOR);
    expect(resolved.latestIso).toBe('2026-09-22T00:00:00.000Z');
    expect(resolved.earliestIso).toBe('2026-09-21T00:00:00.000Z');
  });

  it('emits epoch seconds spanning exactly spanMs', () => {
    const resolved = resolveWindow({ id: 'T2', label: '4 hours', spanMs: 4 * 3_600_000, snap: 'hour' }, ANCHOR);
    expect(resolved.latestSec - resolved.earliestSec).toBe(4 * 3600);
    expect(Number.isInteger(resolved.earliestSec)).toBe(true);
  });

  // This is the drift bug the absolute-bounds change exists to prevent: two
  // anchors either side of an hour boundary must not silently produce the same
  // label over different data.
  it('is stable within an hour and shifts by exactly one hour across the boundary', () => {
    const def = { id: 'T1', label: '1 hour', spanMs: 3_600_000, snap: 'hour' as const };
    const early = resolveWindow(def, Date.UTC(2026, 8, 23, 13, 0, 0, 1));
    const late = resolveWindow(def, Date.UTC(2026, 8, 23, 13, 59, 59, 999));
    const next = resolveWindow(def, Date.UTC(2026, 8, 23, 14, 0, 0, 0));
    expect(early.latestSec).toBe(late.latestSec);
    expect(next.latestSec - late.latestSec).toBe(3600);
  });
});

describe('resolveWindows', () => {
  it('resolves every window against one anchor so a matrix run is self-consistent', () => {
    const resolved = resolveWindows(WINDOWS, ANCHOR);
    expect(resolved).toHaveLength(8);

    const hourEnds = new Set(
      resolved.filter((w) => w.snap === 'hour').map((w) => w.latestSec),
    );
    const dayEnds = new Set(resolved.filter((w) => w.snap === 'day').map((w) => w.latestSec));
    expect(hourEnds.size).toBe(1);
    expect(dayEnds.size).toBe(1);
  });

  it('keeps the documented window widths', () => {
    const widths = resolveWindows(WINDOWS, ANCHOR).map((w) => (w.latestSec - w.earliestSec) / 3600);
    expect(widths).toEqual([1, 4, 8, 12, 24, 48, 168, 336]);
  });
});

describe('formatBounds', () => {
  it('renders a compact UTC range', () => {
    const resolved = resolveWindow({ id: 'T1', label: '1 hour', spanMs: 3_600_000, snap: 'hour' }, ANCHOR);
    expect(formatBounds(resolved)).toBe('2026-09-23 11:00 → 12:00Z');
  });
});
