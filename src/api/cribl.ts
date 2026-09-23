/**
 * Cribl Search API client — re-exported from @criblio/app-utils so app
 * code has one local path to import from.
 *
 * Put your app's own query helpers here; leave the generic client in the
 * framework so every app picks up its fixes.
 *
 * Imported by SUBPATH, not from the package root. The root re-exports
 * every module including Node-only ones, so `from '@criblio/app-utils'`
 * drags `dotenv` → `node:fs/promises` into the browser graph and the
 * build dies on `"readFile" is not exported by "__vite-browser-external"`.
 * tsc does not catch it; only the bundler does.
 */

export { runQuery, apiUrl } from '@criblio/app-utils/search';
