# Build with the Cribl App Framework

Use **criblio/cribl-search-app-framework** libraries for query clients, charts,
settings and Investigators. Import `@criblio/app-utils` browser subpaths.

## Discover with tools, implement with libraries

| Task | During authoring | In the app's browser code |
| --- | --- | --- |
| Logs, events, traces, KQL aggregates | `run_search` | `runQuery` from `@criblio/app-utils/search` |
| Metric names, labels, values, PromQL | `run_metrics_query` | `queryRange`, `queryInstant` from `@criblio/app-utils/metrics` |
| Chart a metric over time | Validate PromQL with `run_metrics_query` | `LineChart` and `toLineSeries` from `@criblio/app-utils/viz` |
| Dataset/app inventory or API configuration | `cribl_api` search/describe/call | Existing settings helpers or a small API adapter |
| Embed a GoatTown agent | Read the `embed-agent` skill | `InvestigatorTranscript` and `applyLoopEvent` from `@criblio/app-utils/investigator` |

Tools run on the server; use libraries in browser code. `cribl_api` is for
inventory/configuration and diagnosing a specific failure. `runQuery` owns
Search creation, polling, parsing and cancellation. Metrics uses a separate GET.

## First useful dashboard

1. Read the app's AGENTS.md, package.json and existing query/settings modules.
2. Honor the user's dataset scope. Sample one requested log/trace dataset with
   `run_search`, for example `dataset="my-dataset" | limit 3`, over an explicit
   time window. Inspect the actual fields, then validate the aggregate you need.
3. For metrics, start with `run_metrics_query` query `.catalog <name fragment>`,
   then `.labels <exact_metric>` and a small PromQL query. `.values <label>`
   discovers label values. A service name may be a label, not a metric prefix;
   an empty name search does not establish that the service has no metrics.
   Discover first, then query an exact metric and scope to the relevant labels.
4. Build one vertical slice: a validated query, a shared widget, and explicit
   loading, empty and failure states. Build and inspect the preview. Discovery
   should answer that slice's questions, not inventory unrelated datasets.
   Verify a populated live result through the actual adapter before adding more
   widgets. A failed request is an error state; only successful zero-row results
   establish that the selected window is empty. A bundle build is not a typecheck
   or proof that the dashboard works.

## Search and metrics examples

Use app-utils **0.8.3 or later** for metrics. Upgrade older app dependencies to
`"@criblio/app-utils": "^0.8.3"` and rebuild; an already cached `^0.8.0` CDN URL
can still serve older code. Read the chosen subpath's declarations when needed.
`build_app` resolves npm dependencies via esm.sh; the shell has no npm or Node.

```tsx
import { runQuery } from '@criblio/app-utils/search';
import { kqlDatasetId } from '@criblio/app-utils/kql';
import { queryRange } from '@criblio/app-utils/metrics';
import { LineChart, toLineSeries } from '@criblio/app-utils/viz';

// datasetId and promql come from app settings and validated discovery.
// controller belongs to the page/query effect; abort on navigation/unmount.
const [rows, metrics] = await Promise.all([
  runQuery(`dataset="${kqlDatasetId(datasetId)}" | limit 20`,
    '-1h', 'now', 20, controller.signal),
  queryRange(promql, { earliest: '-1h', latest: 'now', step: 60,
    dataset: metricsDatasetId, signal: controller.signal }),
]);

const chart = <LineChart title="Request rate" series={toLineSeries(metrics)} />;
```

`runQuery` returns event objects. Metrics has TWO result shapes:

| Helper | Result | Read the value |
| --- | --- | --- |
| `queryInstant` | `MetricSample[]`: `{ labels, _time, _value }` | `sample._value` |
| `queryRange` | `MetricSeries[]`: `{ labels, points: [{ t, v }] }` | `series.points` |

```ts
import { queryInstant, type MetricSample } from '@criblio/app-utils/metrics';
const samples: MetricSample[] = await queryInstant(promql, {
  dataset: metricsDatasetId, earliest: '-15m', latest: 'now', signal,
});
const currentValue = samples[0]?._value ?? null; // absent is unknown, not zero
const byTenant = new Map(samples.map(s => [s.labels.installation, s._value]));
```

Use exported types through adapters; do not cast instant samples to range
series or `unknown`. Both timestamps are epoch seconds; `toLineSeries` converts
range points for `LineChart`. Evaluation time does not prove scrape freshness;
query the underlying metric's timestamp to measure its age.

Metrics returns inline results in one GET. Cribl can include a `running`
snapshot alongside valid samples; 0.8.3 handles it. Never poll `mq-…` IDs or
write another parser. Catalog success does not validate query execution.
Inspect transport/response errors before changing PromQL.

When deduplicating replicated scrapes, retain semantic labels before summing:
`max by (installation, outcome)` preserves separate outcomes. Dropping outcome
can turn an 80% success rate into 100%. Validate mixed outcomes, not just zeros.

For in-app discovery, use `createMetricsCatalog` from `/metrics-catalog`, with
browser fetch against `window.CRIBL_API_URL`. It discovers the engine/dataset;
pass it to `listMetricMetadata`, `listLabels` and `listSeries`. Dot commands
sent directly to the query endpoint can falsely return no data. Preserve the
selected dataset; not every workspace calls it `metrics`.

## Reusable React components

| Import subpath | Available components/helpers |
| --- | --- |
| `@criblio/app-utils/viz` | `LineChart`, `Sparkline`, `StatTile`, `Panel`, `BarList`, `DataTable`, `toLineSeries`, `toBarItems`, value/unit formatters |
| `@criblio/app-utils/investigator` | `InvestigatorTranscript`, `applyLoopEvent`, transcript entry types; `InvestigatorChat` for a browser-owned agent loop |
| `@criblio/app-utils/investigator/metrics-tool-card` | Default `MetricsToolCard` for metric tool results |
| `@criblio/app-utils/settings` | `loadSettings`, `saveSettings`; check the existing app's KV layout before choosing keys |
| `@criblio/app-utils/query-generation` | Navigation cancellation helpers such as `newQueryGeneration` |
| `@criblio/app-utils/resilience-boundary` | `ResilienceBoundary` for a failed view |
| `@capra/core`, `@capra/icons` | Native controls, fields, cards, navigation and icons |

Viz needs React, `d3-array`, `d3-scale`, `d3-shape`, `d3-time-format` and
`@criblio/app-utils/styles/tokens.css`. Component CSS is packaged with the
components. Capra loads theme base, icon and core styles in that order.
Read component props before use.

Common props: `LineChart` takes `title` and `series`, with optional `error`,
`refreshing`, `emptyMessage`, `onBrush(startMs, endMs)` and `onSeriesClick`.
`StatTile` takes `label`, `value`, optional `sub` and `loading`. `Panel` takes
`title`, children, optional `error`, `refreshing` and `empty`. `DataTable` takes
`rows`, `rowKey`, and `columns` with `key`, `header`, `render(row)` and optional
`numeric`. It does not accept a generic chart-library `dataKey` or `accessor`.

For durable GoatTown sessions, read `embed-agent`: transport, Investigator
navigation, configurable URL, per-app token, KV key and connection test.
`InvestigatorChat` owns a separate browser loop; it is not a GoatTown transport.

## Platform and delivery

Browser calls use the platform's fetch proxy; no browser OAuth implementation.
Search paths always use `/m/default_search`; the query helpers handle this.
Declare external hosts in config/proxies.yml. Do not hardcode credentials,
cross-read another app's KV store, or serialize independent dashboard requests
to work around a preview error. Preserve queries and selections on refresh.

Read the current recipe with `configuration_catalog({"skill":"app-framework"})`,
also in older sessions with empty `/skills`. Follow `nextOffset`, passing the
returned `contentHash` as `version`. Copy relevant guidance into app AGENTS.md.
