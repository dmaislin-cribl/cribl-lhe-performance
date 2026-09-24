/**
 * In-app documentation.
 *
 * This lab produces numbers an SE puts in front of a customer, and the honest
 * reading of those numbers depends on things the UI can only hint at in a
 * sentence: what `totalMs` includes, why a p95 is sometimes withheld, why a
 * resize is confirmed, what a stopped session is and is not evidence of. Handing
 * that to a wiki page means the explanation is somewhere else at the moment it
 * matters, and drifts.
 *
 * Every figure here is **read from the same constant the app enforces** —
 * `P95_MIN_SAMPLES`, `quantileMinSamples`, `MIN_COMPARE_SAMPLES`, `TIERS`,
 * `DEFAULT_WINDOWS`, `MAX_RUNS`, `MAX_SELECTED`. If a limit changes, this page
 * changes with it. Do not retype a number into the prose: that is how docs come
 * to contradict the software they describe.
 *
 * External references are rendered as plain copyable text, not links: the app
 * runs in a sandboxed iframe where popups are blocked, so a link that looks
 * clickable and does nothing is worse than an address the reader can copy.
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { MAX_RUNS } from '../api/appSettings';
import { MIN_COMPARE_SAMPLES, NOISY_CV, REPORTED_PERCENTILES, quantileMinSamples } from '../api/perfStats';
import { MAX_SELECTED } from '../api/searches';
import { P95_MIN_SAMPLES } from '../api/stats';
import { TIERS, describeTier } from '../api/tiers';
import { DEFAULT_WINDOWS, MAX_WINDOWS } from '../api/windows';
import s from './DocsPage.module.css';

interface Section {
  id: string;
  title: string;
}

const SECTIONS: Section[] = [
  { id: 'what', title: 'What this measures' },
  { id: 'start', title: 'Running your first test' },
  { id: 'windows', title: 'Time windows' },
  { id: 'repetitions', title: 'Repetitions and the statistics they buy' },
  { id: 'sizes', title: 'Engine sizes and sweeps' },
  { id: 'sessions', title: 'Sessions and reading results' },
  { id: 'analysis', title: 'Analysis: is the difference real?' },
  { id: 'defensible', title: 'Before you show a customer' },
  { id: 'limits', title: 'What this app will not tell you' },
  { id: 'trouble', title: 'Troubleshooting' },
];

export default function DocsPage() {
  /** Percentile support floors, straight from the function the app grades with. */
  const floors = useMemo(
    () =>
      REPORTED_PERCENTILES.map((p) => ({
        label: `p${Math.round(p * 100)}`,
        needs: quantileMinSamples(p),
      })),
    [],
  );

  return (
    <div className={s.page}>
      <div className={s.head}>
        <div>
          <h1>How this lab works</h1>
          <p className={s.intro}>
            A Lakehouse Engine performance lab: it runs the same saved searches over a fixed set of
            time windows, repeatedly, on one or more engine sizes, and reports how long each one
            took — with enough provenance that the numbers survive being pasted into a customer
            deck. This page is the reasoning behind the readouts. Every threshold quoted below is
            read from the code that enforces it, so it cannot drift out of date.
          </p>
        </div>
        <Link className={s.back} to="/">
          Back to the workbench
        </Link>
      </div>

      <nav className={s.toc} aria-label="On this page">
        {SECTIONS.map((section) => (
          <a key={section.id} href={`#${section.id}`}>
            {section.title}
          </a>
        ))}
      </nav>

      <section className={s.block} id="what">
        <h2>What this measures</h2>
        <p>
          The headline number is <b>total time</b>: <code>timeCompleted − timeCreated</code> as the
          search API reported it. That is start to finish from the server's point of view,{' '}
          <b>queue wait included</b>, because it is the wait a person actually experiences. It is
          read from the metadata line of the job results, not timed in the browser.
        </p>
        <p>It splits into two parts, both recorded next to it so a slow total can be attributed:</p>
        <ul>
          <li>
            <b>Queue</b> (<code>timeStarted − timeCreated</code>) — how long the job waited before
            the engine began. A large queue on a small engine is a concurrency finding, not a
            scan-speed one.
          </li>
          <li>
            <b>Engine</b> (<code>timeCompleted − timeStarted</code>) — execution only. This is the
            number to use when the question is engine capacity rather than end-to-end wait.
          </li>
        </ul>
        <p className={s.note}>
          Browser wall-clock time is also recorded, but it is never reported as the engine's cost —
          it includes network and iframe overhead that has nothing to do with Lakehouse.
        </p>
      </section>

      <section className={s.block} id="start">
        <h2>Running your first test</h2>
        <ol>
          <li>
            <b>
              <Link to="/searches">Test searches</Link>
            </b>{' '}
            — save the queries you want to time. Searches must carry <b>no time bounds</b>: the lab
            supplies earliest and latest per window, and a bound written into the query would
            override the very thing the experiment varies. You can measure up to {MAX_SELECTED} at
            once.
          </li>
          <li>
            <b>
              <Link to="/settings">Settings</Link>
            </b>{' '}
            — confirm the search worker group, choose the time windows and how many runs each gets,
            and tick the engine sizes to test (or leave them all unticked to measure the size the
            engine is on now).
          </li>
          <li>
            <b>
              <Link to="/">Overview</Link>
            </b>{' '}
            — name the session before you press run. A name is what makes a result citable later:{' '}
            <i>“before index tuning”</i> against <i>“after”</i> beats two timestamps.
          </li>
          <li>
            Run one window first to check the query returns what you expect, then run the full set.
            Each window does one <b>unmeasured warm-up</b> before its timed runs, so the first
            search's cold-start cost is not counted as the engine's speed.
          </li>
          <li>
            <b>
              <Link to="/sessions">Sessions</Link>
            </b>{' '}
            → <b>Results</b> for the numbers, <b>Analyse</b> for whether a difference is real,{' '}
            <b>Compare sizes</b> for the size-over-size table.
          </li>
        </ol>
      </section>

      <section className={s.block} id="windows">
        <h2>Time windows</h2>
        <p>
          A window is a span of data to search — the default set ramps from{' '}
          {DEFAULT_WINDOWS[0].label} to {DEFAULT_WINDOWS[DEFAULT_WINDOWS.length - 1].label}, roughly
          doubling, which is wide enough to show where a size stops scaling without taking all day.
          Edit, add or delete rows in <Link to="/settings">Settings</Link> (up to {MAX_WINDOWS}); the
          right ramp depends on the dataset, since a 14-day window cannot be measured against four
          days of retention and an hour does not stress a 14 TB/day engine.
        </p>
        <p>Two rules make the windows comparable, and both matter more than they look:</p>
        <ul>
          <li>
            <b>Bounds are absolute and resolved once per run.</b> Every window is converted to fixed
            epoch seconds against a single anchor captured at the start. A relative expression
            re-evaluated per search would mean repetitions either side of an hour boundary searched
            different data and then got averaged together as one sample.
          </li>
          <li>
            <b>Windows end at the last fully-elapsed hour or UTC day</b> (the “snap to” column), so a
            window never includes data still being ingested. Partially-written data is the most
            common reason two identical runs disagree on event count.
          </li>
        </ul>
        <p className={s.note}>
          A window's id is how its runs are recorded. Renaming or deleting an id leaves the runs
          already measured under it in the log but out of the comparison — Settings marks windows
          that have runs with ⚠ for exactly this reason. When you want the old numbers to stay
          comparable, add a new row instead of editing one.
        </p>
      </section>

      <section className={s.block} id="repetitions">
        <h2>Repetitions and the statistics they buy</h2>
        <p>
          Every window runs one warm-up plus N timed repetitions. N is set per window, because the
          windows do not cost the same: 20 runs of a 14-day window on a small engine can be an hour
          of wall clock where 20 runs of the 1-hour window is a couple of minutes.
        </p>
        <p>
          What you can honestly report is a function of N. A nearest-rank percentile over too few
          samples is <b>arithmetically identical to the maximum</b> — reporting it as “p95” would
          overstate what was measured, so the app withholds it instead:
        </p>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Statistic</th>
              <th className={s.num}>Timed runs needed</th>
            </tr>
          </thead>
          <tbody>
            {floors.map((floor) => (
              <tr key={floor.label}>
                <td>{floor.label}</td>
                <td className={s.num}>{floor.needs}</td>
              </tr>
            ))}
            <tr>
              <td>Significance test (per size)</td>
              <td className={s.num}>{MIN_COMPARE_SAMPLES}</td>
            </tr>
          </tbody>
        </table>
        <p>
          Below the floor you get min, median and max — all values that were actually observed — and
          an <code>n too low</code> marker where the percentile would have been. The default of{' '}
          {P95_MIN_SAMPLES} repetitions exists because it is the smallest sample a p95 can be quoted
          from.
        </p>
        <p className={s.note}>
          Spread matters as much as the middle. A coefficient of variation above{' '}
          {Math.round(NOISY_CV * 100)}% means the runs disagreed with each other enough that a
          single median is a weak summary — usually noisy-neighbour load, a cache that warmed
          mid-series, or data still moving. Fix the conditions rather than averaging harder.
        </p>
      </section>

      <section className={s.block} id="sizes">
        <h2>Engine sizes and sweeps</h2>
        <p>
          A sweep measures the same matrix on several engine sizes in one unattended run, resizing
          between them. It always runs <b>smallest to largest</b>: not the cheapest order in
          resizes, but it establishes the cheap end first, discovers a broken query on Nano rather
          than eight resizes into 14 TB/day, and reads the same way every time.
        </p>
        <table className={s.table}>
          <thead>
            <tr>
              <th>Size</th>
              <th>Daily ingest limit</th>
              <th>Availability</th>
            </tr>
          </thead>
          <tbody>
            {TIERS.map((tier) => (
              <tr key={tier.id}>
                <td>{tier.label}</td>
                <td>{describeTier(tier.id)}</td>
                <td>{tier.byRequest ? 'Enabled by Cribl on request' : 'Self-service resize'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          4X-Large and above are deliberately absent: they are support-only upgrades, so offering
          them would put a step in the sweep that is certain to be rejected halfway through a
          multi-hour series.
        </p>
        <ul>
          <li>
            <b>A resize is never silent.</b> It changes live Lakehouse capacity — and the bill — for
            everything using that engine, not just this lab. The app confirms before the first one;
            one confirmation covers the planned series, and the dialog lists every size it will pass
            through.
          </li>
          <li>
            <b>Nothing is timed mid-resize.</b> A run starts only once the engine reports both the
            requested size <i>and</i> ready. Timing during a resize would attribute runs to a size
            that was not in place — a comparison that is silently wrong rather than visibly broken.
          </li>
          <li>
            <b>The original size is restored afterwards</b> by default, so a sweep that ends on the
            largest size does not leave capacity parked at the top until somebody notices.
          </li>
        </ul>
      </section>

      <section className={s.block} id="sessions">
        <h2>Sessions and reading results</h2>
        <p>
          One session is one press of a run button: the selected searches × the chosen windows ×
          (warm-up + timed runs), across the selected sizes. It is the unit that has a name, and
          names are what make two sets of numbers comparable in a conversation.
        </p>
        <p>
          <Link to="/sessions">Sessions</Link> → <b>Results</b> gives one row per{' '}
          <b>search × window × engine size</b>. Never fewer dimensions than that: a median pooling
          two sizes or two windows is arithmetically fine and physically meaningless.
        </p>
        <ul>
          <li>
            <b>Runs</b> reads <code>done/asked-for</code>, in red when short, with <code>✕n</code>{' '}
            for failures. Failed runs are counted, never averaged in — a failure has no timing to
            contribute.
          </li>
          <li>
            <b>⚠ on the event count</b> means repetitions disagreed about how many events matched.
            The data moved underneath the measurement, so the timings are of different work.
          </li>
          <li>
            A <b>stopped</b> session — interrupted, or the tab was closed — keeps everything it
            measured. Its numbers are real; the set is partial. The coverage line says how partial,
            which is what lets you quote a complete cell from an incomplete session.
          </li>
        </ul>
        <p className={s.note}>
          The run log is capped at {MAX_RUNS.toLocaleString()} runs, newest kept. A session whose
          runs have aged out stays in the list with its name and notes — that reads honestly as a
          benchmark whose measurements have expired, rather than vanishing.
        </p>
      </section>

      <section className={s.block} id="analysis">
        <h2>Analysis: is the difference real?</h2>
        <p>
          Two medians differing is not a finding. <Link to="/analysis">Analysis</Link> tests whether
          the difference survives the noise, using methods that assume nothing about the shape of
          the distribution — latency is right-skewed with a hard floor and an open tail, so
          normality is never assumed anywhere in this app.
        </p>
        <ul>
          <li>
            <b>Mann-Whitney U</b> for significance, with tie and continuity correction. It refuses
            to report a p-value below {MIN_COMPARE_SAMPLES} timed runs per side rather than
            producing one the sample cannot support.
          </li>
          <li>
            <b>Hodges-Lehmann</b> for the shift in milliseconds — “how much faster”, as a median of
            pairwise differences rather than a difference of medians.
          </li>
          <li>
            <b>Cliff's delta</b> for effect size: the probability a run on one size beats a run on
            the other, which is scale-free and reads well to a non-statistician.
          </li>
          <li>
            <b>A budget verdict</b> of pass, fail, or <b>unknown</b>. Unknown never collapses into
            fail: a sample too small to support the chosen percentile has not missed the budget, it
            has failed to test it.
          </li>
        </ul>
      </section>

      <section className={s.block} id="defensible">
        <h2>Before you show a customer</h2>
        <p>Five things to check. Each corresponds to a warning the app will already show you:</p>
        <ol>
          <li>
            <b>One query, one dataset.</b> Mixed query revisions or datasets in the same comparison
            make the table meaningless. Compare flags both.
          </li>
          <li>
            <b>Equal, sufficient samples.</b> Cells short of their repetition count rest on thinner
            evidence than the rest of the table. Say so, or re-run them.
          </li>
          <li>
            <b>Stable event counts.</b> If the count moved between repetitions, the runs did
            different amounts of work.
          </li>
          <li>
            <b>Percentiles you earned.</b> If p95 shows as <code>n too low</code>, quote the median
            and the range instead — do not substitute the maximum.
          </li>
          <li>
            <b>State the conditions.</b> Export with the provenance header (it carries the dataset,
            search group, engine size, window bounds and your session notes). A table without its
            conditions stops being interpretable within about a week.
          </li>
        </ol>
      </section>

      <section className={s.block} id="limits">
        <h2>What this app will not tell you</h2>
        <ul>
          <li>
            <b>Cache state.</b> The app cannot observe or control Lakehouse caching. The cache field
            in Settings is an unverified operator annotation and stays <i>Unknown</i> unless you set
            the state yourself — it is a label on your evidence, not a measurement.
          </li>
          <li>
            <b>Credit cost per search.</b> Deliberately not computed. Lakehouse billing is the
            engine size tier plus retained storage; individual searches over Lakehouse data do not
            carry a per-search charge, so a “credits for this search” figure would be invented
            rather than measured. Size and storage questions belong in the FinOps Center, where the
            org's actual rates are.
          </li>
          <li>
            <b>Bytes scanned.</b> Not exposed by the job metadata this app reads, so cost-per-byte
            cannot be derived. Event count is the volume measure available.
          </li>
          <li>
            <b>Anything about other workloads.</b> Timings reflect the engine as it was, including
            whatever else was running on it. That is a feature for a realism question and a
            confound for a capacity one — run when the org is quiet if the claim is about capacity.
          </li>
        </ul>
      </section>

      <section className={s.block} id="trouble">
        <h2>Troubleshooting</h2>
        <dl className={s.faq}>
          <dt>The engine list is empty.</dt>
          <dd>
            Almost always the wrong search worker group in <Link to="/settings">Settings</Link>. Both
            the search jobs and the engine inventory are read through that group —{' '}
            <code>default_search</code> in a stock Cribl Cloud org.
          </dd>

          <dt>A resize was rejected.</dt>
          <dd>
            Either the size needs enabling for your org by Cribl (the table above marks which), or
            your workspace names that size differently from the identifier the app inferred. The
            engine list shows the real value once the size appears there.
          </dd>

          <dt>Copy to clipboard did nothing.</dt>
          <dd>
            The app runs in a sandboxed iframe: clipboard access needs a recent click in the page,
            and file downloads are blocked outright. Click the page, then copy again. Every export is
            clipboard-based for this reason.
          </dd>

          <dt>A run failed with no obvious cause.</dt>
          <dd>
            Check the query in Cribl Search directly. A few KQL constructs crash in complex
            pipelines — an inline <code>(?i)</code> regex flag, and{' '}
            <code>summarize → summarize max(iff(...))</code> over real rows — and the failure surfaces
            here as an errored run.
          </dd>

          <dt>The numbers moved and nothing changed.</dt>
          <dd>
            Check the event counts first, then the coefficient of variation. Data still being
            ingested, another workload on the engine, or a cache that warmed mid-series all show up
            as spread rather than as a shifted median.
          </dd>
        </dl>
      </section>

      <p className={s.footer}>
        Cribl's own documentation for the products this lab drives:{' '}
        <code>docs.cribl.io/lakehouse</code>, <code>docs.cribl.io/search</code>, and the FinOps
        Center for credit and storage figures. Addresses rather than links — this sandboxed iframe
        blocks popups, so a dead link would be worse than an address you can copy.
      </p>
    </div>
  );
}
