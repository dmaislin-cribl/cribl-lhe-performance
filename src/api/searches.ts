/**
 * The saved-search library.
 *
 * The lab used to hold exactly one query, in the config record. That made a
 * second test case destructive: measuring a different search meant overwriting
 * the only one there was, and the run log then contained timings for a query
 * nobody could read back. A benchmark needs a *set* of named test cases that
 * stay put, so a tier comparison can be re-run months later against the same
 * definition.
 *
 * A saved search is **one field**: the complete KQL, `dataset=` term included.
 * An earlier cut split it into a dataset input plus a logic box, with a
 * read-only preview of the two stitched together — three widgets for one
 * artifact, and the thing the operator was asked to reason about was the one
 * they could not edit. The dataset is *derived* from the text for provenance
 * instead (see `deriveDataset`), which also means `union`, a comma-separated
 * dataset list, or any other shape the platform accepts is expressible.
 *
 * Up to `MAX_SELECTED` searches can be selected at once, so one run session can
 * measure several cases against the same engine tier without the operator
 * babysitting the picker between matrices.
 *
 * Deliberate non-goals:
 *
 *   - The library never edits the run log. Runs reference a query by content
 *     hash (`RunLog.queries`), so deleting or rewriting a saved search cannot
 *     orphan or retroactively relabel a measurement.
 *   - Nothing here mutates its input. Every operation returns a new library, so
 *     React state updates and the KV write see the same value.
 */

import { kvGet, kvPut } from './kv';

const SEARCHES_KEY = 'searches';
/** Legacy single-query location, read once to seed the library. */
const CONFIG_KEY = 'settings';

/** Guards the KV value against an accidental paste of something enormous. */
export const MAX_SEARCHES = 50;
export const MAX_NAME_LENGTH = 80;

/**
 * Cap on searches per run session. Three is the operator's request, and it is
 * also about the limit of what stays legible: a session is
 * searches × windows × (1 warm-up + repetitions) searches long, so three cases
 * over eight windows at 20 repetitions is already 504 engine runs.
 */
export const MAX_SELECTED = 3;

export interface SavedSearch {
  id: string;
  name: string;
  /** The complete search, `dataset=` term included. No time bounds. */
  text: string;
  /** Operator notes: what this case is meant to exercise. */
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchLibrary {
  searches: SavedSearch[];
  /** Searches this run session measures. Always 1..MAX_SELECTED live members. */
  selectedIds: string[];
}

export const DEFAULT_DATASET = 'Fortinet_Syslog';

export const DEFAULT_SEARCH_TEXT =
  `dataset="${DEFAULT_DATASET}"\n` +
  '| where hostname has "baidu" or hostname has "qq" or hostname has "aliyuncs"\n' +
  '   or hostname has "yixinfa" or hostname has "pingxiaobao"\n' +
  '   or hostname has "tougeping" or hostname has "eselltech"\n' +
  '| summarize events = count() by hostname\n' +
  '| sort by events desc';

export const DEFAULT_SEARCH_NAME = 'Seven-term hostname scan';

/** Starting point for a new case: runnable as-is, so it can be measured before it is edited. */
export const NEW_SEARCH_TEXT = `dataset="${DEFAULT_DATASET}"\n| summarize events = count()`;

/**
 * Ids must survive a rename, so they are not derived from the name. Random
 * suffix rather than a bare counter: two browser tabs can both add a search
 * before either write lands, and a counter would collide.
 */
export function newSearchId(now = Date.now()): string {
  return `s-${now.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Dataset named by a search, for run provenance and the mixed-dataset warning.
 *
 * Derived, never authoritative: it is a label on a recorded run, not something
 * the app sends. So this stays lenient — an unparseable search still runs, and
 * records an empty dataset rather than being rejected. Quoted, bare, and
 * comma-separated forms all appear in real Cribl searches.
 */
export function deriveDataset(text: string): string {
  const match = /\bdataset\s*=\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.*,:-]+))/i.exec(text);
  if (!match) return '';
  return (match[1] ?? match[2] ?? match[3] ?? '').trim();
}

export function makeSearch(
  fields: Partial<Pick<SavedSearch, 'name' | 'text' | 'notes'>> = {},
  nowMs = Date.now(),
): SavedSearch {
  const now = new Date(nowMs).toISOString();
  return {
    id: newSearchId(nowMs),
    name: fields.name ?? 'New search',
    text: fields.text ?? NEW_SEARCH_TEXT,
    notes: fields.notes ?? '',
    createdAt: now,
    updatedAt: now,
  };
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length ? value : fallback;
}

/**
 * Coerce a stored record into a usable library.
 *
 * Also migrates the earlier `{ dataset, query }` shape by stitching the two into
 * one `text`, so a library written by a previous build is not silently dropped.
 *
 * A library with no searches, or a selection pointing at deleted ones, would
 * leave the workbench with nothing to run and no way to recover through the UI,
 * so both are repaired here rather than defended against at every read site.
 */
export function normalizeLibrary(stored: Partial<SearchLibrary> | null): SearchLibrary {
  const raw = Array.isArray(stored?.searches) ? stored.searches : [];
  const seen = new Set<string>();
  const searches: SavedSearch[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<SavedSearch> & { dataset?: unknown; query?: unknown };
    const text = textOf(candidate);
    // A search with no logic cannot be measured; dropping it beats offering it.
    if (!text.trim()) continue;
    const id = asString(candidate.id, newSearchId());
    if (seen.has(id)) continue;
    seen.add(id);
    const created = asString(candidate.createdAt, new Date(0).toISOString());
    searches.push({
      id,
      name: asString(candidate.name, 'Untitled search').slice(0, MAX_NAME_LENGTH),
      text,
      notes: typeof candidate.notes === 'string' ? candidate.notes : '',
      createdAt: created,
      updatedAt: asString(candidate.updatedAt, created),
    });
    if (searches.length >= MAX_SEARCHES) break;
  }

  if (!searches.length) {
    searches.push(makeSearch({ name: DEFAULT_SEARCH_NAME, text: DEFAULT_SEARCH_TEXT }));
  }

  const live = new Set(searches.map((entry) => entry.id));
  const selectedIds = (Array.isArray(stored?.selectedIds) ? stored.selectedIds : [])
    .filter((id): id is string => typeof id === 'string' && live.has(id))
    .filter((id, index, all) => all.indexOf(id) === index)
    .slice(0, MAX_SELECTED);

  return { searches, selectedIds: selectedIds.length ? selectedIds : [searches[0].id] };
}

/** One search's text, whether stored as `text` or the older dataset+query pair. */
function textOf(candidate: { text?: unknown; dataset?: unknown; query?: unknown }): string {
  if (typeof candidate.text === 'string' && candidate.text.trim()) return candidate.text;
  const query = typeof candidate.query === 'string' ? candidate.query.trim() : '';
  if (!query) return '';
  const dataset = typeof candidate.dataset === 'string' && candidate.dataset ? candidate.dataset : DEFAULT_DATASET;
  return /^\s*dataset\s*=/i.test(query) ? query : `dataset="${dataset}"\n| ${query}`;
}

/** The library a workspace starts with: one runnable case, not an empty list. */
export function seedLibrary(
  legacy: { query?: string; dataset?: string } | null,
  nowMs = Date.now(),
): SearchLibrary {
  const text = textOf({ query: legacy?.query, dataset: legacy?.dataset }) || DEFAULT_SEARCH_TEXT;
  // A migrated query keeps the default name: it *is* the search the lab ran.
  const search = makeSearch({ name: DEFAULT_SEARCH_NAME, text }, nowMs);
  return { searches: [search], selectedIds: [search.id] };
}

/** Selected searches in library order, so run order matches what the list shows. */
export function selectedSearches(library: SearchLibrary): SavedSearch[] {
  const chosen = new Set(library.selectedIds);
  const hits = library.searches.filter((entry) => chosen.has(entry.id));
  return hits.length ? hits : library.searches.slice(0, 1);
}

export function isSelected(library: SearchLibrary, id: string): boolean {
  return library.selectedIds.includes(id);
}

export function canSelectMore(library: SearchLibrary): boolean {
  return library.selectedIds.length < MAX_SELECTED;
}

/**
 * Add or remove a search from the run selection. Refuses to empty the selection
 * or to exceed the cap — both would need an error path in every caller, and
 * neither is a state the UI should be able to reach.
 */
export function toggleSelected(library: SearchLibrary, id: string): SearchLibrary {
  if (!library.searches.some((entry) => entry.id === id)) return library;
  if (library.selectedIds.includes(id)) {
    if (library.selectedIds.length <= 1) return library;
    return { ...library, selectedIds: library.selectedIds.filter((entry) => entry !== id) };
  }
  if (!canSelectMore(library)) return library;
  return { ...library, selectedIds: [...library.selectedIds, id] };
}

/** Replace the whole selection, e.g. "run only this one". */
export function selectOnly(library: SearchLibrary, id: string): SearchLibrary {
  if (!library.searches.some((entry) => entry.id === id)) return library;
  return { ...library, selectedIds: [id] };
}

/** Insert or replace by id. Replacing stamps `updatedAt`; ids never change. */
export function upsertSearch(
  library: SearchLibrary,
  search: SavedSearch,
  nowMs = Date.now(),
): SearchLibrary {
  const stamped = { ...search, updatedAt: new Date(nowMs).toISOString() };
  const index = library.searches.findIndex((entry) => entry.id === search.id);
  if (index === -1) {
    if (library.searches.length >= MAX_SEARCHES) return library;
    return { ...library, searches: [...library.searches, stamped] };
  }
  const searches = library.searches.slice();
  // Preserve the original creation time: an edit is not a new test case.
  searches[index] = { ...stamped, createdAt: library.searches[index].createdAt };
  return { ...library, searches };
}

/**
 * Remove a search. The last one is never removed — an empty library leaves the
 * workbench unable to run anything, and the UI could not add one back without a
 * search to copy the shape from.
 */
export function deleteSearch(library: SearchLibrary, id: string): SearchLibrary {
  if (library.searches.length <= 1) return library;
  const index = library.searches.findIndex((entry) => entry.id === id);
  if (index === -1) return library;
  const searches = library.searches.filter((entry) => entry.id !== id);
  const kept = library.selectedIds.filter((entry) => entry !== id);
  const selectedIds = kept.length ? kept : [searches[Math.min(index, searches.length - 1)].id];
  return { searches, selectedIds };
}

/** Copy, so a variant can be measured without editing a case already run. */
export function duplicateSearch(
  library: SearchLibrary,
  id: string,
  nowMs = Date.now(),
): { library: SearchLibrary; created: SavedSearch | null } {
  const source = library.searches.find((entry) => entry.id === id);
  if (!source || library.searches.length >= MAX_SEARCHES) return { library, created: null };
  const created = makeSearch(
    { name: uniqueName(library, `${source.name} copy`), text: source.text, notes: source.notes },
    nowMs,
  );
  return { library: { ...library, searches: [...library.searches, created] }, created };
}

/** `name`, `name 2`, `name 3` … so a duplicate is never ambiguous in a picker. */
export function uniqueName(library: SearchLibrary, wanted: string, excludeId?: string): string {
  const taken = new Set(
    library.searches
      .filter((entry) => entry.id !== excludeId)
      .map((entry) => entry.name.trim().toLowerCase()),
  );
  const base = wanted.trim() || 'New search';
  if (!taken.has(base.toLowerCase())) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  return `${base} ${Date.now()}`;
}

/**
 * Reason a draft cannot be saved, or null. Names must be distinct because every
 * export and comparison label is the name — two "Hostname scan" entries make a
 * customer-facing result untraceable.
 */
export function validateSearch(
  library: SearchLibrary,
  draft: Pick<SavedSearch, 'id' | 'name' | 'text'>,
): string | null {
  if (!draft.name.trim()) return 'Name is required.';
  if (draft.name.length > MAX_NAME_LENGTH) return `Name must be ${MAX_NAME_LENGTH} characters or fewer.`;
  if (!draft.text.trim()) return 'The search is empty.';
  const clash = library.searches.some(
    (entry) => entry.id !== draft.id && entry.name.trim().toLowerCase() === draft.name.trim().toLowerCase(),
  );
  if (clash) return 'Another search already uses that name.';
  if (library.searches.length >= MAX_SEARCHES && !library.searches.some((entry) => entry.id === draft.id)) {
    return `The library holds at most ${MAX_SEARCHES} searches.`;
  }
  return null;
}

/**
 * Advisory notes about a search: things worth telling the operator that are not
 * grounds for refusing to save. Time filters are the important one — the lab
 * supplies bounds per window, so a filter baked into the text would override the
 * variable the whole experiment varies.
 */
export function searchWarnings(text: string): string[] {
  const notes: string[] = [];
  if (!deriveDataset(text)) {
    notes.push('No dataset= term found, so runs will be recorded with an empty dataset label.');
  }
  if (/\b(earliest|latest)\s*=/i.test(text) || /\b_time\s*[<>]/.test(text)) {
    notes.push(
      'This search sets its own time bounds. The lab supplies earliest/latest per window, so a bound in the text defeats the comparison.',
    );
  }
  return notes;
}

/**
 * Load the library, seeding it from the legacy single-query config the first
 * time. The legacy read is confined to this function: nothing else should treat
 * `settings.query` as live, or the two would drift.
 */
export async function loadLibrary(): Promise<SearchLibrary> {
  const stored = await kvGet<Partial<SearchLibrary>>(SEARCHES_KEY);
  if (stored?.searches?.length) return normalizeLibrary(stored);
  const legacy = await kvGet<{ query?: string; dataset?: string }>(CONFIG_KEY);
  const seeded = seedLibrary(legacy);
  // Persist immediately so the migrated id is stable across reloads; a run
  // recorded against a per-session id could not be traced back to a search.
  try {
    await saveLibrary(seeded);
  } catch {
    /* A read-only store still yields a usable in-memory library. */
  }
  return seeded;
}

export async function saveLibrary(library: SearchLibrary): Promise<void> {
  await kvPut(SEARCHES_KEY, library);
}
