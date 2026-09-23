/**
 * Minimal multi-key accessor for the app-scoped KV store.
 *
 * Why not `loadSettings`/`saveSettings` from @criblio/app-utils/settings:
 * that helper hardcodes the single key `settings` and takes no key argument
 * (`loadSettings(defaults)`), so it cannot hold two independent records. This
 * app needs two — config and run history — because they have very different
 * write rates, and keeping them in one blob meant a keystroke in the query box
 * rewrote the whole run log.
 *
 * The URL shape is identical to the framework's: the platform's fetch proxy
 * rewrites `${apiUrl()}/kvstore/<key>` into the app-scoped path, so keys here
 * are already namespaced per installed app. This is still the platform KV
 * store, not browser storage.
 */

import { apiUrl } from './cribl';

function kvUrl(key: string): string {
  return `${apiUrl().replace(/\/$/, '')}/kvstore/${encodeURIComponent(key)}`;
}

/**
 * Read a JSON record. Returns null when the key is absent or unreadable —
 * callers apply their own defaults, so an empty store and a corrupt value
 * behave the same way rather than throwing during first render.
 */
export async function kvGet<T>(key: string): Promise<T | null> {
  try {
    const response = await fetch(kvUrl(key));
    if (!response.ok) return null;
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function kvPut(key: string, value: unknown): Promise<void> {
  const response = await fetch(kvUrl(key), {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: JSON.stringify(value),
  });
  if (!response.ok) {
    throw new Error(`Saving "${key}" failed (${response.status})`);
  }
}
