/**
 * Performance analysis — the view for a performance or QA engineer rather than
 * for the operator who pressed run.
 *
 * The workbench and the comparison page answer "how long did it take" and "which
 * size was faster". This page answers the question that decides a release: **is
 * the difference real, is the sample fit to quote, and does it meet the budget?**
 *
 * Three deliberate choices, all of which make the page less flattering and more
 * defensible:
 *
 *   - **Scope is one search and one window, never pooled.** Selecting "all" would
 *     mix distributions of different work into one percentile. There is no option
 *     to do it; see analysis.ts.
 *   - **A statistic absent is shown as absent, with the reason.** "n too low" in
 *     a p99 cell rather than a number that is really the slowest run.
 *   - **A verdict is never colour alone**, and `unknown` never renders as a
 *     failure — a budget that could not be tested has not been missed.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  type AnalysisMetric,
  type AnalysisScope,
  analysisOptions,
  analyzeByTier,
  defaultScope,
} from '../api/analysis';
import {
  DEFAULT_CONFIG,
  EMPTY_RUN_LOG,
  loadConfig,
  loadRunLog,
  saveConfig,
  type LabConfig,
  type RunLog,
} from '../api/appSettings';
import {
  analysisToCsv,
  analysisToMarkdown,
  copyToClipboard,
  provenanceBlock,
} from '../api/exportResults';
import {
  MIN_COMPARE_SAMPLES,
  NOISY_CV,
  type BudgetStatistic,
  quantileMinSamples,
} from '../api/perfStats';
import { summarizeSessions } from '../api/sessions';
import { formatSec } from '../api/stats';
import { BASELINE_TIER, ENGINE_TIERS, labelTier, tierColor } from '../api/tiers';
import StatusBanner from '../components/StatusBanner';
import s from './AnalysisPage.module.css';

const ALL_SESSIONS = '';

const METRIC_LABELS: Record<AnalysisMetric, string> = {
  total: 'Total time (queue + execution)',
  engine: 'Engine execution only',
};

const BUDGET_STATISTICS: BudgetStatistic[] = ['p50', 'p90', 'p95', 'p99'];

/** Significance threshold. Stated in the UI rather than left implicit. */
const ALPHA = 0.05;

/** Percentile columns, in display order, with the sample size each needs. */
const PERCENTILE_COLUMNS: { key: string; label: string; p: number }[] = [
  { key: 'p50', label: 'Median', p: 0.5 },
  { key: 'p90', label: 'p90', p: 0.9 },
  { key: 'p95', label: 'p95', p: 0.95 },
  { key: 'p99', label: 'p99', p: 0.99 },
];

function pct(value: number | null, digits = 1): string {
  return value === null ? '—' : `${(value * 100).toFixed(digits)}%`;
}

/** A signed percentage, where the sign is the point being made. */
function signedPct(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

export default function AnalysisPage() {
  const [log, setLog] = useState<RunLog>(EMPTY_RUN_LOG);
  const [config, setConfig] = useState<LabConfig>(DEFAULT_CONFIG);
  const [loaded, setLoaded] = useState(false);
  /**
   * `?session=<id>` preselects one session, so a session card can link straight
   * here instead of asking the reader to find the right row in the dropdown from
   * memory. Read once as the initial value rather than tracked: changing the
   * dropdown afterwards must not be fighting the URL.
   */
  const [params] = useSearchParams();
  const [sessionId, setSessionId] = useState(params.get('session') ?? ALL_SESSIONS);
  const [searchId, setSearchId] = useState<string | null>(null);
  const [windowId, setWindowId] = useState<string | null>(null);
  const [metric, setMetric] = useState<AnalysisMetric>('total');
  const [baseline, setBaseline] = useState(BASELINE_TIER);
  const [budgetSec, setBudgetSec] = useState('');
  const [copied, setCopied] = useState('');

  useEffect(() => {
    void Promise.all([loadRunLog(), loadConfig()]).then(([storedLog, storedConfig]) => {
      setLog(storedLog);
      setConfig(storedConfig);
      setBudgetSec(storedConfig.budgetMs === null ? '' : (storedConfig.budgetMs / 1000).toString());
      setLoaded(true);
    });
  }, []);

  const sessionOptions = useMemo(
    () => summarizeSessions(log).filter((entry) => entry.totalRuns > 0),
    [log],
  );

  const inSession = useMemo(
    () =>
      sessionId === ALL_SESSIONS ? log.runs : log.runs.filter((run) => run.sessionId === sessionId),
    [log.runs, sessionId],
  );

  const options = useMemo(() => analysisOptions(inSession), [inSession]);
  const fallback = useMemo(() => defaultScope(inSession), [inSession]);

  /**
   * The operator's choice wins, but only while it still exists in scope —
   * changing session otherwise leaves the page pointing at a search that session
   * never ran, showing an empty table that looks like a bug.
   */
  const activeSearch =
    searchId && options.searches.some((entry) => entry.id === searchId)
      ? searchId
      : (fallback.searchId ?? '');
  const activeWindow =
    windowId && options.windows.some((entry) => entry.id === windowId)
      ? windowId
      : (fallback.windowId ?? '');

  const budgetMs = useMemo(() => {
    const parsed = Number.parseFloat(budgetSec);
    return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * 1000) : null;
  }, [budgetSec]);

  const scope: AnalysisScope = useMemo(
    () => ({
      searchId: activeSearch,
      windowId: activeWindow,
      metric,
      baseline,
      budgetMs,
      budgetStatistic: config.budgetStatistic,
    }),
    [activeSearch, activeWindow, metric, baseline, budgetMs, config.budgetStatistic],
  );

  const rows = useMemo(
    () => (activeSearch && activeWindow ? analyzeByTier(inSession, scope) : []),
    [inSession, scope, activeSearch, activeWindow],
  );

  const withData = rows.filter((row) => row.summary.n > 0);

  /**
   * The budget is a team-level setting, not a per-visit one, so it is written
   * back. Saved on blur rather than per keystroke: this is the KV store, and
   * "0.", "0.5", "0.55" are three writes for one decision.
   */
  const persistBudget = useCallback(() => {
    const next: LabConfig = { ...config, budgetMs };
    setConfig(next);
    void saveConfig(next);
  }, [config, budgetMs]);

  const setStatistic = useCallback(
    (statistic: BudgetStatistic) => {
      const next: LabConfig = { ...config, budgetStatistic: statistic };
      setConfig(next);
      void saveConfig(next);
    },
    [config],
  );

  const provenance = useCallback(() => {
    const session = sessionOptions.find((entry) => entry.id === sessionId);
    const search = options.searches.find((entry) => entry.id === activeSearch);
    return provenanceBlock(
      { ...log, runs: inSession },
      {
        view: 'performance analysis',
        session: session?.name ?? 'all sessions',
        search: search?.label ?? activeSearch,
        window: activeWindow,
        metric: METRIC_LABELS[metric],
        baseline: labelTier(baseline),
        'acceptance budget': budgetMs === null ? 'none' : `${config.budgetStatistic} <= ${(budgetMs / 1000).toFixed(3)}s`,
        'significance test': `Mann-Whitney U, two-sided, alpha=${ALPHA}`,
        'effect size': "Cliff's delta; shift is the Hodges-Lehmann estimator",
        'statistics exclude': 'warm-up runs and failed runs',
      },
    );
  }, [
    log,
    inSession,
    sessionOptions,
    sessionId,
    options.searches,
    activeSearch,
    activeWindow,
    metric,
    baseline,
    budgetMs,
    config.budgetStatistic,
  ]);

  const copy = useCallback(async (what: string, text: string) => {
    const ok = await copyToClipboard(text);
    setCopied(ok ? `${what} copied to the clipboard.` : `The clipboard is unavailable here — ${what} not copied.`);
    window.setTimeout(() => setCopied(''), 4000);
  }, []);

  if (loaded && !log.runs.some((run) => run.measured)) {
    return (
      <div className={s.page}>
        <h1>Performance analysis</h1>
        <div className={s.empty}>
          <h2>Nothing measured yet</h2>
          <p>
            This page needs timed runs to analyse. Pick your searches, choose the engine sizes to
            test, and run a sweep — then come back and it will tell you whether the differences
            between those sizes are real.
          </p>
          <Link className={s.cta} to="/">
            Go to the workbench
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className={s.page}>
      <div className={s.head}>
        <div>
          <h1>Performance analysis</h1>
          <p className={s.intro}>
            Distribution, significance and acceptance for one search on one time window, across
            every engine size measured. Warm-up and failed runs are excluded from every figure;
            outliers are counted and disclosed but never trimmed.
          </p>
        </div>
        <Link className={s.back} to="/compare">
          Compare tiers
        </Link>
      </div>

      {copied && <StatusBanner kind="info">{copied}</StatusBanner>}

      <div className={s.filters}>
        <div>
          <label htmlFor="session">Session</label>
          <select
            id="session"
            value={sessionId}
            onChange={(event) => {
              setSessionId(event.target.value);
              setSearchId(null);
              setWindowId(null);
            }}
            disabled={!sessionOptions.length}
          >
            <option value={ALL_SESSIONS}>
              {sessionOptions.length ? 'All sessions' : 'No named sessions yet'}
            </option>
            {sessionOptions.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name} ({entry.measuredRuns} timed)
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="search">Search</label>
          <select
            id="search"
            value={activeSearch}
            onChange={(event) => setSearchId(event.target.value)}
            disabled={!options.searches.length}
          >
            {options.searches.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label} ({entry.runs} runs)
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="window">Time window</label>
          <select
            id="window"
            value={activeWindow}
            onChange={(event) => setWindowId(event.target.value)}
            disabled={!options.windows.length}
          >
            {options.windows.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id} ({entry.runs} runs)
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="metric">Metric</label>
          <select
            id="metric"
            value={metric}
            onChange={(event) => setMetric(event.target.value as AnalysisMetric)}
          >
            {Object.entries(METRIC_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="baseline">Compare against</label>
          <select id="baseline" value={baseline} onChange={(event) => setBaseline(event.target.value)}>
            {ENGINE_TIERS.map((tier) => (
              <option key={tier} value={tier}>
                {labelTier(tier)}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* The QA gate. Kept beside the table it grades rather than on the
          settings page, because the budget and the result are read together. */}
      <section className={s.budget}>
        <div className={s.budgetFields}>
          <div>
            <label htmlFor="budgetStat">Acceptance budget on</label>
            <select
              id="budgetStat"
              value={config.budgetStatistic}
              onChange={(event) => setStatistic(event.target.value as BudgetStatistic)}
            >
              {BUDGET_STATISTICS.map((statistic) => (
                <option key={statistic} value={statistic}>
                  {statistic} ({quantileMinSamples(Number(statistic.slice(1)) / 100)}+ runs needed)
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="budgetSec">Must be at or under (seconds)</label>
            <input
              id="budgetSec"
              type="number"
              min="0"
              step="0.1"
              value={budgetSec}
              placeholder="no budget"
              onChange={(event) => setBudgetSec(event.target.value)}
              onBlur={persistBudget}
            />
          </div>
        </div>
        <p className={s.budgetNote}>
          Each engine size is graded pass or fail against this. A size whose sample is too small to
          support the chosen percentile is reported as <b>not tested</b> — never as a failure, because
          it has not missed the budget, it has failed to measure it. Saved with your settings.
        </p>
      </section>

      {!withData.length && (
        <div className={s.empty}>
          <h2>No timed runs in this scope</h2>
          <p>
            Nothing has been measured for this search on {activeWindow || 'this window'} yet. Widen
            the session filter, or run this combination from the workbench.
          </p>
        </div>
      )}

      {withData.length > 0 && (
        <>
          <section className={s.card}>
            <div className={s.cardHeader}>
              <div>
                <h2>Distribution — {METRIC_LABELS[metric]}</h2>
                <span className={s.muted}>
                  Seconds. Latency is right-skewed, so the percentiles carry the story and the mean
                  is shown only for continuity with other tools.
                </span>
              </div>
              <div className={s.actions}>
                <button onClick={() => void copy('Analysis CSV', `${provenance()}\n${analysisToCsv(rows)}`)}>
                  Copy full statistics (CSV)
                </button>
                <button
                  onClick={() =>
                    void copy('Markdown summary', `${provenance()}\n\n${analysisToMarkdown(rows, baseline)}`)
                  }
                >
                  Copy Markdown
                </button>
              </div>
            </div>
            <div className={s.scroll}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Engine size</th>
                    <th title="Timed runs behind this row">Runs</th>
                    <th>Failed</th>
                    <th>Fastest</th>
                    {PERCENTILE_COLUMNS.map((column) => (
                      <th key={column.key} title={`Needs ${quantileMinSamples(column.p)}+ timed runs`}>
                        {column.label}
                      </th>
                    ))}
                    <th>Slowest</th>
                    <th title="Distribution-free 95% confidence interval for the median">Median 95% CI</th>
                    <th title="Standard deviation over the mean — the conventional noise gauge">CV</th>
                    <th title="Interquartile range: spread of the middle half, ignoring the tail">IQR</th>
                    <th title="Median absolute deviation: spread unaffected by a single freak run">MAD</th>
                    <th title="Runs outside the 1.5x IQR fences. Counted, never removed.">Outliers</th>
                    <th title="Events matched per second at the median time">Events/s</th>
                  </tr>
                </thead>
                <tbody>
                  {withData.map((row) => (
                    <tr key={row.tier}>
                      <td>
                        <span className={s.swatch} style={{ background: tierColor(row.tier) }} />
                        <b>{labelTier(row.tier)}</b>
                        {row.tier === baseline && <span className={s.baselineTag}>baseline</span>}
                      </td>
                      <td>{row.summary.n}</td>
                      <td>{row.errors || '—'}</td>
                      <td>{formatSec(row.summary.min)}</td>
                      {PERCENTILE_COLUMNS.map((column) => {
                        const value = row.summary.percentiles[column.key] ?? null;
                        return (
                          <td key={column.key} className={column.key === 'p50' ? s.strong : undefined}>
                            {value === null ? (
                              <span
                                className={s.muted}
                                title={`Needs ${quantileMinSamples(column.p)} timed runs, have ${row.summary.n}`}
                              >
                                n too low
                              </span>
                            ) : column.key === 'p50' ? (
                              <b>{formatSec(value)}</b>
                            ) : (
                              formatSec(value)
                            )}
                          </td>
                        );
                      })}
                      <td>{formatSec(row.summary.max)}</td>
                      <td className={s.mono}>
                        {row.interval
                          ? `${formatSec(row.interval.low)} – ${formatSec(row.interval.high)}`
                          : <span className={s.muted}>n too low</span>}
                      </td>
                      <td className={row.summary.cv !== null && row.summary.cv > NOISY_CV ? s.warnCell : undefined}>
                        {pct(row.summary.cv, 0)}
                      </td>
                      <td>{formatSec(row.summary.iqr)}</td>
                      <td>{formatSec(row.summary.mad)}</td>
                      <td>{row.summary.outliers || '—'}</td>
                      <td>{row.throughput === null ? '—' : Math.round(row.throughput).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className={s.card}>
            <div className={s.cardHeader}>
              <div>
                <h2>Against {labelTier(baseline)} — is the difference real?</h2>
                <span className={s.muted}>
                  Mann-Whitney U, two-sided, α&nbsp;=&nbsp;{ALPHA}. No normality assumed, because
                  search latency is not normally distributed. Read all three columns together: a
                  p-value says only that something moved, and with enough runs everything moves.
                </span>
              </div>
            </div>
            <div className={s.scroll}>
              <table className={s.table}>
                <thead>
                  <tr>
                    <th>Engine size</th>
                    <th>Runs</th>
                    <th title="Hodges-Lehmann shift: the median of every pairwise difference. Negative is faster.">
                      Shift vs baseline
                    </th>
                    <th>Change</th>
                    <th title="Cliff's delta. Positive means this size was faster. Scale-free.">
                      Effect size
                    </th>
                    <th>Significant?</th>
                    <th>
                      Budget
                      {budgetMs !== null && (
                        <small className={s.muted}>
                          {config.budgetStatistic} ≤ {(budgetMs / 1000).toFixed(2)}s
                        </small>
                      )}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {withData.map((row) => {
                    const comparison = row.vsBaseline;
                    const isBaseline = row.tier === baseline;
                    const significant =
                      comparison?.test.usable && comparison.test.p !== null && comparison.test.p < ALPHA;
                    return (
                      <tr key={row.tier}>
                        <td>
                          <span className={s.swatch} style={{ background: tierColor(row.tier) }} />
                          <b>{labelTier(row.tier)}</b>
                        </td>
                        <td>{row.summary.n}</td>
                        {isBaseline ? (
                          <td colSpan={4} className={s.muted}>
                            This is the baseline every other row is measured against.
                          </td>
                        ) : !comparison ? (
                          <td colSpan={4} className={s.muted}>
                            {labelTier(baseline)} has no timed runs in this scope, so there is nothing
                            to compare against.
                          </td>
                        ) : (
                          <>
                            <td className={s.strong}>
                              <b>
                                {comparison.shiftMs === null
                                  ? '—'
                                  : `${comparison.shiftMs > 0 ? '+' : '−'}${formatSec(Math.abs(comparison.shiftMs))} s`}
                              </b>
                              <small className={s.muted}>
                                {comparison.shiftMs === null
                                  ? ''
                                  : comparison.shiftMs < 0
                                    ? 'faster'
                                    : 'slower'}
                              </small>
                            </td>
                            <td>{signedPct(comparison.percent)}</td>
                            <td>
                              {comparison.delta === null ? (
                                '—'
                              ) : (
                                <>
                                  {comparison.effect}
                                  <small className={s.muted}>δ {comparison.delta.toFixed(2)}</small>
                                </>
                              )}
                            </td>
                            <td>
                              {!comparison.test.usable ? (
                                <span className={s.muted} title={comparison.test.reason}>
                                  too few runs
                                </span>
                              ) : (
                                <>
                                  <span className={significant ? s.yes : s.no}>
                                    {significant ? 'Yes' : 'No'}
                                  </span>
                                  <small className={s.muted}>
                                    p&nbsp;=&nbsp;
                                    {comparison.test.p! < 0.001
                                      ? '<0.001'
                                      : comparison.test.p!.toFixed(3)}
                                  </small>
                                </>
                              )}
                            </td>
                          </>
                        )}
                        <td>
                          <span className={`${s.verdict} ${s[`verdict_${row.budget.verdict}`]}`}>
                            {row.budget.verdict === 'pass'
                              ? 'Pass'
                              : row.budget.verdict === 'fail'
                                ? 'Fail'
                                : 'Not tested'}
                          </span>
                          <small className={s.muted} title={row.budget.reason}>
                            {row.budget.headroomMs === null
                              ? row.budget.reason
                              : `${row.budget.headroomMs >= 0 ? '' : '−'}${formatSec(Math.abs(row.budget.headroomMs))} s ${row.budget.headroomMs >= 0 ? 'headroom' : 'over'}`}
                          </small>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className={s.note}>
              A comparison needs {MIN_COMPARE_SAMPLES} timed runs on each size before the p-value is
              reported at all — below that the normal approximation behind the test does not hold,
              and a number would be worse than none.
            </p>
          </section>

          {/* Fitness of the sample, per size. This is the section to read before
              pasting anything above into a customer-facing document. */}
          <section className={s.card}>
            <div className={s.cardHeader}>
              <div>
                <h2>Is this fit to quote?</h2>
                <span className={s.muted}>
                  Specific defects rather than a score, because a score gets argued with and a defect
                  tells you what to re-run.
                </span>
              </div>
            </div>
            {withData.every((row) => !row.health.length) ? (
              <p className={s.clean}>
                <b>No caveats.</b> Every size has enough runs, steady run-to-run times, agreeing event
                counts and no failures. These numbers are safe to show.
              </p>
            ) : (
              withData
                .filter((row) => row.health.length)
                .map((row) => (
                  <div className={s.healthGroup} key={row.tier}>
                    <h3>
                      <span className={s.swatch} style={{ background: tierColor(row.tier) }} />
                      {labelTier(row.tier)}
                    </h3>
                    <ul>
                      {row.health.map((note) => (
                        <li key={note.kind} className={note.severity === 'warning' ? s.warnNote : s.infoNote}>
                          <b>{note.severity === 'warning' ? 'Warning' : 'Note'}:</b> {note.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))
            )}
          </section>
        </>
      )}
    </div>
  );
}
