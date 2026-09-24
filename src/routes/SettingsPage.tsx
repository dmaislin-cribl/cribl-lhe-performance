import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  DEFAULT_CONFIG,
  loadConfig,
  loadRunLog,
  saveConfig,
  type LabConfig,
} from '../api/appSettings';
import { P95_MIN_SAMPLES } from '../api/stats';
import { ENGINE_TIERS, describeTier, labelTier, tierDef } from '../api/tiers';
import {
  MAX_SPAN_COUNT,
  MAX_WINDOWS,
  makeWindow,
  nextWindowId,
  normalizeWindows,
  type SnapUnit,
  type WindowDef,
} from '../api/windows';
import StatusBanner from '../components/StatusBanner';
import s from './SettingsPage.module.css';

export default function SettingsPage() {
  const [config, setConfig] = useState<LabConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');
  /** Window ids that already have measured runs — see `measuredIds`. */
  const [runWindows, setRunWindows] = useState<string[]>([]);

  // Load the same config record the workbench uses, so the two pages cannot
  // disagree about the dataset or repetition count.
  useEffect(() => {
    void loadConfig().then(setConfig);
    // Read only to warn before an edit orphans existing measurements; this page
    // never writes the run log.
    void loadRunLog().then((log) =>
      setRunWindows(log.runs.filter((run) => run.measured).map((run) => run.window)),
    );
  }, []);

  const measuredIds = useMemo(() => new Set(runWindows), [runWindows]);

  /**
   * Apply a field change to one window, rebuilding it through `makeWindow` so the
   * label and millisecond span cannot drift from the count and unit.
   *
   * A rename carries the window's repetition override with it — otherwise renaming
   * a row silently reverts it to the default count, which is a change to what the
   * next run measures that the operator never asked for.
   */
  const editWindow = (id: string, patch: Partial<WindowDef>) => {
    const windows = config.windows.map((def) =>
      def.id === id
        ? makeWindow(
            patch.id !== undefined ? patch.id : def.id,
            patch.spanCount ?? def.spanCount,
            patch.spanUnit ?? def.spanUnit,
            patch.snap ?? def.snap,
          )
        : def,
    );
    const nextId = patch.id?.trim();
    let windowRepetitions = config.windowRepetitions;
    if (nextId !== undefined && nextId !== id && id in windowRepetitions) {
      const { [id]: moved, ...rest } = windowRepetitions;
      windowRepetitions = nextId ? { ...rest, [nextId]: moved } : rest;
    }
    setConfig({ ...config, windows, windowRepetitions });
  };

  /** Drop a window, and its override with it, so a re-added id starts clean. */
  const removeWindow = (id: string) => {
    const windowRepetitions = { ...config.windowRepetitions };
    delete windowRepetitions[id];
    setConfig({
      ...config,
      windows: config.windows.filter((def) => def.id !== id),
      windowRepetitions,
    });
  };

  const save = async () => {
    try {
      // Normalised on the way out as well as in: it is what drops a row whose id
      // was cleared or duplicated while editing, and what puts the set back into
      // ascending span order. Written back to state so the form shows what was
      // actually stored rather than what was typed.
      const windows = normalizeWindows(config.windows);
      const next = { ...config, windows };
      setConfig(next);
      await saveConfig(next);
      setError('');
      setSaved(true);
      window.setTimeout(() => setSaved(false), 2000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className={s.page}>
      <h1>Lab configuration</h1>
      <p className={s.intro}>
        Parameters are stored in the app-scoped KV store and reused by the test workbench. Changing
        them does not alter runs already recorded — the run log keeps the dataset, search group and
        query each of its runs was measured under. The searches themselves live in{' '}
        <Link to="/searches">Test searches</Link>, not here.
      </p>

      {saved && <StatusBanner kind="info">Configuration saved</StatusBanner>}
      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      <label htmlFor="searchGroup">Search worker group</label>
      <input
        id="searchGroup"
        className={s.field}
        value={config.searchGroup}
        onChange={(event) => setConfig({ ...config, searchGroup: event.target.value })}
      />
      <span className={s.hint}>
        The <code>:gid</code> in the search API path — <code>default_search</code> in a stock Cribl
        Cloud org. Both the search jobs and the Lakehouse engine inventory are read through this
        group, so a wrong value shows up as an empty engine list.
      </span>

      <label htmlFor="repetitions">Measured repetitions per window</label>
      <input
        id="repetitions"
        className={s.field}
        type="number"
        min={1}
        max={200}
        value={config.repetitions}
        onChange={(event) =>
          setConfig({
            ...config,
            repetitions: Math.min(200, Math.max(1, Number(event.target.value) || 1)),
          })
        }
      />
      <span className={s.hint}>
        The default for every window without its own count below. Each window also runs one
        unmeasured warm-up. A p95 is only reported at {P95_MIN_SAMPLES}+ repetitions — below that,
        nearest-rank p95 is arithmetically identical to the maximum, so the summary shows
        min/median/max instead.
      </span>

      <label>Time windows</label>
      <div className={s.windowTable}>
        <div className={s.windowHead}>
          <span>Id</span>
          <span>Span</span>
          <span>Unit</span>
          <span>Snap to</span>
          <span>Runs</span>
          <span />
        </div>
        {config.windows.map((def) => {
          const override = config.windowRepetitions[def.id];
          const hasRuns = measuredIds.has(def.id);
          return (
            <div key={def.id} className={s.windowRow}>
              <input
                className={s.windowId}
                aria-label={`Window id for ${def.label}`}
                value={def.id}
                onChange={(event) => editWindow(def.id, { id: event.target.value })}
              />
              <input
                className={s.windowNum}
                aria-label={`Span for ${def.id}`}
                type="number"
                min={1}
                max={MAX_SPAN_COUNT}
                value={def.spanCount}
                onChange={(event) =>
                  editWindow(def.id, { spanCount: Number(event.target.value) || 1 })
                }
              />
              <select
                className={s.windowSel}
                aria-label={`Span unit for ${def.id}`}
                value={def.spanUnit}
                onChange={(event) =>
                  editWindow(def.id, { spanUnit: event.target.value as SnapUnit })
                }
              >
                <option value="hour">hours</option>
                <option value="day">days</option>
              </select>
              <select
                className={s.windowSel}
                aria-label={`Snap unit for ${def.id}`}
                value={def.snap}
                onChange={(event) => editWindow(def.id, { snap: event.target.value as SnapUnit })}
              >
                <option value="hour">last full hour</option>
                <option value="day">last full UTC day</option>
              </select>
              <input
                className={s.windowNum}
                aria-label={`Repetitions for ${def.id}`}
                type="number"
                min={1}
                max={200}
                // Empty, not pre-filled with the default: a blank field is how the
                // operator sees at a glance which windows they have singled out,
                // and how raising the default keeps reaching the rest.
                placeholder={`${config.repetitions}`}
                value={override ?? ''}
                onChange={(event) => {
                  const raw = event.target.value.trim();
                  const next = { ...config.windowRepetitions };
                  if (!raw) delete next[def.id];
                  else next[def.id] = Math.min(200, Math.max(1, Number(raw) || 1));
                  setConfig({ ...config, windowRepetitions: next });
                }}
              />
              <button
                className={s.windowDrop}
                onClick={() => removeWindow(def.id)}
                disabled={config.windows.length === 1}
                title={
                  config.windows.length === 1
                    ? 'A run needs at least one window.'
                    : hasRuns
                      ? `${def.id} has measured runs — they stay in the log but stop appearing in the comparison.`
                      : `Delete ${def.id}`
                }
              >
                {hasRuns ? 'Delete ⚠' : 'Delete'}
              </button>
            </div>
          );
        })}
      </div>
      <button
        className={s.addWindow}
        onClick={() =>
          setConfig({
            ...config,
            windows: [...config.windows, makeWindow(nextWindowId(config.windows), 1, 'day', 'day')],
          })
        }
        disabled={config.windows.length >= MAX_WINDOWS}
      >
        Add window
      </button>
      <span className={s.hint}>
        Every run measures this set, smallest span first — rows are re-ordered into span order when
        you save, not while you type. The right ramp depends on the dataset: a 14-day window cannot
        be measured against four days of retention, and an hour does not stress a 14 TB/day engine.
        <br />
        <b>Runs</b> is the repetition count for that window; leave it blank to use the default above.
        Worth setting, because the windows do not cost the same — 20 runs of a 14-day window on a
        small engine can be an hour of wall clock where 20 runs of the 1-hour window is a couple of
        minutes. Below {P95_MIN_SAMPLES} the analysis view reports <code>n too low</code> for p95
        rather than quietly estimating it.
        <br />
        <b>Snap to</b> ends the window at the last fully-elapsed hour or UTC day, so it never includes
        data still being ingested. A window marked ⚠ already has measured runs: editing its span
        changes what later runs measure without relabelling the earlier ones, and renaming or
        deleting its id leaves those runs in the log but out of the comparison. Add a new row instead
        when you want to keep the old numbers comparable.
      </span>

      <label>Engine sizes to test</label>
      <div className={s.tierGrid}>
        {ENGINE_TIERS.map((tier) => {
          const def = tierDef(tier);
          const picked = config.sweepTiers.includes(tier);
          return (
            <label key={tier} className={s.tierItem}>
              <input
                type="checkbox"
                checked={picked}
                onChange={() =>
                  setConfig({
                    ...config,
                    sweepTiers: picked
                      ? config.sweepTiers.filter((item) => item !== tier)
                      : [...config.sweepTiers, tier],
                  })
                }
              />
              <span>
                {labelTier(tier)} <span className={s.tierNote}>{describeTier(tier)}</span>
                {def?.byRequest && <span className={s.tierNote}> · by request</span>}
              </span>
            </label>
          );
        })}
      </div>
      <span className={s.hint}>
        {config.sweepTiers.length === 0 ? (
          <>
            Nothing ticked, so a run measures <b>whichever size the engine is now</b> and never
            resizes it. That is the safe default and usually the right one — the size your org runs is
            the size worth measuring.
          </>
        ) : (
          <>
            A run will sweep <b>{config.sweepTiers.length}</b>{' '}
            {config.sweepTiers.length === 1 ? 'size' : 'sizes'}, smallest first, resizing the engine
            between them. A resize changes live Lakehouse capacity and the bill for everything else
            using that engine — the workbench still asks before the first one, and by default puts the
            engine back afterwards.
          </>
        )}{' '}
        Sizes marked <i>by request</i> must be enabled for your org by Cribl first; 4X-Large and above
        are support-only upgrades and are deliberately not offered.
      </span>

      <label htmlFor="restore" className={s.inlineLabel}>
        <input
          id="restore"
          type="checkbox"
          checked={config.restoreTierAfterSweep}
          onChange={(event) =>
            setConfig({ ...config, restoreTierAfterSweep: event.target.checked })
          }
        />
        Restore the original engine size after a sweep
      </label>
      <span className={s.hint}>
        On by default. A sweep that ends on the largest size otherwise leaves live capacity — and its
        cost — parked at the top until somebody notices.
      </span>

      <label htmlFor="cache">Cache state label</label>
      <select
        id="cache"
        className={s.field}
        value={config.cacheState}
        onChange={(event) => setConfig({ ...config, cacheState: event.target.value })}
      >
        <option>Unknown</option>
        <option>Warm</option>
        <option>Cold</option>
        <option>Disabled</option>
      </select>
      <span className={s.hint}>
        Recorded as an operator-supplied annotation only. The app cannot observe or control engine
        caching, so this label is not verified — leave it Unknown unless you set the state yourself.
      </span>

      <button className={s.save} onClick={() => void save()}>
        Save configuration
      </button>
    </div>
  );
}
