import type { PullActivity, PullRequest } from './github';
import { ranked } from './merged';

type Review = PullActivity['reviews'][number];

/** Reviews people left on a PR since `since` (ms): not bots, and not its author replying in their own threads. */
export function reviewsSince(pull: PullRequest, since: number): Review[] {
  const author = pull.author?.login.toLowerCase();
  return pull.activity.reviews.filter((review) => !review.author.isBot && review.author.login.toLowerCase() !== author && Date.parse(review.at) >= since);
}

/** Their reviews since `since`, newest last; anyone's when `reviewer` is empty. */
export function reviewsBy(pull: PullRequest, since: number, reviewer: string): Review[] {
  const login = reviewer.toLowerCase();
  return reviewsSince(pull, since).filter((review) => login === '' || review.author.login.toLowerCase() === login);
}

/** People by how many of these PRs they reviewed since `since`, most first, then by name; several reviews on one PR count once. */
export function reviewerCounts(pulls: readonly PullRequest[], since: number): [string, number][] {
  const counts = new Map<string, number>();
  pulls.forEach((pull) => new Set(reviewsSince(pull, since).map((review) => review.author.login)).forEach((login) => counts.set(login, (counts.get(login) ?? 0) + 1)));
  return ranked(counts);
}

/** When `reviewer` (anyone, when empty) last reviewed the PR since `since`, in ms; null when they did not. */
export function lastReviewAt(pull: PullRequest, since: number, reviewer: string): number | null {
  const times = reviewsBy(pull, since, reviewer).map((review) => Date.parse(review.at));
  return times.length === 0 ? null : Math.max(...times);
}
