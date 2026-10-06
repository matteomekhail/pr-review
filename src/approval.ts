import type { PullActivity, PullRequest, ReviewState } from './github';

type Review = PullActivity['reviews'][number];

const VERDICTS = new Set<ReviewState>(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/** Each reviewer's latest approval, change request or dismissal, by login; a later plain comment changes nothing. */
export function latestVerdicts(reviews: readonly Review[]): Map<string, Review> {
  const verdicts = new Map<string, Review>();
  for (const review of reviews) {
    const previous = verdicts.get(review.author.login);
    if (VERDICTS.has(review.state) && (previous == null || review.at >= previous.at)) verdicts.set(review.author.login, review);
  }
  return verdicts;
}

/**
 * The decision GitHub would show if the repository required reviews. Without that requirement GitHub reports
 * none, so an approved PR would read as unapproved; this reads it from people's latest verdicts instead.
 */
export function decisionFromVerdicts(author: string | null, reviews: readonly Review[]): 'APPROVED' | 'CHANGES_REQUESTED' | null {
  const people = [...latestVerdicts(reviews).values()].filter((review) => !review.author.isBot && review.author.login !== author);
  if (people.some((review) => review.state === 'CHANGES_REQUESTED')) return 'CHANGES_REQUESTED';
  return people.some((review) => review.state === 'APPROVED') ? 'APPROVED' : null;
}

/** My latest verdict on a pull request, if any. */
export function verdictOf(reviews: readonly Review[], viewer: string | null): ReviewState | null {
  if (viewer == null) return null;
  const me = viewer.toLowerCase();
  return [...latestVerdicts(reviews).values()].find((review) => review.author.login.toLowerCase() === me)?.state ?? null;
}

/**
 * The pull request as it will read once my approval lands: my review added, the requests it answers (mine and my
 * teams') gone, and the decision re-read unless GitHub's own rules still decide it.
 */
export function withMyApproval(pull: PullRequest, viewer: string, myTeams: ReadonlySet<string> | null, at: string): PullRequest {
  const me = viewer.toLowerCase();
  const answered = (request: PullActivity['reviewRequests'][number]): boolean => (request.isTeam ? myTeams?.has(request.name.toLowerCase()) === true : request.name.toLowerCase() === me);
  const reviews = [...pull.activity.reviews, { state: 'APPROVED' as const, at, author: { login: viewer, avatarUrl: '', isBot: false } }];
  const activity = { ...pull.activity, reviews, reviewRequests: pull.activity.reviewRequests.filter((request) => !answered(request)) };
  const reviewDecision = pull.reviewDecision === 'REVIEW_REQUIRED' ? pull.reviewDecision : decisionFromVerdicts(pull.author?.login ?? null, reviews);
  return { ...pull, activity, reviewDecision };
}
