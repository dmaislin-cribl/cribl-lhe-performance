import { describe, expect, it } from 'vitest';
import {
  EMPTY_LIBRARY,
  MAX_SELECTED,
  canSelectMore,
  isRunnable,
  deleteSearch,
  deriveDataset,
  duplicateSearch,
  isSelected,
  makeSearch,
  normalizeLibrary,
  searchWarnings,
  seedLibrary,
  selectOnly,
  selectedSearches,
  toggleSelected,
  uniqueName,
  upsertSearch,
  validateSearch,
  type SearchLibrary,
} from './searches';

function library(count = 3): SearchLibrary {
  const searches = Array.from({ length: count }, (_, index) => ({
    ...makeSearch({ name: `S${index}`, text: `dataset="d${index}"\n| summarize count()` }),
    id: `id${index}`,
  }));
  return { searches, selectedIds: [searches[0].id] };
}

describe('deriveDataset', () => {
  it('reads quoted, single-quoted and bare forms', () => {
    expect(deriveDataset('dataset="Fortinet_Syslog"\n| where x')).toBe('Fortinet_Syslog');
    expect(deriveDataset("dataset='my.set'")).toBe('my.set');
    expect(deriveDataset('dataset=cribl_edge_metrics | count')).toBe('cribl_edge_metrics');
  });

  it('handles a comma-separated list and surrounding whitespace', () => {
    expect(deriveDataset('dataset = a,b,c\n| count')).toBe('a,b,c');
  });

  it('returns empty rather than throwing when there is no dataset term', () => {
    expect(deriveDataset('| summarize count()')).toBe('');
  });
});

describe('normalizeLibrary', () => {
  it('returns the empty library from nothing, inventing no sample search', () => {
    const normalized = normalizeLibrary(null);
    expect(normalized.searches).toEqual([]);
    expect(normalized.selectedIds).toEqual([]);
  });

  it('keeps a blank draft but refuses to leave it selected', () => {
    const normalized = normalizeLibrary({
      searches: [
        { ...makeSearch({ name: 'Draft', text: '   ' }), id: 'blank' },
        { ...makeSearch({ text: 'dataset="d" | count' }), id: 'ok' },
      ],
      selectedIds: ['blank', 'ok'],
    });
    // The draft survives the reload — its name and notes were the operator's work.
    expect(normalized.searches.map((entry) => entry.id)).toEqual(['blank', 'ok']);
    expect(isRunnable(normalized.searches[0])).toBe(false);
    // But it cannot arm the run button, so only the runnable one stays selected.
    expect(normalized.selectedIds).toEqual(['ok']);
  });

  it('migrates the older dataset+query shape into one text field', () => {
    const normalized = normalizeLibrary({
      searches: [{ id: 'old', name: 'Old', dataset: 'Fortinet_Syslog', query: 'where a == 1' }],
    } as unknown as Partial<SearchLibrary>);
    expect(normalized.searches[0].text).toBe('dataset="Fortinet_Syslog"\n| where a == 1');
  });

  it('caps the selection at the documented maximum and de-duplicates it', () => {
    const base = library(5);
    const normalized = normalizeLibrary({
      searches: base.searches,
      selectedIds: ['id0', 'id0', 'id1', 'id2', 'id3', 'missing'],
    });
    expect(normalized.selectedIds).toEqual(['id0', 'id1', 'id2'].slice(0, MAX_SELECTED));
  });
});

describe('seedLibrary', () => {
  it("carries a legacy single query over as the operator's own import", () => {
    const seeded = seedLibrary({ query: 'where host == "a"', dataset: 'Other' });
    expect(seeded.searches[0].text).toBe('dataset="Other"\n| where host == "a"');
    expect(seeded.selectedIds).toHaveLength(1);
  });

  it('does not double the dataset term when the legacy query already had one', () => {
    const seeded = seedLibrary({ query: 'dataset="X" | count', dataset: 'Other' });
    expect(seeded.searches[0].text).toBe('dataset="X" | count');
  });

  it('creates nothing when there is nothing to migrate', () => {
    // The whole point of shipping empty: no default query can be run by accident.
    expect(seedLibrary(null)).toEqual(EMPTY_LIBRARY);
    expect(seedLibrary({ query: '   ' }).searches).toEqual([]);
  });

  it('keeps the logic rather than inventing a dataset the operator never named', () => {
    expect(seedLibrary({ query: 'where host == "a"' }).searches[0].text).toBe('where host == "a"');
  });
});

describe('run selection', () => {
  it('adds up to the cap and refuses beyond it', () => {
    let lib = library(5);
    lib = toggleSelected(lib, 'id1');
    lib = toggleSelected(lib, 'id2');
    expect(lib.selectedIds).toEqual(['id0', 'id1', 'id2']);
    expect(canSelectMore(lib)).toBe(false);
    // Unchanged rather than silently dropping one, so the caller can explain.
    expect(toggleSelected(lib, 'id3')).toBe(lib);
  });

  it('allows emptying the selection — an armed-at-nothing lab is legitimate', () => {
    const lib = toggleSelected(library(), 'id0');
    expect(lib.selectedIds).toEqual([]);
  });

  it('refuses to select a search with no logic in it', () => {
    const base = library(1);
    const blank = { ...makeSearch({ name: 'Draft', text: '' }), id: 'blank' };
    const lib: SearchLibrary = { searches: [...base.searches, blank], selectedIds: [] };
    expect(toggleSelected(lib, 'blank')).toBe(lib);
    expect(selectOnly(lib, 'blank')).toBe(lib);
  });

  it('removes a selected member when others remain', () => {
    let lib = toggleSelected(library(3), 'id1');
    lib = toggleSelected(lib, 'id0');
    expect(lib.selectedIds).toEqual(['id1']);
  });

  it('ignores an unknown id', () => {
    const lib = library();
    expect(toggleSelected(lib, 'nope')).toBe(lib);
    expect(selectOnly(lib, 'nope')).toBe(lib);
  });

  it('returns selected searches in library order, not click order', () => {
    let lib = library(3);
    lib = toggleSelected(lib, 'id2');
    lib = toggleSelected(lib, 'id1');
    expect(selectedSearches(lib).map((entry) => entry.id)).toEqual(['id0', 'id1', 'id2']);
  });

  it('selectOnly replaces the whole selection', () => {
    const lib = selectOnly(toggleSelected(library(3), 'id1'), 'id2');
    expect(lib.selectedIds).toEqual(['id2']);
    expect(isSelected(lib, 'id0')).toBe(false);
  });
});

describe('upsertSearch', () => {
  it('adds a new search and preserves createdAt on edit', () => {
    const lib = library(1);
    const created = lib.searches[0];
    const edited = upsertSearch(lib, { ...created, name: 'Renamed' }, Date.parse('2026-10-01T00:00:00Z'));
    expect(edited.searches).toHaveLength(1);
    expect(edited.searches[0].name).toBe('Renamed');
    expect(edited.searches[0].createdAt).toBe(created.createdAt);
    expect(edited.searches[0].updatedAt).toBe('2026-10-01T00:00:00.000Z');
  });

  it('does not mutate the library it was given', () => {
    const lib = library(1);
    const before = lib.searches[0].name;
    upsertSearch(lib, { ...lib.searches[0], name: 'Changed' });
    expect(lib.searches[0].name).toBe(before);
  });
});

describe('deleteSearch', () => {
  it('will empty the library, since starting over is the operator\'s call', () => {
    const lib = deleteSearch(library(1), 'id0');
    expect(lib.searches).toEqual([]);
    expect(lib.selectedIds).toEqual([]);
  });

  it('ignores an id that is not in the library', () => {
    const lib = library(1);
    expect(deleteSearch(lib, 'nope')).toBe(lib);
  });

  it('deselects the deleted search without substituting another', () => {
    const lib = deleteSearch(library(3), 'id0');
    expect(lib.searches.map((entry) => entry.id)).toEqual(['id1', 'id2']);
    // Nothing is promoted in its place: silently arming a different search is how
    // an operator ends up measuring a case they did not choose.
    expect(lib.selectedIds).toEqual([]);
  });

  it('leaves an unrelated selection alone', () => {
    const lib = deleteSearch(toggleSelected(library(3), 'id2'), 'id1');
    expect(lib.selectedIds).toEqual(['id0', 'id2']);
  });
});

describe('duplicateSearch and uniqueName', () => {
  it('copies the text under a distinct name', () => {
    const { library: next, created } = duplicateSearch(library(1), 'id0');
    expect(created?.name).toBe('S0 copy');
    expect(created?.text).toBe(next.searches[0].text);
    expect(next.searches).toHaveLength(2);
  });

  it('suffixes a name that is already taken', () => {
    const lib = library(1);
    expect(uniqueName(lib, 'S0')).toBe('S0 2');
    // Excluding the holder means renaming to your own name is not a clash.
    expect(uniqueName(lib, 'S0', 'id0')).toBe('S0');
  });
});

describe('validateSearch', () => {
  const lib = library(2);

  it('accepts a distinct, non-empty draft', () => {
    expect(validateSearch(lib, { id: 'new', name: 'Fresh', text: 'dataset="d" | count' })).toBeNull();
  });

  it('rejects a blank name, blank text and a duplicate name', () => {
    expect(validateSearch(lib, { id: 'new', name: ' ', text: 'x' })).toMatch(/name is required/i);
    expect(validateSearch(lib, { id: 'new', name: 'Fresh', text: '  ' })).toMatch(/empty/i);
    expect(validateSearch(lib, { id: 'new', name: 's0', text: 'x' })).toMatch(/already uses that name/i);
  });

  it('does not treat a search as clashing with itself', () => {
    expect(validateSearch(lib, { id: 'id0', name: 'S0', text: 'x' })).toBeNull();
  });
});

describe('searchWarnings', () => {
  it('flags a search that sets its own time bounds', () => {
    expect(searchWarnings('dataset="d" earliest=-1h | count').join(' ')).toMatch(/time bounds/i);
    expect(searchWarnings('dataset="d" | where _time > 5').join(' ')).toMatch(/time bounds/i);
  });

  it('flags a missing dataset term', () => {
    expect(searchWarnings('| count').join(' ')).toMatch(/no dataset/i);
  });

  it('says nothing about a well-formed search', () => {
    expect(searchWarnings('dataset="d"\n| summarize count()')).toEqual([]);
  });
});
