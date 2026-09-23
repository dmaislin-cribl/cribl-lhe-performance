import { useEffect, useState } from 'react';
import { loadSettings, saveSettings } from '../api/appSettings';
import StatusBanner from '../components/StatusBanner';

export default function SettingsPage() {
  const [dataset, setDataset] = useState('Fortinet_Syslog');
  const [repetitions, setRepetitions] = useState(5);
  const [cacheState, setCacheState] = useState('Warm');
  const [saved, setSaved] = useState(false);
  useEffect(() => { void loadSettings().then((settings) => { if (typeof settings.dataset === 'string') setDataset(settings.dataset); if (typeof settings.repetitions === 'number') setRepetitions(settings.repetitions); if (typeof settings.cacheState === 'string') setCacheState(settings.cacheState); }); }, []);
  const save = async () => { const current = await loadSettings(); await saveSettings({ ...current, dataset, repetitions, cacheState }); setSaved(true); window.setTimeout(() => setSaved(false), 2000); };
  return <div style={{ maxWidth: 700 }}><h1>Lab configuration</h1><p style={{ color: 'var(--cds-color-fg-muted)', margin: '8px 0 20px' }}>Parameters are stored in the app-scoped KV store and reused by the test workbench.</p>{saved && <StatusBanner kind="info">Configuration saved</StatusBanner>}<label>Default dataset</label><input value={dataset} onChange={(event) => setDataset(event.target.value)} style={{ width: '100%', padding: 8, margin: '6px 0 16px' }} /><label>Measured repetitions per window</label><input type="number" min={5} max={50} value={repetitions} onChange={(event) => setRepetitions(Math.max(5, Number(event.target.value)))} style={{ width: '100%', padding: 8, margin: '6px 0 16px' }} /><label>Cache state label</label><select value={cacheState} onChange={(event) => setCacheState(event.target.value)} style={{ width: '100%', padding: 8, margin: '6px 0 20px' }}><option>Warm</option><option>Cold</option><option>Disabled</option><option>Unknown</option></select><button onClick={() => void save()} style={{ padding: '9px 18px', background: 'var(--cds-color-primary)', color: 'white', border: 0, borderRadius: 4, fontWeight: 600 }}>Save configuration</button></div>;
}
