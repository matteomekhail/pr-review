import type { ReviewState, PullRequest } from './github';

/** Whose move it is in a pull request's review loop. Bots never take a turn. */
export type Turn = { whose: 'mine'; reason: string } | { whose: 'theirs'; waitingOn: string[] };

interface Move {
  login: string;
  name: string;
  at: number;
  review?: ReviewState;
}

function time(iso: string | null): number {
  const parsed = iso == null ? Number.NaN : Date.parse(iso);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function humanMoves(pull: PullRequest): Move[] {
  const reviews = pull.activity.reviews
    .filter((review) => !review.author.isBot && review.state !== 'PENDING')
    .map((review): Move => ({ login: review.author.login.toLowerCase(), name: review.author.login, at: time(review.at), review: review.state }));
  const comments = pull.activity.comments.filter((comment) => !comment.author.isBot).map((comment): Move => ({ login: comment.author.login.toLowerCase(), name: comment.author.login, at: time(comment.at) }));
  return [...reviews, ...comments];
}

function latest(moves: Move[]): Move | undefined {
  return moves.reduce<Move | undefined>((best, move) => (best == null || move.at > best.at ? move : best), undefined);
}

function lastAt(moves: Move[], since: number): number {
  return moves.reduce((best, move) => Math.max(best, move.at), since);
}

function reasonFor(move: Move): string {
  if (move.review === 'CHANGES_REQUESTED') return `Changes requested by @${move.name}`;
  if (move.review === 'APPROVED') return `Approved by @${move.name}`;
  if (move.review != null) return `Review comments from @${move.name}`;
  return `New comment from @${move.name}`;
}

function unique(names: string[]): string[] {
  return [...new Set(names)];
}

/**
 * On my pull request it is my turn when a reviewer spoke after my last push or reply, or when it is approved;
 * it is theirs while a review request is open or after I answered. On someone else's, it is my turn when my
 * review is requested or the author moved since my last review or comment.
 */
export function computeTurn(pull: PullRequest, viewer: string | null, isReviewRequested = false): Turn | null {
  if (viewer == null || pull.isDraft || pull.mergedAt != null || pull.closedAt != null) return null;
  const me = viewer.toLowerCase();
  const author = pull.author?.login.toLowerCase() ?? '';
  const moves = humanMoves(pull);
  const commitAt = time(pull.activity.lastCommitAt);
  const pending = pull.activity.reviewRequests.filter((request) => request.isTeam || (request.name.toLowerCase() !== me && request.name.toLowerCase() !== author));

  if (author === me) {
    const myLast = lastAt(moves.filter((move) => move.login === me), commitAt);
    const theirs = moves.filter((move) => move.login !== me);
    const reply = latest(theirs);
    if (reply != null && reply.at > myLast) return { whose: 'mine', reason: reasonFor(reply) };
    if (pull.reviewDecision === 'APPROVED' && pending.length === 0) return { whose: 'mine', reason: 'Approved · ready to merge' };
    if (pending.length > 0) return { whose: 'theirs', waitingOn: unique(pending.map((request) => request.name)) };
    const reviewers = theirs.filter((move) => move.review != null).sort((left, right) => right.at - left.at);
    return reviewers.length > 0 ? { whose: 'theirs', waitingOn: unique(reviewers.map((move) => move.name)) } : null;
  }

  const requested = isReviewRequested || pull.activity.reviewRequests.some((request) => !request.isTeam && request.name.toLowerCase() === me);
  const mine = latest(moves.filter((move) => move.login === me));
  if (requested) return { whose: 'mine', reason: mine?.review != null ? 'Re-review requested' : 'Review requested' };
  if (mine == null || mine.review === 'APPROVED') return null;
  const authorLast = lastAt(moves.filter((move) => move.login === author), commitAt);
  const authorName = pull.author?.login ?? 'the author';
  if (authorLast > mine.at) return { whose: 'mine', reason: mine.review != null ? `@${authorName} updated it since your review` : `@${authorName} replied since your comment` };
  return { whose: 'theirs', waitingOn: [authorName] };
}
