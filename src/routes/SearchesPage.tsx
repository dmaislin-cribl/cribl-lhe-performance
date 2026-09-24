/**
 * Manage the saved-search library: add, edit, duplicate, delete, and choose
 * which cases (up to MAX_SELECTED) the next run session measures.
 *
 * One editor field holds the complete search. Edits are held as a draft and
 * committed by an explicit Save: the workbench auto-saves its config because
 * losing a repetition count is harmless, but a test definition is what
 * measurements are attributed to — silently rewriting it as the operator types
 * would change what a customer-facing number means mid-keystroke.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { loadRunLog, type RunRecord } from '../api/appSettings';
import {
  MAX_SEARCHES,
  MAX_SELECTED,
  SEARCH_PLACEHOLDER,
  canSelectMore,
  isRunnable,
  deleteSearch,
  deriveDataset,
  duplicateSearch,
  isSelected,
  loadLibrary,
  makeSearch,
  saveLibrary,
  searchWarnings,
  selectOnly,
  toggleSelected,
  uniqueName,
  upsertSearch,
  validateSearch,
  type SavedSearch,
  type SearchLibrary,
} from '../api/searches';
import StatusBanner from '../components/StatusBanner';
import s from './SearchesPage.module.css';

type Draft = Pick<SavedSearch, 'id' | 'name' | 'text' | 'notes'>;

function toDraft(search: SavedSearch): Draft {
  const { id, name, text, notes } = search;
  return { id, name, text, notes };
}

function countRuns(runs: RunRecord[], id: string): number {
  return runs.filter((run) => run.searchId === id && run.measured).length;
}

export default function SearchesPage() {
  const [library, setLibrary] = useState<SearchLibrary | null>(null);
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [editingId, setEditingId] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pendingDelete, setPendingDelete] = useState<SavedSearch | null>(null);

  useEffect(() => {
    void loadLibrary().then((loaded) => {
      setLibrary(loaded);
      // The library ships empty, so there may be nothing to open. Leaving the
      // editor closed is the correct first screen — see the empty state below.
      const first = loaded.searches.find((entry) => entry.id === loaded.selectedIds[0]) ?? loaded.searches[0];
      if (!first) return;
      setEditingId(first.id);
      setDraft(toDraft(first));
    });
    // Run counts are read-only context: they tell the operator what a delete
    // would leave behind in the history.
    void loadRunLog().then((log) => setRuns(log.runs));
  }, []);

  const editing = useMemo(
    () => library?.searches.find((entry) => entry.id === editingId) ?? null,
    [library, editingId],
  );

  const dirty = useMemo(() => {
    if (!editing || !draft) return false;
    return draft.name !== editing.name || draft.text !== editing.text || draft.notes !== editing.notes;
  }, [editing, draft]);

  /** Persist and adopt in one step so the UI can never show an unsaved library. */
  const commit = useCallback(async (next: SearchLibrary, note: string) => {
    setLibrary(next);
    setError('');
    try {
      await saveLibrary(next);
      setMessage(note);
      window.setTimeout(() => setMessage(''), 2500);
    } catch (cause) {
      setError(
        `${cause instanceof Error ? cause.message : String(cause)} — the change is applied in this tab only.`,
      );
    }
  }, []);

  const openForEdit = useCallback(
    (id: string) => {
      const target = library?.searches.find((entry) => entry.id === id);
      if (!target) return;
      setEditingId(id);
      setDraft(toDraft(target));
      setError('');
    },
    [library],
  );

  const save = useCallback(() => {
    if (!library || !draft) return;
    const reason = validateSearch(library, draft);
    if (reason) {
      setError(reason);
      return;
    }
    const base = library.searches.find((entry) => entry.id === draft.id);
    const merged: SavedSearch = { ...(base ?? makeSearch()), ...draft, name: draft.name.trim() };
    const next = upsertSearch(library, merged);
    setDraft(toDraft(merged));
    void commit(next, `Saved “${merged.name}”.`);
  }, [library, draft, commit]);

  const add = useCallback(() => {
    if (!library) return;
    const created = makeSearch({ name: uniqueName(library, 'New search') });
    setEditingId(created.id);
    setDraft(toDraft(created));
    void commit(upsertSearch(library, created), `Added “${created.name}”. Edit it and save.`);
  }, [library, commit]);

  const duplicate = useCallback(() => {
    if (!library || !editing) return;
    const { library: next, created } = duplicateSearch(library, editing.id);
    if (!created) {
      setError(`The library holds at most ${MAX_SEARCHES} searches.`);
      return;
    }
    setEditingId(created.id);
    setDraft(toDraft(created));
    void commit(next, `Duplicated as “${created.name}”.`);
  }, [library, editing, commit]);

  const confirmDelete = useCallback(() => {
    if (!library || !pendingDelete) return;
    const next = deleteSearch(library, pendingDelete.id);
    setPendingDelete(null);
    // Deleting the last search is allowed, so there may be nothing left to edit.
    const nowEditing = next.searches.find((entry) => entry.id === editingId) ?? next.searches[0] ?? null;
    setEditingId(nowEditing?.id ?? '');
    setDraft(nowEditing ? toDraft(nowEditing) : null);
    void commit(next, `Deleted “${pendingDelete.name}”. Its recorded runs are unchanged.`);
  }, [library, pendingDelete, editingId, commit]);

  const toggle = useCallback(
    (id: string) => {
      if (!library) return;
      const next = toggleSelected(library, id);
      if (next === library) {
        // Two different refusals, and telling them apart is the whole value of the
        // message: one is a cap to clear, the other is a search with nothing in it.
        const target = library.searches.find((entry) => entry.id === id);
        setError(
          target && !isRunnable(target)
            ? `“${target.name}” has no search text yet, so there is nothing to measure. Write it and save first.`
            : `A run session measures at most ${MAX_SELECTED} searches. Clear one first.`,
        );
        return;
      }
      setError('');
      void commit(next, 'Run selection updated.');
    },
    [library, commit],
  );

  if (!library) {
    return (
      <div className={s.page}>
        <h1>Test searches</h1>
        <p className={s.intro}>Loading the library…</p>
      </div>
    );
  }

  const advisories = draft ? searchWarnings(draft.text) : [];
  const dataset = draft ? deriveDataset(draft.text) : '';
  const editingRuns = editing ? countRuns(runs, editing.id) : 0;
  const selectedCount = library.selectedIds.length;

  return (
    <div className={s.page}>
      <div className={s.head}>
        <div>
          <h1>Test searches</h1>
          <p className={s.intro}>
            Each saved search is one complete test case — the whole KQL, <code>dataset=</code> term
            included, with no time bounds. The lab supplies earliest/latest per window. Editing or
            deleting a case never alters runs already recorded: the run log stores the exact query
            text each measurement used, keyed by content hash.
          </p>
        </div>
        <Link className={s.back} to="/">
          Back to the workbench
        </Link>
      </div>

      {message && <StatusBanner kind="info">{message}</StatusBanner>}
      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      <div className={s.layout}>
        <aside className={s.list}>
          <div className={s.listHeader}>
            <span>
              {selectedCount} of {MAX_SELECTED} selected to run
            </span>
            <button onClick={add} disabled={library.searches.length >= MAX_SEARCHES}>
              + Add
            </button>
          </div>

          {!library.searches.length && (
            <p className={s.listEmpty}>
              Nothing saved yet. <b>+ Add</b> creates an empty case for you to write.
            </p>
          )}

          {library.searches.map((entry) => {
            const chosen = isSelected(library, entry.id);
            const runnable = isRunnable(entry);
            return (
              <div
                key={entry.id}
                className={`${s.listItem} ${entry.id === editingId ? s.listItemEditing : ''}`}
              >
                <label className={s.pick}>
                  <input
                    type="checkbox"
                    checked={chosen}
                    onChange={() => toggle(entry.id)}
                    disabled={!chosen && (!runnable || !canSelectMore(library))}
                    aria-label={`Include ${entry.name} in the next run session`}
                  />
                </label>
                <button className={s.listBody} onClick={() => openForEdit(entry.id)}>
                  <span className={s.listName}>{entry.name}</span>
                  <span className={s.listMeta}>
                    {runnable
                      ? `${deriveDataset(entry.text) || 'no dataset term'} · ${countRuns(runs, entry.id)} measured runs`
                      : 'empty draft — not runnable'}
                  </span>
                </button>
              </div>
            );
          })}

          <p className={s.listNote}>
            The checkbox picks what the next run session measures — up to {MAX_SELECTED} cases per
            session, run in this order for each window. Clicking a name opens it for editing.
          </p>
        </aside>

        {!draft && (
          <section className={s.editor}>
            <div className={s.firstRun}>
              <h2>No test searches yet</h2>
              <p>
                This app ships with none on purpose. A benchmark has to measure <b>your</b> searches
                against <b>your</b> data — a sample query that arrived in the box is the one most
                likely to get run by accident and reported as a result.
              </p>
              <p className={s.muted}>
                A test case is the complete KQL with its <code>dataset=</code> term and{' '}
                <b>no time bounds</b>: the lab appends earliest/latest per window, which is the
                variable the whole comparison varies.
              </p>
              <button className={s.save} onClick={add}>
                Add your first search
              </button>
            </div>
          </section>
        )}

        {draft && (
        <section className={s.editor}>
          <div className={s.editorHeader}>
            <div>
              <h2>{editing?.name ?? 'Search'}</h2>
              <span className={s.muted}>
                {editing && isSelected(library, editing.id)
                  ? 'Selected for the next run session.'
                  : 'Not selected — it will not run.'}
                {dirty && <b className={s.dirty}> Unsaved edits</b>}
              </span>
            </div>
            <div className={s.editorActions}>
              {editing && !isSelected(library, editing.id) && (
                <button onClick={() => void commit(selectOnly(library, editing.id), `Running “${editing.name}” only.`)}>
                  Run only this
                </button>
              )}
              <button onClick={duplicate}>Duplicate</button>
              <button
                className={s.danger}
                onClick={() => editing && setPendingDelete(editing)}
              >
                Delete
              </button>
            </div>
          </div>

          <label htmlFor="name">Name</label>
          <input
            id="name"
            className={s.field}
            value={draft.name}
            maxLength={80}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          <span className={s.hint}>
            The label in the run log, the comparison view and every export, so it has to be distinct.
          </span>

          <label htmlFor="text">Complete search</label>
          <textarea
            id="text"
            className={`${s.field} ${s.code}`}
            rows={12}
            spellCheck={false}
            value={draft.text}
            placeholder={SEARCH_PLACEHOLDER}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          />
          <span className={s.hint}>
            Exactly what the engine receives, apart from the per-window bounds appended at run start.
            Dataset read from the text: <b>{dataset || '—'}</b>.
          </span>

          {advisories.map((note) => (
            <div className={s.advice} key={note}>
              <span className={s.adviceIcon} aria-hidden="true">
                !
              </span>
              <span>
                <b>Check this: </b>
                {note}
              </span>
            </div>
          ))}

          <label htmlFor="notes">Notes</label>
          <textarea
            id="notes"
            className={s.field}
            rows={2}
            value={draft.notes}
            onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
          />
          <span className={s.hint}>
            What this case is meant to exercise. Kept with the search, never measured.
          </span>

          {editingRuns > 0 && dirty && (
            <p className={s.note}>
              This case already has {editingRuns} measured runs. Saving a changed search does not
              invalidate them, but the comparison page will flag the mix — duplicate instead if you
              want both measured side by side.
            </p>
          )}

          <div className={s.saveRow}>
            <button className={s.save} onClick={save} disabled={!dirty}>
              {dirty ? 'Save changes' : 'Saved'}
            </button>
            <button onClick={() => editing && setDraft(toDraft(editing))} disabled={!dirty}>
              Revert
            </button>
          </div>
        </section>
        )}
      </div>

      {/*
        In-app dialog rather than window.confirm: a sandboxed iframe can suppress
        native modals, and a suppressed confirm() returns false, which would make
        Delete look like a dead button.
      */}
      {pendingDelete && (
        <div className={s.modalScrim} role="presentation" onClick={() => setPendingDelete(null)}>
          <div
            className={s.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="delete-title">Delete “{pendingDelete.name}”?</h2>
            <p>
              The saved definition is removed from the library. The{' '}
              <b>{countRuns(runs, pendingDelete.id)} measured runs</b> already recorded against it stay
              in the run log with their query text intact, but nothing will point back to a named case
              — so re-running this test later means writing it again.
            </p>
            <div className={s.modalActions}>
              <button onClick={() => setPendingDelete(null)}>Cancel</button>
              <button className={s.danger} onClick={confirmDelete}>
                Delete search
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
