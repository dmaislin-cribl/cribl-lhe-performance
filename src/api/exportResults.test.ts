import { describe, expect, it } from 'vitest';
import {
  analysisToCsv,
  analysisToMarkdown,
  comparisonToCsv,
  comparisonToMarkdown,
  csvCell,
  provenanceBlock,
  runsToCsv,
  toCsv,
  toMarkdown,
} from './exportResults';
import { analyzeByTier, type AnalysisScope } from './analysis';
import { buildComparison } from './compare';
import type { RunLog, RunRecord } from './appSettings';
import { DEFAULT_WINDOWS } from './windows';

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    id: 'r1',
    jobId: 'job-1',
    engine: 'medium',
    window: 'T1',
    earliestSec: 1_790_164_800,
    latestSec: 1_790_168_400,
    engineMs: 972,
    queueMs: 116,
    clientMs: 1500,
    totalEventCount: 5,
    status: 'Success',
    notes: '',
    measured: true,
    at: '2026-09-23T10:00:00.000Z',
    dataset: 'Fortinet_Syslog',
    queryHash: 'abc',
    searchGroup: 'default_search',
    searchId: 's-1',
    searchName: 'Test search',
    sessionId: 'run-1',
    sessionName: 'Fixture session',
    ...overrides,
    // The comparison defaults to total time, so fixtures mirror engineMs into
    // totalMs: an assertion written against engineMs stays readable, and the
    // queue-inclusive path gets its own test rather than skewing every number.
    totalMs:
      overrides.totalMs !== undefined
        ? overrides.totalMs
        : 'engineMs' in overrides
          ? overrides.engineMs!
          : 1000,
  };
}

describe('csvCell', () => {
  it('quotes only what needs quoting, and doubles inner quotes', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
    expect(csvCell(0)).toBe('0');
  });
});

describe('toCsv', () => {
  it('joins rows with CRLF per RFC 4180', () => {
    expect(toCsv([['a', 'b'], [1, 2]])).toBe('a,b\r\n1,2');
  });
});

describe('toMarkdown', () => {
  it('escapes pipes so a query cannot break the table', () => {
    const table = toMarkdown(['q'], [['where x | summarize count()']]);
    expect(table).toContain('where x \\| summarize count()');
    expect(table.split('\n')).toHaveLength(3);
  });
});

describe('runsToCsv', () => {
  it('emits one row per run with seconds and ISO bounds', () => {
    const csv = runsToCsv([run()]);
    const [header, body] = csv.split('\r\n');
    expect(header.split(',')).toContain('engine_sec');
    expect(body).toContain('0.972');
    expect(body).toContain('2026-09-23T12:00:00.000Z');
    expect(body).toContain('measured');
  });

  it('leaves a missing timing empty rather than writing a zero', () => {
    const csv = runsToCsv([run({ engineMs: null, status: 'Error', totalEventCount: null })]);
    expect(csv.split('\r\n')[1]).toContain(',,'); // empty engine_sec / queue_sec
  });

  it('keeps a comma-bearing error message in one field', () => {
    const csv = runsToCsv([run({ status: 'Error', notes: 'failed, badly' })]);
    expect(csv).toContain('"failed, badly"');
  });
});

describe('comparisonToCsv', () => {
  it('is long format: one row per window/tier pair', () => {
    const rows = buildComparison([run()], DEFAULT_WINDOWS.slice(0, 2), ['medium', 'large'], 'medium');
    const lines = comparisonToCsv(rows, ['medium', 'large']).split('\r\n');
    expect(lines).toHaveLength(1 + 2 * 2);
    expect(lines[0]).toContain('speedup_vs_baseline');
  });
});

describe('comparisonToMarkdown', () => {
  it('reports the best speedup per window', () => {
    const runs = [run({ engine: 'medium', engineMs: 4000 }), run({ engine: 'large', engineMs: 1000 })];
    const rows = buildComparison(runs, DEFAULT_WINDOWS.slice(0, 1), ['medium', 'large'], 'medium');
    const table = comparisonToMarkdown(rows, ['medium', 'large']);
    expect(table).toContain('4.00x');
    expect(table).toContain('| T1 |');
  });
});

describe('provenanceBlock', () => {
  it('records the metric, the measured count and the full query text', () => {
    const log: RunLog = {
      runs: [run(), run({ measured: false }), run({ status: 'Error' })],
      queries: { abc: 'dataset="x"\n| summarize events = count()' },
      sessions: [],
    };
    const block = provenanceBlock(log, { dataset: 'Fortinet_Syslog' });
    expect(block).toContain('# measured runs: 1');
    expect(block).toContain('timeCompleted - timeStarted');
    expect(block).toContain('# dataset: Fortinet_Syslog');
    expect(block).toContain('#   | summarize events = count()');
    // Every line stays commented so the block cannot be parsed as data.
    expect(block.split('\n').every((line) => line.startsWith('#'))).toBe(true);
  });
});

/** A sweep's worth of runs: twelve on each of two sizes, the larger one faster. */
function sweepRuns(): RunRecord[] {
  const at = (engine: string, base: number) =>
    Array.from({ length: 12 }, (_, index) =>
      run({ id: `${engine}-${index}`, engine, totalMs: base + index * 10 }),
    );
  return [...at('medium', 2000), ...at('large', 800)];
}

const analysisScope: AnalysisScope = {
  searchId: 's-1',
  windowId: 'T1',
  metric: 'total',
  baseline: 'medium',
  budgetMs: 1500,
  budgetStatistic: 'p50',
};

describe('analysisToCsv', () => {
  it('exports the qualifiers beside the numbers, not just the medians', () => {
    const csv = analysisToCsv(analyzeByTier(sweepRuns(), analysisScope));
    const [header] = csv.split('\r\n');
    // A reviewer has to be able to re-derive the conclusion, which means the
    // sample size, the outliers, the p-value and the test's own usability.
    for (const column of [
      'samples',
      'outliers',
      'counts_agree',
      'mannwhitney_p',
      'significance_usable',
      'budget_verdict',
    ]) {
      expect(header).toContain(column);
    }
  });

  it('gives one row per engine size, smallest first', () => {
    const rows = analysisToCsv(analyzeByTier(sweepRuns(), analysisScope)).split('\r\n');
    expect(rows).toHaveLength(3);
    expect(rows[1].startsWith('medium,')).toBe(true);
    expect(rows[2].startsWith('large,')).toBe(true);
  });

  it('leaves a statistic the sample cannot support empty rather than guessing', () => {
    // Three runs support no p95 and no median interval.
    const rows = analysisToCsv(analyzeByTier([
      run({ id: 'a', totalMs: 100 }),
      run({ id: 'b', totalMs: 200 }),
      run({ id: 'c', totalMs: 300 }),
    ], analysisScope));
    const cells = rows.split('\r\n')[1].split(',');
    const header = rows.split('\r\n')[0].split(',');
    expect(cells[header.indexOf('p95_sec')]).toBe('');
    expect(cells[header.indexOf('median_ci_low_sec')]).toBe('');
    expect(cells[header.indexOf('p50_sec')]).toBe('0.200');
  });

  it('records the budget verdict per size', () => {
    const csv = analysisToCsv(analyzeByTier(sweepRuns(), analysisScope));
    const [header, medium, large] = csv.split('\r\n');
    const column = header.split(',').indexOf('budget_verdict');
    expect(medium.split(',')[column]).toBe('fail');
    expect(large.split(',')[column]).toBe('pass');
  });
});

describe('analysisToMarkdown', () => {
  it('names the baseline in the comparison column and marks its own row', () => {
    const table = analysisToMarkdown(analyzeByTier(sweepRuns(), analysisScope), 'medium');
    expect(table).toContain('vs Medium');
    expect(table).toContain('baseline');
  });

  it('reports significance with the p-value and the effect size together', () => {
    const table = analysisToMarkdown(analyzeByTier(sweepRuns(), analysisScope), 'medium');
    // A p-value alone says only that something moved; the band says whether it matters.
    expect(table).toMatch(/yes \(p=0\.\d+, large\)/);
  });

  it('says a percentile is unsupported rather than printing the slowest run', () => {
    const thin = analyzeByTier([run({ id: 'a', totalMs: 100 }), run({ id: 'b', totalMs: 900 })], analysisScope);
    expect(analysisToMarkdown(thin, 'medium')).toContain('n too low');
  });
});
