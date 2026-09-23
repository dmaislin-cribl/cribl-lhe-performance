/**
 * Cross-tier comparison — the deliverable this lab exists to produce.
 *
 * The workbench only ever summarised the tier currently attached to the engine,
 * so "what did Medium -> 2X-Large actually buy" had to be reassembled by hand
 * from the run log. This page derives it, states plainly when the comparison is
 * not safe to present, and exports it with enough provenance that a pasted
 * table is still interpretable a week later.
 */

import { useEffect, useMemo, useState } from 'react';
import LatencyChart, { type ChartSeries } from '../components/LatencyChart';
import StatusBanner from '../components/StatusBanner';
import { buildComparison, checkComparability, searchesInLog, tiersWithData } from '../api/compare';
import {
  DEFAULT_CONFIG,
  EMPTY_RUN_LOG,
  loadConfig,
  loadRunLog,
  type LabConfig,
  type RunLog,
} from '../api/appSettings';
import {
  comparisonToCsv,
  comparisonToMarkdown,
  copyToClipboard,
  provenanceBlock,
  runsToCsv,
} from '../api/exportResults';
import { P95_MIN_SAMPLES, formatSec } from '../api/stats';
import { BASELINE_TIER, ENGINE_TIERS, labelTier, tierColor } from '../api/tiers';
import { WINDOWS } from '../api/windows';
import s from './ComparePage.module.css';

/**
 * `total` is the default: it is the time someone actually waited for the search.
 * `engine` isolates execution for the capacity question, and `msPerHour`
 * normalises by window width to expose non-linear scaling.
 */
type Metric = 'total' | 'engine' | 'msPerHour';

/** Sentinel for "do not filter by search" — a real id can never be empty. */
const ALL_SEARCHES = '';

/** Says what is wrong, not which enum member it is. */
const WARNING_TITLES: Record<string, string> = {
  query: 'Mixed queries:',
  dataset: 'Mixed datasets:',
  counts: 'Data moved mid-run:',
  partial: 'Incomplete samples:',
};

const METRIC_LABELS: Record<Metric, string> = {
  total: 'Typical total time, start to finish (seconds)',
  engine: 'Typical engine execution time only (seconds)',
  msPerHour: 'Normalized: ms per hour of window scanned',
};

const METRIC_NOTES: Record<Metric, string> = {
  total: 'Queue wait plus execution, as the server clocked it — the wait an operator actually experiences.',
  engine: 'Execution only, queue excluded. Use this when the question is engine capacity rather than end-to-end wait.',
  msPerHour:
    'Flat across windows means the tier scales linearly with the scanned range; a rising curve is the finding worth showing a customer.',
};

/** Compact axis/tooltip formatting — 3 dp is noise on an axis tick. */
function formatSeconds(value: number): string {
  return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
}

function formatMsPerHour(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

export default function ComparePage() {
  const [log, setLog] = useState<RunLog>(EMPTY_RUN_LOG);
  const [config, setConfig] = useState<LabConfig>(DEFAULT_CONFIG);
  const [metric, setMetric] = useState<Metric>('total');
  const [baseline, setBaseline] = useState(BASELINE_TIER);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    void loadRunLog().then(setLog);
    void loadConfig().then(setConfig);
  }, []);

  const searches = useMemo(() => searchesInLog(log.runs), [log.runs]);

  /**
   * Default to the most-measured search rather than to everything. Mixing two
   * searches into one median is the single easiest way to produce a number that
   * looks clean and means nothing, so the safe view is the one shown first.
   */
  const activeSearchId = searchId ?? searches[0]?.id ?? ALL_SEARCHES;

  const scoped = useMemo(
    () =>
      activeSearchId === ALL_SEARCHES
        ? log.runs
        : log.runs.filter((run) => (run.searchId || '(unattributed)') === activeSearchId),
    [log.runs, activeSearchId],
  );

  /** Engine time and total time are different columns of the same run. */
  const field = metric === 'engine' ? 'engineMs' : 'totalMs';

  const tiers = useMemo(() => {
    const present = tiersWithData(scoped, ENGINE_TIERS, field);
    // Always show the baseline column, even before it has data, so the reader
    // can see what the comparison is measured against.
    return present.includes(baseline) ? present : [baseline, ...present];
  }, [scoped, baseline, field]);

  const rows = useMemo(
    () => buildComparison(scoped, WINDOWS, tiers, baseline, field),
    [scoped, tiers, baseline, field],
  );

  const warnings = useMemo(
    () => checkComparability(scoped, rows, tiers, config.repetitions),
    [scoped, rows, tiers, config.repetitions],
  );

  const series: ChartSeries[] = useMemo(
    () =>
      tiers.map((tier) => ({
        key: tier,
        label: labelTier(tier),
        color: tierColor(tier),
        values: rows.map((row) => {
          const cell = row.cells[tier];
          if (metric === 'msPerHour') return cell.msPerHour;
          return cell.stats.median === null ? null : cell.stats.median / 1000;
        }),
      })),
    [rows, tiers, metric],
  );

  const copy = async (what: string, text: string) => {
    const ok = await copyToClipboard(text);
    setCopied(ok ? `${what} copied to the clipboard.` : `Could not reach the clipboard — ${what} not copied.`);
    window.setTimeout(() => setCopied(''), 4000);
  };

  const provenance = () =>
    provenanceBlock(log, {
      dataset: config.dataset,
      'search group': config.searchGroup,
      'cache state (operator annotation)': config.cacheState,
      search: searches.find((entry) => entry.id === activeSearchId)?.name ?? 'all searches (mixed)',
      metric: METRIC_LABELS[metric],
      baseline: labelTier(baseline),
    });

  const anyData = rows.some((row) => tiers.some((tier) => row.cells[tier].stats.n > 0));

  return (
    <div className={s.page}>
      <h1>Engine tier comparison</h1>
      <p className={s.intro}>
        How long one saved search took per time window, by engine tier, over successful timed runs
        only. Speedup is <b>{labelTier(baseline)} time ÷ tier time</b>, so a value above 1.00 means the
        tier was faster than the baseline. Warm-up runs, failures and runs with no server-reported
        timing are excluded everywhere on this page.
      </p>

      {copied && <StatusBanner kind="info">{copied}</StatusBanner>}

      {warnings.map((warning) => (
        <div className={s.warn} key={warning.kind}>
          <span className={s.warnIcon} aria-hidden="true">
            ⚠
          </span>
          <span>
            <span className={s.warnKind}>{WARNING_TITLES[warning.kind] ?? 'Warning:'}</span>
            {warning.detail}
          </span>
        </div>
      ))}

      <div className={s.filters}>
        <div>
          <label htmlFor="search">Search</label>
          <select
            id="search"
            value={activeSearchId}
            onChange={(event) => setSearchId(event.target.value)}
            disabled={!searches.length}
          >
            {searches.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} ({entry.runs} runs)
              </option>
            ))}
            {searches.length > 1 && <option value={ALL_SEARCHES}>All searches together (mixed)</option>}
            {!searches.length && <option value={ALL_SEARCHES}>No runs recorded yet</option>}
          </select>
        </div>
        <div>
          <label htmlFor="metric">Metric</label>
          <select id="metric" value={metric} onChange={(event) => setMetric(event.target.value as Metric)}>
            {Object.entries(METRIC_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="baseline">Baseline tier</label>
          <select id="baseline" value={baseline} onChange={(event) => setBaseline(event.target.value)}>
            {ENGINE_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {labelTier(tier)}
              </option>
            ))}
          </select>
        </div>
        <div className={s.actions}>
          <button onClick={() => void copy('Comparison CSV', `${provenance()}\n${comparisonToCsv(rows, tiers)}`)}>
            Copy comparison CSV
          </button>
          <button
            onClick={() => void copy('Markdown summary', `${provenance()}\n\n${comparisonToMarkdown(rows, tiers)}`)}
          >
            Copy Markdown
          </button>
          <button onClick={() => void copy('Raw run CSV', `${provenance()}\n${runsToCsv(log.runs)}`)}>
            Copy raw runs ({log.runs.length})
          </button>
        </div>
      </div>

      <section className={s.card}>
        <div className={s.cardHeader}>
          <div>
            <h2>{METRIC_LABELS[metric]}</h2>
            <span className={s.muted}>{METRIC_NOTES[metric]}</span>
          </div>
        </div>
        <LatencyChart
          xLabels={WINDOWS.map((window) => window.id)}
          xSubLabels={WINDOWS.map((window) => window.label)}
          series={series}
          yAxisTitle={metric === 'msPerHour' ? 'ms per hour scanned' : 'seconds'}
          format={metric === 'msPerHour' ? formatMsPerHour : formatSeconds}
          ariaLabel={`${METRIC_LABELS[metric]} by time window for ${tiers
            .map(labelTier)
            .join(', ')}. The full values are in the table below.`}
        />
      </section>

      <section className={s.card}>
        <div className={s.cardHeader}>
          <div>
            <h2>Table view</h2>
            <span className={s.muted}>
              Every charted value, plus sample size and error count. p95 needs {P95_MIN_SAMPLES}+
              samples and is reported per tier in the raw CSV export.
            </span>
          </div>
        </div>
        {anyData ? (
          <table className={s.table}>
            <thead>
              <tr>
                <th>Window</th>
                <th>Span</th>
                {tiers.map((tier) => (
                  <th key={tier} className={tier === baseline ? s.baselineCol : undefined}>
                    <span className={s.swatch} style={{ background: tierColor(tier) }} />
                    {labelTier(tier)}
                    {tier === baseline ? ' (baseline)' : ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.window.id}>
                  <td>
                    <b>{row.window.id}</b>
                  </td>
                  <td>{row.window.label}</td>
                  {tiers.map((tier) => {
                    const cell = row.cells[tier];
                    return (
                      <td key={tier} className={tier === baseline ? s.baselineCol : undefined}>
                        {cell.stats.n === 0 ? (
                          <span className={s.muted}>no runs</span>
                        ) : (
                          <>
                            <b>{formatSec(cell.stats.median)}</b> s
                            <span className={s.muted}>
                              n={cell.stats.n}
                              {cell.errors ? ` · ${cell.errors} err` : ''}
                              {cell.stats.cv === null ? '' : ` · CV ${(cell.stats.cv * 100).toFixed(1)}%`}
                              {!cell.consistent ? ' · counts differ' : ''}
                            </span>
                            {cell.speedup !== null && tier !== baseline && (
                              <span className={cell.speedup >= 1 ? s.faster : s.slower}>
                                {cell.speedup.toFixed(2)}× vs {labelTier(baseline)}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className={s.empty}>
            No timed runs yet for this search. Time it on the Overview page — then resize the engine
            and run it again to populate a second column.
          </div>
        )}
        <p className={s.note}>
          Exports carry a provenance header naming the dataset, search group and the full text of
          every query the runs were recorded under, so a pasted table cannot be read out of context.
        </p>
      </section>
    </div>
  );
}
