import type { PullRequest, ReviewState } from './github';

/** AI reviewers shown beside the author avatar, always in this order so each keeps its own column. */
export const REVIEW_BOTS = [
  { id: 'claude', name: 'Claude', login: /^claude(\[bot\])?$/i, check: /^claude[-\s]review$/i, avatarUrl: 'https://avatars.githubusercontent.com/in/1236702?v=4' },
  { id: 'greptile', name: 'Greptile', login: /^greptile(-apps)?(\[bot\])?$/i, check: /^greptile review$/i, avatarUrl: 'https://avatars.githubusercontent.com/in/867647?v=4' },
] as const;

export type ReviewBotId = (typeof REVIEW_BOTS)[number]['id'];

export type BotReviewState = 'running' | 'approved' | 'changes' | 'commented';

export interface BotReview {
  bot: ReviewBotId;
  name: string;
  avatarUrl: string;
  state: BotReviewState;
  /** The review predates the latest commit. */
  isOutdated: boolean;
  /** When the review was submitted; null while running without an earlier review. */
  at: string | null;
}

const RUNNING_STATUSES = new Set(['QUEUED', 'IN_PROGRESS', 'PENDING', 'WAITING', 'REQUESTED']);

/** Keeps only the check runs that belong to a known review bot, so the queue does not hold every CI job. */
export function isReviewBotCheck(name: string): boolean {
  return REVIEW_BOTS.some((bot) => bot.check.test(name));
}

function stateOf(review: ReviewState): BotReviewState {
  if (review === 'APPROVED') return 'approved';
  if (review === 'CHANGES_REQUESTED') return 'changes';
  return 'commented';
}

/** One entry per review bot, or null when that bot has neither reviewed nor started on this pull request. */
export function botReviews(pull: PullRequest): (BotReview | null)[] {
  const commitAt = pull.activity.lastCommitAt == null ? 0 : Date.parse(pull.activity.lastCommitAt);
  return REVIEW_BOTS.map((bot) => {
    const isRunning = pull.activity.checks.some((check) => bot.check.test(check.name) && RUNNING_STATUSES.has(check.status));
    const reviews = pull.activity.reviews.filter((review) => review.author.isBot && bot.login.test(review.author.login) && review.state !== 'PENDING');
    const last = reviews.reduce<(typeof reviews)[number] | undefined>((best, review) => (best == null || review.at > best.at ? review : best), undefined);
    if (!isRunning && last == null) return null;
    const avatarUrl = last?.author.avatarUrl || bot.avatarUrl;
    if (isRunning) return { bot: bot.id, name: bot.name, avatarUrl, state: 'running', isOutdated: false, at: last?.at ?? null };
    const review = last as NonNullable<typeof last>;
    return { bot: bot.id, name: bot.name, avatarUrl, state: review.state === 'DISMISSED' ? 'commented' : stateOf(review.state), isOutdated: review.state === 'DISMISSED' || Date.parse(review.at) < commitAt, at: review.at };
  });
}

export function describeBotReview(review: BotReview, ago: (iso: string) => string): string {
  if (review.state === 'running') return `${review.name} is reviewing…`;
  const verb = review.state === 'approved' ? 'approved' : review.state === 'changes' ? 'requested changes' : 'reviewed';
  const when = review.at == null ? '' : ` · ${ago(review.at)}`;
  return `${review.name} ${verb}${review.isOutdated ? ' (before the latest push)' : ''}${when}`;
}
