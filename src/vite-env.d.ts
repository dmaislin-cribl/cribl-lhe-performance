/// <reference types="vite/client" />

/**
 * Globals the Cribl host injects into the App iframe. All optional: none
 * of them exist in bare local dev (`npm run dev` without an `?init=`
 * bootstrap), so every read needs a fallback.
 *
 * @criblio/app-utils happens to declare these too, but only as a side
 * effect of importing it — and that side effect is not something to rely
 * on: code touching `window.CRIBL_*` without importing the package
 * (App.tsx's router basename is the usual one) would stop compiling the
 * moment the package stops declaring them. Own the declaration here.
 */
interface Window {
  /** Base URL for Cribl API calls from inside the iframe. */
  CRIBL_API_URL?: string;
  /** Path the app is mounted at — React Router's `basename`. */
  CRIBL_BASE_PATH?: string;
  /** This app's id, which namespaces its KV store keys. */
  CRIBL_APP_ID?: string;
}
