import { defineConfig, type IndexHtmlTransformContext, type IndexHtmlTransformResult, type ViteDevServer } from 'vite'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { join } from 'path'
import react from '@vitejs/plugin-react'
import { servePackageTgz } from '@cribl/apps/package'
import { backendPreviewPlugin, backendWatchPlugin } from '@cribl/apps/preview'

const packageEndpointPlugin = () => ({
  name: 'vite-plugin-package-endpoint',
  configureServer(server: ViteDevServer) {
    server.middlewares.use('/package.tgz', (req: IncomingMessage, res: ServerResponse) => {
      void servePackageTgz(req, res, server.config.root)
    })
  },
})

// Keep this as a named `WATCHED_CONFIG_FILES` const holding one entry per
// config file: `apps upgrade`'s live-preview migration reads this exact
// declaration to add files as the platform grows them. Inlining the paths
// is what made the migration unable to touch this file before.
const WATCHED_CONFIG_FILES = ['package.json', 'config/proxies.yml', 'config/policies.yml', 'config/schedules.yml', 'config/backend.yml'];
const CONFIG_CHANGED_HMR_EVENT = 'cribl:config-changed';

const CONFIG_CHANGED_BRIDGE = `
import { createHotContext } from '/@vite/client';
const hot = createHotContext('cribl:config-watcher');
hot.on('${CONFIG_CHANGED_HMR_EVENT}', (data) => {
  if (window.parent !== window) {
    window.parent.postMessage({ type: 'CRIBL_APP_CONFIG_CHANGED', file: data && data.file }, '*');
  }
  window.location.reload();
});
`;

const injectScriptFromQueryPlugin = () => {
  let initScriptUrl: string | null = null;
  return {
    name: 'inject-script-from-query',
    configureServer(server: ViteDevServer) {
      const root = server.config.root;
      const watched = WATCHED_CONFIG_FILES.map((rel) => join(root, rel));
      server.watcher.add(watched);
      server.watcher.on('change', (file) => {
        const idx = watched.indexOf(file);
        if (idx === -1) return;
        server.ws.send(CONFIG_CHANGED_HMR_EVENT, { file: WATCHED_CONFIG_FILES[idx] });
      });
    },
    transformIndexHtml(html: string, ctx: IndexHtmlTransformContext): IndexHtmlTransformResult{
      const url = new URL(ctx.originalUrl ?? '/', 'https://localhost');
      initScriptUrl = initScriptUrl || url.searchParams.get('init');
      const root = process.cwd();
      let appName;
      try {
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8')) as { name?: string };
        appName = pkg.name;
      } catch {
        /* ignore missing or invalid package.json */
      }
      appName = appName || 'unknown';
      const tags: Array<{ tag: string; attrs?: Record<string, string>; children?: string; injectTo: 'head-prepend' }> = [];
      tags.push({
        tag: 'script',
        children: `window.CRIBL_APP_ID = '__dev__${appName}';`,
        injectTo: 'head-prepend' as const,
      });
      if (ctx.server) {
        tags.push({
          tag: 'script',
          attrs: { type: 'module' },
          children: CONFIG_CHANGED_BRIDGE,
          injectTo: 'head-prepend' as const,
        });
      }
      if (initScriptUrl) {
        tags.push({
          tag: 'script',
          attrs: { src: initScriptUrl, type: 'text/javascript' },
          injectTo: 'head-prepend' as const,
        });
      }
      return { html, tags };
    },
  };
};

export default defineConfig({
  plugins: [react(), packageEndpointPlugin(), injectScriptFromQueryPlugin(), backendWatchPlugin(), backendPreviewPlugin()],
  base: './',
  resolve: {
    // @criblio/app-utils declares React as a peer dep, so its own tree has
    // no copy. Dedupe points every `react` / `react-dom` import at the
    // consumer's node_modules — without it a second React instance can be
    // resolved for the framework's components, and two Reacts in one page
    // break hooks at runtime. Not part of the standard scaffold: it exists
    // because apps here depend on @criblio/app-utils.
    dedupe: ['react', 'react-dom'],
  },
  server: {
    cors: true,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  }
})
