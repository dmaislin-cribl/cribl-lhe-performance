import { useEffect, useState } from 'react';
import { DEFAULT_CONFIG, loadConfig, saveConfig, type LabConfig } from '../api/appSettings';
import { P95_MIN_SAMPLES } from '../api/stats';
import StatusBanner from '../components/StatusBanner';

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

  const field = { width: '100%', padding: 8, margin: '6px 0 6px' } as const;
  const hint = {
    color: 'var(--cds-color-fg-muted)',
    fontSize: 12,
    display: 'block',
    marginBottom: 16,
  } as const;

  return (
    <div style={{ maxWidth: 700 }}>
      <h1>Lab configuration</h1>
      <p style={{ color: 'var(--cds-color-fg-muted)', margin: '8px 0 20px' }}>
        Parameters are stored in the app-scoped KV store and reused by the test workbench.
      </p>

      {saved && <StatusBanner kind="info">Configuration saved</StatusBanner>}
      {error && <StatusBanner kind="error">{error}</StatusBanner>}

      <label htmlFor="dataset">Default dataset</label>
      <input
        id="dataset"
        value={config.dataset}
        onChange={(event) => setConfig({ ...config, dataset: event.target.value })}
        style={field}
      />
      <span style={hint}>The dataset the windowed search runs against.</span>

      <label htmlFor="repetitions">Measured repetitions per window</label>
      <input
        id="repetitions"
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
        style={field}
      />
      <span style={hint}>
        Each window also runs one unmeasured warm-up. A p95 is only reported at{' '}
        {P95_MIN_SAMPLES}+ repetitions — below that, nearest-rank p95 is arithmetically identical to
        the maximum, so the summary shows min/median/max instead.
      </span>

      <label htmlFor="cache">Cache state label</label>
      <select
        id="cache"
        value={config.cacheState}
        onChange={(event) => setConfig({ ...config, cacheState: event.target.value })}
        style={field}
      >
        <option>Unknown</option>
        <option>Warm</option>
        <option>Cold</option>
        <option>Disabled</option>
      </select>
      <span style={hint}>
        Recorded as an operator-supplied annotation only. The app cannot observe or control engine
        caching, so this label is not verified — leave it Unknown unless you set the state yourself.
      </span>

      <button
        onClick={() => void save()}
        style={{
          padding: '9px 18px',
          background: 'var(--cds-color-primary)',
          color: 'white',
          border: 0,
          borderRadius: 4,
          fontWeight: 600,
        }}
      >
        Save configuration
      </button>
    </div>
  );
}
