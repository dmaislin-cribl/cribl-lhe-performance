/**
 * App settings via the Cribl KV store — re-exported from
 * @criblio/app-utils so app code has one local path to import from.
 *
 * To widen the settings shape, declare your own interface here and use it
 * at the call sites; the framework's loader is schema-free.
 *
 * Imported by SUBPATH — see the note in cribl.ts for why the package root
 * breaks the browser build.
 */

import { loadSettings as frameworkLoadSettings, saveSettings as frameworkSaveSettings } from '@criblio/app-utils/settings';

export type AppSettings = Record<string, unknown>;
export async function loadSettings(): Promise<AppSettings> { return frameworkLoadSettings<AppSettings>('lakehouse-performance/settings', {}); }
export async function saveSettings(settings: AppSettings): Promise<void> { await frameworkSaveSettings('lakehouse-performance/settings', settings); }
