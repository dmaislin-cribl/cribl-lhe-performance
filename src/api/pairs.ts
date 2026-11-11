/**
 * Reading two saved searches as one test case across targets.
 *
 * A Lakehouse-vs-federated comparison is two searches by necessity: the same
 * question asked of two copies of the data, named by two different `dataset=`
 * terms. Analysis and Compare are scoped to one search on purpose (see
 * analysis.ts — pooling different jobs into one distribution is meaningless), so
 * without help the Lakehouse search never has a Federated column and the S3
 * search never has a size column. Pairing (`SavedSearch.counterpartId`) is the
 * help: it tells those views that the two searches are one case.
 *
 * The rule that keeps this honest: **each target's distribution comes from one
 * member, never both.** Normally that is automatic — the Lakehouse member only
 * runs on sizes, the federated member only on Federated. But an unclassified
 * search runs everywhere, so both members can have runs on one target; those
 * are not pooled. The member with more successful timed runs there is kept, and
 * the overlap is reported so the reader knows a set of runs was set aside.
 *
 * Kept runs are relabelled to the primary member's id, so every downstream
 * function that scopes by `searchId` sees one case without knowing pairs exist.
 */

import type { RunRecord } from './appSettings';

export interface PairOverlap {
  target: string;
  keptSearchName: string;
  droppedSearchName: string;
  droppedRuns: number;
}

export interface PairedRuns {
  runs: RunRecord[];
  overlaps: PairOverlap[];
}

function key(run: RunRecord): string {
  return run.searchId || '(unattributed)';
}

/**
 * The runs of `primaryId`, plus its counterpart's on every target the primary
 * does not cover — or just the primary's runs when there is no counterpart.
 * Runs of every other search are passed through untouched.
 */
export function pairRuns(
  runs: RunRecord[],
  primaryId: string,
  counterpartId: string | null,
): PairedRuns {
  if (!counterpartId || counterpartId === primaryId) return { runs, overlaps: [] };
  const members = new Set([primaryId, counterpartId]);

  // Per target, per member: successful timed runs, which decide who is kept.
  const strength = new Map<string, Map<string, number>>();
  const names = new Map<string, string>();
  for (const run of runs) {
    const member = key(run);
    if (!members.has(member)) continue;
    if (run.searchName) names.set(member, run.searchName);
    const byMember = strength.get(run.engine) ?? new Map<string, number>();
    strength.set(run.engine, byMember);
    const ok = run.measured && run.status === 'Success' ? 1 : 0;
    byMember.set(member, (byMember.get(member) ?? 0) + ok);
  }

  const keep = new Map<string, string>();
  const overlaps: PairOverlap[] = [];
  for (const [target, byMember] of strength) {
    const ranked = [...byMember.entries()].sort(
      // More successful timed runs wins; a tie goes to the primary, the search
      // the reader actually picked.
      (a, b) => b[1] - a[1] || (a[0] === primaryId ? -1 : b[0] === primaryId ? 1 : 0),
    );
    keep.set(target, ranked[0][0]);
    if (ranked.length > 1) {
      const dropped = ranked[1][0];
      overlaps.push({
        target,
        keptSearchName: names.get(ranked[0][0]) ?? ranked[0][0],
        droppedSearchName: names.get(dropped) ?? dropped,
        droppedRuns: runs.filter((run) => key(run) === dropped && run.engine === target && run.measured).length,
      });
    }
  }

  const out: RunRecord[] = [];
  for (const run of runs) {
    const member = key(run);
    if (!members.has(member)) {
      out.push(run);
      continue;
    }
    if (keep.get(run.engine) !== member) continue;
    out.push(member === primaryId ? run : { ...run, searchId: primaryId });
  }
  return { runs: out, overlaps };
}

/**
 * Whether a paired case compared like for like: every target that has data
 * should have matched the same number of events. Returns the distinct counts
 * by target when they disagree, or null when they agree (or there is too little
 * to compare). Two copies of "the same" data that disagree — a retention gap, a
 * filter in one pipeline — make the timing comparison a comparison of different
 * work, however clean the numbers look.
 */
export function pairCountMismatch(runs: RunRecord[], windowId: string): Record<string, number> | null {
  const byTarget: Record<string, number> = {};
  for (const run of runs) {
    if (!run.measured || run.status !== 'Success' || run.window !== windowId) continue;
    if (typeof run.totalEventCount !== 'number' || run.engine in byTarget) continue;
    byTarget[run.engine] = run.totalEventCount;
  }
  const distinct = new Set(Object.values(byTarget));
  return Object.keys(byTarget).length > 1 && distinct.size > 1 ? byTarget : null;
}
