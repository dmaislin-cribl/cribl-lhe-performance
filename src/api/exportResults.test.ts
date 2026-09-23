import { describe, expect, it } from 'vitest';
import {
  comparisonToCsv,
  comparisonToMarkdown,
  csvCell,
  provenanceBlock,
  runsToCsv,
  toCsv,
  toMarkdown,
} from './exportResults';
import { buildComparison } from './compare';
import type { RunLog, RunRecord } from './appSettings';
import { WINDOWS } from './windows';

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
    ...overrides,
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
    const rows = buildComparison([run()], WINDOWS.slice(0, 2), ['medium', 'large'], 'medium');
    const lines = comparisonToCsv(rows, ['medium', 'large']).split('\r\n');
    expect(lines).toHaveLength(1 + 2 * 2);
    expect(lines[0]).toContain('speedup_vs_baseline');
  });
});

describe('comparisonToMarkdown', () => {
  it('reports the best speedup per window', () => {
    const runs = [run({ engine: 'medium', engineMs: 4000 }), run({ engine: 'large', engineMs: 1000 })];
    const rows = buildComparison(runs, WINDOWS.slice(0, 1), ['medium', 'large'], 'medium');
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
