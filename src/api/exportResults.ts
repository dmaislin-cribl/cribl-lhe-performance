/**
 * Result export.
 *
 * The app runs in a sandboxed iframe, which blocks file downloads — so there is
 * no `<a download>` or Blob-URL route out of here. Copying to the clipboard is
 * the one path that works, and it is what an SE actually needs: paste into a
 * ticket, a sheet, or a customer-facing doc.
 *
 * Serialisation is kept pure and separate from the clipboard call so the output
 * format is unit-testable without a DOM.
 */

import type { ComparisonRow } from './compare';
import type { SizeAnalysis } from './analysis';
import type { RunRecord, RunLog } from './appSettings';
import { formatSec } from './stats';
import { labelTier } from './tiers';

/** RFC 4180: quote when the value contains a comma, quote or newline; double inner quotes. */
export function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(rows: unknown[][]): string {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
}

/** Markdown pipe table. Escapes pipes so a query containing `|` cannot break the table. */
export function toMarkdown(header: string[], rows: unknown[][]): string {
  const escape = (value: unknown) =>
    (value === null || value === undefined ? '' : String(value)).replace(/\|/g, '\\|');
  const lines = [
    `| ${header.map(escape).join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escape).join(' | ')} |`),
  ];
  return lines.join('\n');
}

const RUN_HEADER = [
  'run_id',
  'job_id',
  'at',
  'engine_tier',
  'window',
  'earliest_utc',
  'latest_utc',
  'total_sec',
  'engine_sec',
  'queue_sec',
  'client_sec',
  'total_events',
  'status',
  'measured',
  'dataset',
  'search_group',
  'query_hash',
  'search_name',
  'session_name',
  'notes',
];

function isoAt(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

function runRow(run: RunRecord): unknown[] {
  return [
    run.id,
    run.jobId,
    run.at,
    run.engine,
    run.window,
    isoAt(run.earliestSec),
    isoAt(run.latestSec),
    run.totalMs === null ? '' : (run.totalMs / 1000).toFixed(3),
    run.engineMs === null ? '' : (run.engineMs / 1000).toFixed(3),
    run.queueMs === null ? '' : (run.queueMs / 1000).toFixed(3),
    run.clientMs === null ? '' : (run.clientMs / 1000).toFixed(3),
    run.totalEventCount ?? '',
    run.status,
    run.measured ? 'measured' : 'warmup',
    run.dataset,
    run.searchGroup,
    run.queryHash,
    run.searchName,
    run.sessionName,
    run.notes,
  ];
}

/** Every run, one row each — the raw record behind any summary. */
export function runsToCsv(runs: RunRecord[]): string {
  return toCsv([RUN_HEADER, ...runs.map(runRow)]);
}

/**
 * Cross-tier comparison, one row per window/tier pair. Long format rather than
 * wide: it survives adding a tier and pastes straight into a pivot table.
 */
export function comparisonToCsv(rows: ComparisonRow[], tiers: string[]): string {
  const header = [
    'window',
    'window_label',
    'window_hours',
    'engine_tier',
    'samples',
    'median_sec',
    'min_sec',
    'max_sec',
    'p95_sec',
    'cv_pct',
    'ms_per_hour',
    'speedup_vs_baseline',
    'total_events',
    'errors',
    'counts_agree',
  ];
  const body = rows.flatMap((row) =>
    tiers.map((tier) => {
      const cell = row.cells[tier];
      return [
        row.window.id,
        row.window.label,
        row.window.spanMs / 3_600_000,
        tier,
        cell.stats.n,
        cell.stats.median === null ? '' : (cell.stats.median / 1000).toFixed(3),
        cell.stats.min === null ? '' : (cell.stats.min / 1000).toFixed(3),
        cell.stats.max === null ? '' : (cell.stats.max / 1000).toFixed(3),
        cell.stats.p95 === null ? '' : (cell.stats.p95 / 1000).toFixed(3),
        cell.stats.cv === null ? '' : (cell.stats.cv * 100).toFixed(1),
        cell.msPerHour === null ? '' : cell.msPerHour.toFixed(1),
        cell.speedup === null ? '' : cell.speedup.toFixed(3),
        cell.eventCount ?? '',
        cell.errors,
        cell.consistent ? 'yes' : 'no',
      ];
    }),
  );
  return toCsv([header, ...body]);
}

/** Wide Markdown table of medians — the shape you paste into a summary doc. */
export function comparisonToMarkdown(rows: ComparisonRow[], tiers: string[]): string {
  const header = ['Window', 'Span', ...tiers.map((tier) => `${tier} median s`), 'Best speedup'];
  const body = rows.map((row) => {
    const speedups = tiers
      .map((tier) => row.cells[tier].speedup)
      .filter((value): value is number => value !== null);
    return [
      row.window.id,
      row.window.label,
      ...tiers.map((tier) => formatSec(row.cells[tier].stats.median)),
      speedups.length ? `${Math.max(...speedups).toFixed(2)}x` : '—',
    ];
  });
  return toMarkdown(header, body);
}

/** Milliseconds to seconds at 3 dp, or empty — the CSV convention used above. */
function sec(ms: number | null | undefined): string {
  return typeof ms === 'number' ? (ms / 1000).toFixed(3) : '';
}

/**
 * Full statistical detail, one row per engine size.
 *
 * Every column a performance or QA reviewer needs to re-derive the conclusion
 * themselves, including the ones that qualify it: sample size, the outlier count,
 * whether the event counts agreed, and the significance test's own verdict on
 * whether it had enough data. A table that exported only the medians would be
 * asking to be trusted.
 */
export function analysisToCsv(rows: SizeAnalysis[]): string {
  const header = [
    'engine_tier',
    'samples',
    'errors',
    'min_sec',
    'p50_sec',
    'p90_sec',
    'p95_sec',
    'p99_sec',
    'max_sec',
    'mean_sec',
    'stdev_sec',
    'cv_pct',
    'iqr_sec',
    'mad_sec',
    'outliers',
    'median_ci_low_sec',
    'median_ci_high_sec',
    'total_events',
    'events_per_sec',
    'counts_agree',
    'shift_vs_baseline_sec',
    'shift_vs_baseline_pct',
    'cliffs_delta',
    'effect_size',
    'mannwhitney_p',
    'significance_usable',
    'budget_verdict',
    'budget_headroom_sec',
  ];
  const body = rows.map((row) => [
    row.tier,
    row.summary.n,
    row.errors,
    sec(row.summary.min),
    sec(row.summary.percentiles.p50),
    sec(row.summary.percentiles.p90),
    sec(row.summary.percentiles.p95),
    sec(row.summary.percentiles.p99),
    sec(row.summary.max),
    sec(row.summary.mean),
    sec(row.summary.stdev),
    row.summary.cv === null ? '' : (row.summary.cv * 100).toFixed(1),
    sec(row.summary.iqr),
    sec(row.summary.mad),
    row.summary.outliers,
    sec(row.interval?.low),
    sec(row.interval?.high),
    row.eventCount ?? '',
    row.throughput === null ? '' : row.throughput.toFixed(0),
    row.countsAgree ? 'yes' : 'no',
    sec(row.vsBaseline?.shiftMs),
    row.vsBaseline?.percent === null || row.vsBaseline?.percent === undefined
      ? ''
      : row.vsBaseline.percent.toFixed(1),
    row.vsBaseline?.delta === null || row.vsBaseline?.delta === undefined
      ? ''
      : row.vsBaseline.delta.toFixed(3),
    row.vsBaseline?.effect ?? '',
    row.vsBaseline?.test.p === null || row.vsBaseline?.test.p === undefined
      ? ''
      : row.vsBaseline.test.p.toFixed(5),
    row.vsBaseline ? (row.vsBaseline.test.usable ? 'yes' : 'no') : '',
    row.budget.verdict,
    sec(row.budget.headroomMs),
  ]);
  return toCsv([header, ...body]);
}

/**
 * The narrow version for a summary doc: the headline, the effect size and the
 * qualifier, and nothing a reader has to be walked through.
 */
export function analysisToMarkdown(rows: SizeAnalysis[], baseline: string): string {
  const header = ['Engine size', 'Runs', 'Median', 'p95', 'Variability', `vs ${labelTier(baseline)}`, 'Significant?'];
  const body = rows.map((row) => {
    const comparison = row.vsBaseline;
    const change =
      comparison?.percent === null || comparison?.percent === undefined
        ? row.tier === baseline
          ? 'baseline'
          : '—'
        : `${comparison.percent > 0 ? '+' : ''}${comparison.percent.toFixed(1)}%`;
    return [
      labelTier(row.tier),
      row.summary.n,
      `${formatSec(row.summary.percentiles.p50 ?? null)} s`,
      row.summary.percentiles.p95 === null ? 'n too low' : `${formatSec(row.summary.percentiles.p95)} s`,
      row.summary.cv === null ? '—' : `${(row.summary.cv * 100).toFixed(0)}%`,
      change,
      !comparison
        ? row.tier === baseline
          ? '—'
          : 'not compared'
        : !comparison.test.usable
          ? 'too few runs'
          : comparison.test.p !== null && comparison.test.p < 0.05
            ? `yes (p=${comparison.test.p.toFixed(3)}, ${comparison.effect})`
            : `no (p=${comparison.test.p?.toFixed(3) ?? '—'})`,
    ];
  });
  return toMarkdown(header, body);
}

/**
 * A self-contained provenance header, so an exported table is interpretable
 * without the app. Without this, a pasted CSV is a set of numbers with no
 * record of what was searched.
 */
export function provenanceBlock(log: RunLog, extra: Record<string, string> = {}): string {
  const measured = log.runs.filter((run) => run.measured && run.status === 'Success');
  // Which named sessions produced these numbers. A pasted table is otherwise
  // unattributable to the run the operator actually means to talk about.
  const sessions = [...new Set(log.runs.map((run) => run.sessionName).filter(Boolean))];
  const lines = [
    `# ${__APP_DISPLAY_NAME__} ${__APP_ID__} v${__APP_VERSION__}`,
    `# exported: ${new Date().toISOString()}`,
    `# measured runs: ${measured.length}`,
    `# timings are server-side: total = timeCompleted - timeCreated (queue + execution), engine = timeCompleted - timeStarted`,
    ...(sessions.length ? [`# sessions: ${sessions.join(', ')}`] : []),
    ...Object.entries(extra).map(([key, value]) => `# ${key}: ${value}`),
  ];
  for (const [hash, query] of Object.entries(log.queries)) {
    lines.push(`# query ${hash}:`);
    for (const line of query.split('\n')) lines.push(`#   ${line}`);
  }
  return lines.join('\n');
}

/**
 * Copy text to the clipboard.
 *
 * `navigator.clipboard` can be unavailable in a sandboxed cross-origin iframe
 * (it needs the `clipboard-write` permission, and is gated on a secure context
 * plus a user gesture), so fall back to the legacy selection-based copy rather
 * than failing. Returns false when neither path works, so the caller can tell
 * the user instead of appearing to succeed.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or no secure context — try the fallback below.
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    // Off-screen but still selectable; `display:none` would not be.
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
