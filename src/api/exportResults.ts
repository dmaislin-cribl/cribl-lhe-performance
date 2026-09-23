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
import type { RunRecord, RunLog } from './appSettings';
import { formatSec } from './stats';

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
  'engine_sec',
  'queue_sec',
  'client_sec',
  'total_events',
  'status',
  'measured',
  'dataset',
  'search_group',
  'query_hash',
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
    run.engineMs === null ? '' : (run.engineMs / 1000).toFixed(3),
    run.queueMs === null ? '' : (run.queueMs / 1000).toFixed(3),
    run.clientMs === null ? '' : (run.clientMs / 1000).toFixed(3),
    run.totalEventCount ?? '',
    run.status,
    run.measured ? 'measured' : 'warmup',
    run.dataset,
    run.searchGroup,
    run.queryHash,
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

/**
 * A self-contained provenance header, so an exported table is interpretable
 * without the app. Without this, a pasted CSV is a set of numbers with no
 * record of what was searched.
 */
export function provenanceBlock(log: RunLog, extra: Record<string, string> = {}): string {
  const measured = log.runs.filter((run) => run.measured && run.status === 'Success');
  const lines = [
    `# Cribl Lakehouse Engine Performance Lab`,
    `# exported: ${new Date().toISOString()}`,
    `# measured runs: ${measured.length}`,
    `# metric: engine execution time (server timeCompleted - timeStarted)`,
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
