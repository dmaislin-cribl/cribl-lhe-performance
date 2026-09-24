/**
 * Test window definitions and absolute bound resolution.
 *
 * The set is a *default*, not a fixture: it lives in config (`config.windows`)
 * and an operator can add, edit and delete rows. Different datasets deserve
 * different ramps — a two-week window is meaningless against a dataset with four
 * days of retention, and an engine sized for 14 TB/day is not stressed by an
 * hour. So nothing outside this module may assume eight windows or the `T1…T8`
 * ids; read the configured set instead.
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
  /**
   * Stable short id used as the sample-set key, and as the run log's `window`
   * column. Renaming an id orphans the runs already recorded under the old one —
   * they stay in the log but stop joining to any window — which is why the
   * editor warns rather than silently rewriting history.
   */
  id: string;
  /** Human label for the span, e.g. "4 hours". Derived; see `makeWindow`. */
  label: string;
  /** Width of the window in milliseconds. Derived from count × unit. */
  spanMs: number;
  /**
   * The span as the operator entered it. Stored rather than inferred from
   * `spanMs` because 24 hours and 1 day are the same duration and not the same
   * intent — the default set deliberately has a 24-hour window and no 1-day one.
   */
  spanCount: number;
  spanUnit: SnapUnit;
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

/** Largest span the editor accepts, in either unit. */
export const MAX_SPAN_COUNT = 400;
/** Windows an operator may define at once. */
export const MAX_WINDOWS = 20;

export function unitMs(unit: SnapUnit): number {
  return unit === 'hour' ? HOUR_MS : DAY_MS;
}

/**
 * Build a window from the three things an operator actually chooses, deriving
 * the label and the millisecond span.
 *
 * The label is derived rather than entered so it cannot contradict the span: a
 * window labelled "4 hours" that searches 8 is the kind of error that survives
 * all the way into a customer-facing chart.
 */
export function makeWindow(
  id: string,
  spanCount: number,
  spanUnit: SnapUnit,
  snap: SnapUnit,
): WindowDef {
  const count = Math.min(MAX_SPAN_COUNT, Math.max(1, Math.floor(spanCount) || 1));
  return {
    id,
    label: `${count} ${spanUnit}${count === 1 ? '' : 's'}`,
    spanMs: count * unitMs(spanUnit),
    spanCount: count,
    spanUnit,
    snap,
  };
}

/**
 * The window set a fresh install measures: a ramp from one hour to two weeks,
 * roughly doubling, which is enough spread to see where an engine size stops
 * scaling without being so fine that the sweep takes all day.
 *
 * These are only defaults now — the set lives in config and is editable, so
 * nothing downstream may assume eight windows or these ids. Anything that needs
 * the current set reads `config.windows`.
 */
export const DEFAULT_WINDOWS: WindowDef[] = [
  makeWindow('T1', 1, 'hour', 'hour'),
  makeWindow('T2', 4, 'hour', 'hour'),
  makeWindow('T3', 8, 'hour', 'hour'),
  makeWindow('T4', 12, 'hour', 'hour'),
  makeWindow('T5', 24, 'hour', 'day'),
  makeWindow('T6', 2, 'day', 'day'),
  makeWindow('T7', 7, 'day', 'day'),
  makeWindow('T8', 14, 'day', 'day'),
];

const SNAP_UNITS: SnapUnit[] = ['hour', 'day'];

function asSnapUnit(value: unknown, fallback: SnapUnit): SnapUnit {
  return SNAP_UNITS.includes(value as SnapUnit) ? (value as SnapUnit) : fallback;
}

/**
 * Validate a stored window set, dropping entries that could not be searched and
 * falling back to the defaults when nothing usable survives.
 *
 * Rebuilt through `makeWindow` rather than trusted field-by-field, so a record
 * written by an older version — which had no `spanCount`/`spanUnit` — comes back
 * with both, and a hand-edited KV value cannot produce a window whose label,
 * span and unit disagree. Duplicate ids are dropped rather than renamed: two
 * windows sharing an id would silently merge into one sample set.
 */
export function normalizeWindows(stored: unknown): WindowDef[] {
  if (!Array.isArray(stored)) return [...DEFAULT_WINDOWS];
  const seen = new Set<string>();
  const windows: WindowDef[] = [];
  for (const entry of stored) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Partial<WindowDef>;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    if (!id || seen.has(id)) continue;
    const spanUnit = asSnapUnit(raw.spanUnit, 'hour');
    // Pre-`spanCount` records carry only `spanMs`; recover the count from it.
    const count =
      typeof raw.spanCount === 'number' && Number.isFinite(raw.spanCount) && raw.spanCount >= 1
        ? raw.spanCount
        : typeof raw.spanMs === 'number' && raw.spanMs > 0
          ? Math.round(raw.spanMs / unitMs(spanUnit))
          : 0;
    if (count < 1) continue;
    seen.add(id);
    windows.push(makeWindow(id, count, spanUnit, asSnapUnit(raw.snap, spanUnit)));
    if (windows.length >= MAX_WINDOWS) break;
  }
  if (!windows.length) return [...DEFAULT_WINDOWS];
  // Ascending by span, for the same reason the engine sweep climbs: a broken
  // query or a dataset with no data is discovered on the one-hour window, not
  // twenty minutes into a fourteen-day one. It also keeps the comparison chart's
  // x-axis monotonic however the operator happened to enter the rows.
  return windows.sort((a, b) => a.spanMs - b.spanMs);
}

/**
 * Next unused `T<n>` id, so adding a window does not require the operator to
 * invent an id and does not reuse one that runs are already recorded under.
 */
export function nextWindowId(existing: WindowDef[]): string {
  const taken = new Set(existing.map((window) => window.id));
  for (let n = 1; n <= MAX_WINDOWS + existing.length; n += 1) {
    if (!taken.has(`T${n}`)) return `T${n}`;
  }
  return `T${Date.now()}`;
}

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
