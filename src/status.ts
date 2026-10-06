import type { PullRequest, ReviewState } from './github';

export type StatusTone = 'queued' | 'blocked' | 'draft' | 'approved' | 'pending';
export type AttentionReason = 'conflicts' | 'failing checks' | 'changes requested' | 'blocked' | 'not approved';

export const ATTENTION_ORDER: readonly AttentionReason[] = ['conflicts', 'failing checks', 'changes requested', 'blocked', 'not approved'];

export const ATTENTION_META: Record<AttentionReason, { title: string; tone: 'bad' | 'wait'; task: string }> = {
  conflicts: { title: 'Merge conflicts', tone: 'bad', task: 'merge or rebase onto the base branch as the repo prefers, resolve every conflict keeping the intent of both sides, and make sure it builds' },
  'failing checks': { title: 'Failing checks', tone: 'bad', task: 'run `gh pr checks <url>`, read the failing logs (`gh run view <run-id> --log-failed`), and fix the root cause in code; never skip, disable or loosen tests or lint' },
  'changes requested': { title: 'Changes requested', tone: 'bad', task: 'read every review and unresolved thread (`gh pr view <url> --comments`), address each requested change in code, reply on each thread with what changed, and re-request review' },
  blocked: { title: 'Blocked by branch rules', tone: 'bad', task: 'find what branch protection still requires (`gh pr view <url> --json mergeStateStatus,reviewDecision,statusCheckRollup`) and resolve it, or report exactly what a human must do' },
  'not approved': { title: 'Not approved', tone: 'wait', task: 'read the PR and all review comments, address anything unresolved, make sure checks pass, then request review from the suggested reviewers (`gh pr edit <url> --add-reviewer`); never self-approve' },
};

export function isConflicted(pull: PullRequest): boolean {
  return pull.mergeable === 'CONFLICTING' || pull.mergeStateStatus === 'DIRTY';
}

export function isFailing(pull: PullRequest): boolean {
  return pull.checkState === 'FAILURE' || pull.checkState === 'ERROR';
}

const MAX_LISTED_CHECKS = 4;
/** Real failures first; cancelled runs are usually superseded noise. */
const OUTCOME_RANK: Record<string, number> = { TIMED_OUT: 1, ACTION_REQUIRED: 1, CANCELLED: 2 };

/** Failing checks by name, worst first, with how they ended unless they simply failed: `lint, e2e (cancelled), +2 more`. */
export function describeFailingChecks(pull: PullRequest): string {
  const ranked = [...pull.failingChecks].sort((left, right) => (OUTCOME_RANK[left.outcome] ?? 0) - (OUTCOME_RANK[right.outcome] ?? 0));
  const names = ranked.map((check) => (check.outcome === 'FAILURE' ? check.name : `${check.name} (${check.outcome.toLowerCase().replace(/_/g, ' ')})`));
  const extra = names.length - MAX_LISTED_CHECKS;
  return [...names.slice(0, MAX_LISTED_CHECKS), ...(extra > 0 ? [`+${extra} more`] : [])].join(', ');
}

/** A reason a pull request is red. */
export type Blocker = Exclude<AttentionReason, 'not approved'>;

/** The order a red status icon picks its glyph from: what most needs a human first. */
const BLOCKER_ORDER: readonly Blocker[] = ['conflicts', 'changes requested', 'failing checks', 'blocked'];
const BLOCKER_LABELS: Record<Blocker, string> = { conflicts: 'Conflicts', 'changes requested': 'Changes requested', 'failing checks': 'Checks failing', blocked: 'Blocked' };
const REVIEW_VERDICTS = new Set<ReviewState>(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

export function blockers(pull: PullRequest): Blocker[] {
  const reasons = attentionReasons(pull);
  return BLOCKER_ORDER.filter((reason) => reasons.includes(reason));
}

/** Reviewers whose latest verdict asks for changes; a later comment does not withdraw it. */
export function changeRequesters(pull: PullRequest): string[] {
  const verdicts = new Map<string, { state: ReviewState; at: string }>();
  for (const review of pull.activity.reviews) {
    const previous = verdicts.get(review.author.login);
    if (REVIEW_VERDICTS.has(review.state) && (previous == null || review.at >= previous.at)) verdicts.set(review.author.login, review);
  }
  return [...verdicts].filter(([, verdict]) => verdict.state === 'CHANGES_REQUESTED').map(([login]) => login);
}

/** One phrase per reason the pull request is red, the icon's own first. */
export function describeBlockers(pull: PullRequest): string[] {
  return blockers(pull).map((blocker) => {
    switch (blocker) {
      case 'conflicts':
        return 'Merge conflicts';
      case 'changes requested': {
        const names = changeRequesters(pull);
        return names.length === 0 ? 'Changes requested' : `Changes requested by ${names.map((name) => `@${name}`).join(', ')}`;
      }
      case 'failing checks': {
        const failing = describeFailingChecks(pull);
        return failing === '' ? 'Checks failing' : `Checks failing: ${failing}`;
      }
      case 'blocked':
        return 'Approved, but blocked by branch rules';
      default:
        return blocker satisfies never;
    }
  });
}

export function prStatus(pull: PullRequest): { tone: StatusTone; label: string; blocker?: Blocker } {
  if (pull.queueEntry != null) return { tone: 'queued', label: 'In merge queue' };
  const [blocker] = blockers(pull);
  if (blocker != null) return { tone: 'blocked', label: BLOCKER_LABELS[blocker], blocker };
  if (pull.isDraft) return { tone: 'draft', label: 'Draft' };
  if (pull.reviewDecision === 'APPROVED') return { tone: 'approved', label: 'Approved' };
  return { tone: 'pending', label: 'Not approved' };
}

export function attentionReasons(pull: PullRequest): AttentionReason[] {
  const reasons: AttentionReason[] = [];
  if (isConflicted(pull)) reasons.push('conflicts');
  if (isFailing(pull)) reasons.push('failing checks');
  if (pull.reviewDecision === 'CHANGES_REQUESTED') reasons.push('changes requested');
  else if (pull.reviewDecision !== 'APPROVED') reasons.push('not approved');
  else if (pull.mergeStateStatus === 'BLOCKED' && reasons.length === 0) reasons.push('blocked');
  return reasons;
}

export function needsAttention(pull: PullRequest): boolean {
  return pull.queueEntry == null && !pull.isDraft && attentionReasons(pull).length > 0;
}

export function buildAgentPrompt(pulls: readonly PullRequest[], included: ReadonlySet<AttentionReason>): string {
  const lines = pulls.map((pull) => {
    const reasons = attentionReasons(pull).filter((reason) => included.has(reason)).join(' + ');
    return `- ${pull.url}\n  repo: ${pull.repository.nameWithOwner} · branch: ${pull.headRefName} → ${pull.baseRefName} · problem: ${reasons}\n  title: ${pull.title}`;
  });
  const tasks = ATTENTION_ORDER.filter((reason) => included.has(reason)).map((reason) => `- ${ATTENTION_META[reason].title}: ${ATTENTION_META[reason].task}.`);
  return [
    `Get these ${pulls.length} open pull request${pulls.length === 1 ? '' : 's'} to green, approved and mergeable.`,
    '',
    ...lines,
    '',
    'For each pull request, check out its head branch (`gh pr checkout <url>`), pull the latest base branch, then handle each listed problem:',
    ...tasks,
    '',
    'Run the relevant tests, typecheck and lint locally before pushing. Push to the same branch without force-pushing unless a rebase requires it, then re-check `gh pr checks <url>` until it passes.',
    '',
    'Work through them one at a time. When done, report each PR with what was wrong, what you changed, and its final status. If one needs a product decision or a human reviewer, stop on that PR and say exactly what is needed instead of guessing.',
  ].join('\n');
}
