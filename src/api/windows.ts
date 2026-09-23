/**
 * Test window definitions and absolute bound resolution.
 *
 * Why absolute bounds: the windows are conceptually relative ("the hour
 * before last"), but a full matrix is 8 windows x (1 warm-up + N measured)
 * sequential searches and takes many minutes. If each search re-evaluated a
 * relative expression like `-2h@h`, repetitions either side of an hour
 * boundary would query *different data* and then be averaged together as one
 * sample set. So we resolve every window once, against a single anchor
 * captured at run start, and send absolute epoch seconds to the search API.
 *
 * Epoch seconds (not ISO strings) is what the job API wants for numeric
 * bounds — it accepts `number | string` for earliest/latest and echoes the
 * numbers back unchanged.
 */

export type SnapUnit = 'hour' | 'day';

export interface WindowDef {
  /** Stable short id used as the sample-set key. */
  id: string;
  /** Human label for the span, e.g. "4 hours". */
  label: string;
  /** Width of the window in milliseconds. */
  spanMs: number;
  /**
   * Boundary the window's end is snapped to. The end is the most recent
   * completed unit — one full hour/day back — so the window never includes
   * data still being ingested.
   */
  snap: SnapUnit;
}

export interface ResolvedWindow extends WindowDef {
  /** Inclusive start, epoch seconds. */
  earliestSec: number;
  /** Exclusive end, epoch seconds. */
  latestSec: number;
  /** ISO forms, for display and for the run log. */
  earliestIso: string;
  latestIso: string;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export const WINDOWS: WindowDef[] = [
  { id: 'T1', label: '1 hour', spanMs: HOUR_MS, snap: 'hour' },
  { id: 'T2', label: '4 hours', spanMs: 4 * HOUR_MS, snap: 'hour' },
  { id: 'T3', label: '8 hours', spanMs: 8 * HOUR_MS, snap: 'hour' },
  { id: 'T4', label: '12 hours', spanMs: 12 * HOUR_MS, snap: 'hour' },
  { id: 'T5', label: '24 hours', spanMs: DAY_MS, snap: 'day' },
  { id: 'T6', label: '2 days', spanMs: 2 * DAY_MS, snap: 'day' },
  { id: 'T7', label: '7 days', spanMs: 7 * DAY_MS, snap: 'day' },
  { id: 'T8', label: '14 days', spanMs: 14 * DAY_MS, snap: 'day' },
];

/** End of the window: the most recent fully-elapsed hour or UTC day. */
function snappedEndMs(anchorMs: number, snap: SnapUnit): number {
  const unit = snap === 'hour' ? HOUR_MS : DAY_MS;
  return Math.floor(anchorMs / unit) * unit - unit;
}

/** Resolve one window against a fixed anchor. */
export function resolveWindow(def: WindowDef, anchorMs: number): ResolvedWindow {
  const latestMs = snappedEndMs(anchorMs, def.snap);
  const earliestMs = latestMs - def.spanMs;
  return {
    ...def,
    earliestSec: Math.floor(earliestMs / 1000),
    latestSec: Math.floor(latestMs / 1000),
    earliestIso: new Date(earliestMs).toISOString(),
    latestIso: new Date(latestMs).toISOString(),
  };
}

/**
 * Resolve every window against ONE anchor, so a matrix run is internally
 * consistent even if it straddles an hour or day boundary.
 */
export function resolveWindows(defs: WindowDef[], anchorMs: number): ResolvedWindow[] {
  return defs.map((def) => resolveWindow(def, anchorMs));
}

/** Compact bounds label for tables: "2026-09-23 06:00 → 07:00Z". */
export function formatBounds(window: ResolvedWindow): string {
  const start = window.earliestIso.replace('T', ' ').slice(0, 16);
  const end = window.latestIso.slice(11, 16);
  return `${start} → ${end}Z`;
}
