// A relative helper module. `apps build` inlines this into the endpoint bundle, so the platform
// never needs to resolve `./net.js` at deploy time. Split shared logic across files like this
// freely — it is all bundled into one file per endpoint.

/**
 * Builds the greeting returned by the sample endpoint.
 * @param appId - The installed app's id, from the request context.
 * @returns A human-readable greeting string.
 */
export function greeting(appId: string): string {
  return `Hello from ${appId}`;
}
