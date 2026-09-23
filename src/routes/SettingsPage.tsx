import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { DEFAULT_CONFIG, loadConfig, saveConfig, type LabConfig } from '../api/appSettings';
import { P95_MIN_SAMPLES } from '../api/stats';
import StatusBanner from '../components/StatusBanner';
import s from './SettingsPage.module.css';

export default function SettingsPage() {
  const [config, setConfig] = useState<LabConfig>(DEFAULT_CONFIG);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // Load the same config record the workbench uses, so the two pages cannot
  // disagree about the dataset or repetition count.
  useEffect(() => {
    void loadConfig().then(setConfig);
  }, []);

  const save = async () => {
    try {
      await saveConfig(config);
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

      <label htmlFor="dataset">Default dataset</label>
      <input
        id="dataset"
        className={s.field}
        value={config.dataset}
        onChange={(event) => setConfig({ ...config, dataset: event.target.value })}
      />
      <span className={s.hint}>
        Used for the <code>dataset=</code> term of a newly created test search. Each saved search
        carries its own, so editing this does not change any existing one.
      </span>

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
        Each window also runs one unmeasured warm-up. A p95 is only reported at {P95_MIN_SAMPLES}+
        repetitions — below that, nearest-rank p95 is arithmetically identical to the maximum, so the
        summary shows min/median/max instead.
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
