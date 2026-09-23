// Sample backend endpoint. Written as ESM with a relative import to demonstrate that `apps build`
// bundles everything into one self-contained file — the platform fuses that file and cannot
// resolve npm packages or relative imports itself.
//
// `fetch` reaches the Cribl API (relative paths) and any external domain declared in proxies.yml.
import { greeting } from './net.js';

/**
 * Sample backend endpoint handler.
 * @param request - The incoming `Request`.
 * @param context - App runtime context (includes `appId`).
 * @returns A `Response` with a greeting and the Cribl `/system/info` payload.
 */
export async function onRequest(request: Request, context: { appId: string }): Promise<Response> {
  // Cribl API access must be declared in config/policies.yml — this reads /system/info, granted there.
  const res = await fetch('/api/v1/system/info');
  const info = await res.json();
  return new Response(JSON.stringify({ message: greeting(context.appId), info }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
