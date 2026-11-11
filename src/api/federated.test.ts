import { describe, expect, it } from 'vitest';
import {
  attributeRun,
  buildCatalog,
  classifySearch,
  describeCompute,
  NO_COMPUTE_WAIT,
  findJob,
  parseJobInsight,
  trackComputeWait,
  waitedForCompute,
  pathFromComputeTypes,
  runsOnTarget,
} from './federated';

/** Trimmed from a real federated job record (S3, compute v2). */
const FEDERATED_JOB = {
  id: '1794400831738.dciWVG',
  status: 'completed',
  metadata: {
    datasets: { aws_s3_flowlogs_v2: 1 },
    providers: { aws_s3_flowlogs: 1 },
    providerTypes: { s3: 1 },
    computeTypes: { v2: 1 },
  },
  cpuMetrics: {
    totalCPUSeconds: 56.05499999999999,
    billableCPUSeconds: 56.05499999999999,
    executorsCPUSeconds: { COORDINATOR: 1.2, d57ad1a33cef: 54.8 },
  },
  stages: [
    {
      id: 'root',
      cacheStatusByDatasetId: {
        aws_s3_flowlogs_v2: { usedCache: false, cacheStatus: 'miss', reason: 'Not a Lake Dataset' },
      },
    },
  ],
  pendingComputeNodeStatuses: { countCold: 1, countWarm: 0 },
};

/** Trimmed from a real Lakehouse job record. */
const LAKEHOUSE_JOB = {
  metadata: {
    providerTypes: { cribl_search: 1 },
    computeTypes: { local: 1 },
    engines: { local: { criblcoffee: 1 } },
  },
  cpuMetrics: { totalCPUSeconds: 0.568, billableCPUSeconds: 0, executorsCPUSeconds: { COORDINATOR: 0.568 } },
  stages: [{ cacheStatusByDatasetId: { criblcoffee_pos: { usedCache: true, computeType: 'local' } } }],
};

const CATALOG = buildCatalog([
  { id: 'criblcoffee_pos', type: 'cribl_search', provider: 'lakehouse' },
  { id: 'criblcoffee_historical_pos', type: 's3', provider: 'criblcoffee_historical' },
  { id: 'azure_blob_flowlogs_v2', type: 'azure_blob', provider: 'azure_blob_flowlogs' },
  { id: 'default', type: 'cribl_meta', provider: 'cribl_meta', datasets: ['criblcoffee_historical_pos'] },
  { id: 'loop', type: 'cribl_meta', datasets: ['loop'] },
]);

describe('parseJobInsight', () => {
  it('reads a federated job: path, cost, fan-out, provider, cache', () => {
    expect(parseJobInsight(FEDERATED_JOB)).toEqual({
      path: 'federated',
      billableCpuMs: 56055,
      totalCpuMs: 56055,
      executors: 1,
      providerTypes: ['s3'],
      computeTypes: ['v2'],
      cache: 'miss',
    });
  });

  it('reads a Lakehouse job as local with zero billable CPU and no executors', () => {
    const insight = parseJobInsight({ items: [LAKEHOUSE_JOB] });
    expect(insight.path).toBe('lakehouse');
    expect(insight.billableCpuMs).toBe(0);
    expect(insight.executors).toBe(0);
    expect(insight.cache).toBe('hit');
  });

  it('reports nothing rather than zeros for a record without the fields', () => {
    const insight = parseJobInsight({ id: 'x', status: 'completed' });
    expect(insight.path).toBe('');
    expect(insight.billableCpuMs).toBeNull();
    expect(insight.executors).toBeNull();
    expect(parseJobInsight(null).path).toBe('');
  });
});

describe('pathFromComputeTypes', () => {
  it('distinguishes local, remote, both and neither', () => {
    expect(pathFromComputeTypes(['local'])).toBe('lakehouse');
    expect(pathFromComputeTypes(['v1'])).toBe('federated');
    expect(pathFromComputeTypes(['local', 'v2'])).toBe('mixed');
    expect(pathFromComputeTypes([])).toBe('');
  });
});

describe('compute wait', () => {
  // The sequence a real Azure Blob (v2) job reported: nothing at first, one
  // pending node for most of the run, then 0/0 at completion.
  const polls = [
    { job: { status: 'running' }, gap: 500 },
    { job: { status: 'running', pendingComputeNodeStatuses: { countCold: 0, countWarm: 1 } }, gap: 500 },
    { job: { status: 'running', pendingComputeNodeStatuses: { countCold: 2, countWarm: 1 } }, gap: 600 },
    { job: { status: 'completed', pendingComputeNodeStatuses: { countCold: 0, countWarm: 0 } }, gap: 500 },
  ];

  it('accumulates the wait across polls, because the field is 0/0 at completion', () => {
    const final = polls.reduce((state, poll) => trackComputeWait(state, poll.job, poll.gap), NO_COMPUTE_WAIT);
    expect(final).toEqual({ reported: true, peakCold: 2, peakWarm: 1, waitMs: 1100 });
    // Reading only the last record — the original bug — would report no wait.
    expect(trackComputeWait(NO_COMPUTE_WAIT, polls[3].job, 500).waitMs).toBe(0);
  });

  it('stays unreported for jobs that never carry the field (Lakehouse, compute v1)', () => {
    const final = trackComputeWait(trackComputeWait(NO_COMPUTE_WAIT, { status: 'running' }, 500), {}, 500);
    expect(final.reported).toBe(false);
  });

  it('never reads "not reported" as "no wait"', () => {
    expect(waitedForCompute(1100)).toBe(true);
    expect(waitedForCompute(0)).toBe(false);
    expect(waitedForCompute(null)).toBeNull();
    expect(waitedForCompute(undefined)).toBeNull();
  });
});

describe('findJob', () => {
  it('picks one job out of a job-list payload, where cpuMetrics actually lives', () => {
    const list = { items: [{ id: 'a' }, FEDERATED_JOB] };
    expect(parseJobInsight(findJob(list, FEDERATED_JOB.id)).billableCpuMs).toBe(56055);
    expect(findJob(list, 'missing')).toBeNull();
    expect(findJob(null, 'a')).toBeNull();
  });
});

describe('classifySearch', () => {
  it('sorts searches by the dataset they name', () => {
    expect(classifySearch('dataset="criblcoffee_pos" | count', CATALOG)).toBe('lakehouse');
    expect(classifySearch("dataset='criblcoffee_historical_pos'", CATALOG)).toBe('federated');
    expect(classifySearch('dataset=criblcoffee_pos,azure_blob_flowlogs_v2', CATALOG)).toBe('mixed');
  });

  it('resolves a meta dataset through its members', () => {
    expect(classifySearch('dataset=default', CATALOG)).toBe('federated');
  });

  it('is unknown whenever the text or catalog cannot settle it', () => {
    expect(classifySearch('dataset="criblcoffee_*"', CATALOG)).toBe('unknown');
    expect(classifySearch('| count', CATALOG)).toBe('unknown');
    expect(classifySearch('dataset="not_in_catalog"', CATALOG)).toBe('unknown');
    expect(classifySearch('dataset="criblcoffee_pos"', null)).toBe('unknown');
    expect(classifySearch('dataset=loop', CATALOG)).toBe('unknown');
  });
});

describe('runsOnTarget', () => {
  it('keeps federated searches off engine sizes and Lakehouse searches off Federated', () => {
    expect(runsOnTarget('lakehouse', 'medium')).toBe(true);
    expect(runsOnTarget('lakehouse', 'federated')).toBe(false);
    expect(runsOnTarget('federated', 'federated')).toBe(true);
    expect(runsOnTarget('federated', 'xlarge')).toBe(false);
  });

  it('runs mixed and unknown searches everywhere', () => {
    for (const target of ['small', 'federated']) {
      expect(runsOnTarget('mixed', target)).toBe(true);
      expect(runsOnTarget('unknown', target)).toBe(true);
    }
  });
});

describe('attributeRun', () => {
  it("files by the server's account, not the plan", () => {
    expect(attributeRun({ planned: 'large', path: 'federated', engineTier: 'large' }).target).toBe(
      'federated',
    );
    expect(attributeRun({ planned: 'federated', path: 'lakehouse', engineTier: 'medium' }).target).toBe(
      'medium',
    );
  });

  it('keeps the plan, without a note, when the two agree or the server is silent', () => {
    expect(attributeRun({ planned: 'federated', path: 'federated', engineTier: 'medium' })).toEqual({
      target: 'federated',
      note: '',
    });
    expect(attributeRun({ planned: 'small', path: '', engineTier: 'small' })).toEqual({
      target: 'small',
      note: '',
    });
  });

  it('flags a mixed run but keeps its planned target', () => {
    const result = attributeRun({ planned: 'small', path: 'mixed', engineTier: 'small' });
    expect(result.target).toBe('small');
    expect(result.note).toMatch(/both/);
  });
});

describe('describeCompute', () => {
  it('summarises provider, remote compute, start state and cache', () => {
    expect(
      describeCompute({ providerTypes: ['s3'], computeTypes: ['v2'], computeWaitMs: 28_000, cache: 'miss' }),
    ).toBe('s3 · v2 · waited 28.0s for compute');
    expect(describeCompute({ providerTypes: ['s3'], computeTypes: ['v2'], computeWaitMs: 0 })).toBe(
      's3 · v2 · no compute wait',
    );
    expect(describeCompute({ providerTypes: ['cribl_search'], computeTypes: ['local'], cache: 'hit' })).toBe(
      'cribl_search · cache hit',
    );
    expect(describeCompute({})).toBe('');
  });
});

describe('groupDatasets', () => {
  it('groups Lakehouse first, then each federated storage type, then meta datasets', async () => {
    const { groupDatasets } = await import('./federated');
    const catalog = buildCatalog([
      { id: 'zeta_lh', type: 'cribl_search', provider: 'lakehouse' },
      { id: 'alpha_lh', type: 'cribl_search', provider: 'lakehouse' },
      { id: 'flows_gcs', type: 'gcs' },
      { id: 'pos_s3', type: 's3' },
      { id: 'blob', type: 'azure_blob' },
      { id: 'logs', type: 'cribl_lake' },
      { id: 'weird', type: 'some_new_type' },
      { id: 'default', type: 'cribl_meta', datasets: ['pos_s3'] },
    ]);
    expect(groupDatasets(catalog).map((group) => [group.label, group.ids])).toEqual([
      ['Lakehouse', ['alpha_lh', 'zeta_lh']],
      ['Federated · Amazon S3', ['pos_s3']],
      ['Federated · Azure Blob Storage', ['blob']],
      ['Federated · Google Cloud Storage', ['flows_gcs']],
      ['Federated · Cribl Lake', ['logs']],
      ['Federated · some_new_type', ['weird']],
      ['Other (resolves to other datasets)', ['default']],
    ]);
    expect(groupDatasets(null)).toEqual([]);
  });
});
