import { describe, expect, it } from 'vitest';
import { parseResultsPayload } from './perfRun';

// Verbatim header line from a live job on the staging workspace, plus one
// trimmed event. Keeping the real shape here is the point: the engine timing
// is derived from these exact field names.
const HEADER =
  '{"isFinished":true,"limit":5,"offset":0,"persistedEventCount":5,"totalEventCount":5,' +
  '"job":{"id":"1790175453932.A20aCM","query":"dataset=\\"cribl_internal_logs\\" | limit 5",' +
  '"earliest":1790164800,"latest":1790168400,"timeCreated":1790175453932,' +
  '"timeStarted":1790175454048,"timeCompleted":1790175455020,"status":"completed"}}';
const EVENT = '{"_time":1790171816.262,"dataset":"cribl_internal_logs","host":"a"}';

describe('parseResultsPayload', () => {
  it('extracts the job timings and true event count from line 0', () => {
    const { header, rows } = parseResultsPayload(`${HEADER}\n${EVENT}\n`);
    expect(header.totalEventCount).toBe(5);
    expect(header.job?.status).toBe('completed');
    // The measurement itself: engine time is server-side, 972 ms here.
    expect(header.job!.timeCompleted! - header.job!.timeStarted!).toBe(972);
    // Queue time is separable, and is *not* charged to the engine.
    expect(header.job!.timeStarted! - header.job!.timeCreated!).toBe(116);
    expect(rows).toHaveLength(1);
  });

  it('echoes absolute bounds so a misread window is visible in the run log', () => {
    const { header } = parseResultsPayload(`${HEADER}\n`);
    expect(header.job?.earliest).toBe(1790164800);
    expect(header.job?.latest).toBe(1790168400);
  });

  it('does not count the header as a data row', () => {
    const { rows } = parseResultsPayload(`${HEADER}\n${EVENT}\n${EVENT}\n`);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => 'dataset' in row)).toBe(true);
  });

  it('keeps line 0 as data when the payload has no header', () => {
    const { header, rows } = parseResultsPayload(`${EVENT}\n${EVENT}\n`);
    expect(header.job).toBeUndefined();
    expect(rows).toHaveLength(2);
  });

  it('tolerates a header with no events', () => {
    const { header, rows } = parseResultsPayload(`${HEADER}\n`);
    expect(header.totalEventCount).toBe(5);
    expect(rows).toEqual([]);
  });

  it('handles an empty payload', () => {
    expect(parseResultsPayload('')).toEqual({ header: {}, rows: [] });
    expect(parseResultsPayload('\n\n')).toEqual({ header: {}, rows: [] });
  });

  it('drops a truncated trailing line rather than failing the measurement', () => {
    const { header, rows } = parseResultsPayload(`${HEADER}\n${EVENT}\n{"_time":179017`);
    expect(header.totalEventCount).toBe(5);
    expect(rows).toHaveLength(1);
  });
});
