import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import type { PullRequest, ReviewState } from './github';
import { pullArbitrary } from './testing/arbitraries';
import { lastReviewAt, reviewerCounts, reviewsBy, reviewsSince } from './reviews';

const SINCE = Date.parse('2026-10-01T00:00:00Z');
const [base] = fc.sample(pullArbitrary, { numRuns: 1, seed: 7 });

function pull(author: string, reviews: [login: string, at: string, state?: ReviewState, isBot?: boolean][]): PullRequest {
  return {
    ...base!,
    id: `${author}-${reviews.length}-${reviews.map(([login, at]) => login + at).join()}`,
    author: { login: author, avatarUrl: '' },
    activity: { ...base!.activity, reviews: reviews.map(([login, at, state = 'COMMENTED', isBot = false]) => ({ state, at, author: { login, avatarUrl: '', isBot } })) },
  };
}

describe('reviewsSince', () => {
  test('leaves out bots, the author answering threads, and anything before the period', () => {
    const reviewed = pull('ann', [
      ['bob', '2026-10-02T10:00:00Z', 'APPROVED'],
      ['ann', '2026-10-02T11:00:00Z'],
      ['claude', '2026-10-02T12:00:00Z', 'COMMENTED', true],
      ['zoe', '2026-09-30T23:59:59Z', 'CHANGES_REQUESTED'],
    ]);
    expect(reviewsSince(reviewed, SINCE).map((review) => review.author.login)).toEqual(['bob']);
  });

  test('narrows to one reviewer, ignoring case', () => {
    const reviewed = pull('ann', [['Bob', '2026-10-02T10:00:00Z'], ['zoe', '2026-10-03T10:00:00Z']]);
    expect(reviewsBy(reviewed, SINCE, 'bob')).toHaveLength(1);
    expect(reviewsBy(reviewed, SINCE, '')).toHaveLength(2);
  });
});

describe('reviewerCounts', () => {
  test('counts PRs, not reviews: most first, ties by name', () => {
    const pulls = [
      pull('ann', [['bob', '2026-10-02T10:00:00Z'], ['bob', '2026-10-02T11:00:00Z', 'APPROVED'], ['zoe', '2026-10-03T10:00:00Z']]),
      pull('zoe', [['bob', '2026-10-04T10:00:00Z']]),
      pull('bob', [['amy', '2026-10-04T10:00:00Z'], ['zoe', '2026-09-20T10:00:00Z']]),
    ];
    expect(reviewerCounts(pulls, SINCE)).toEqual([['bob', 2], ['amy', 1], ['zoe', 1]]);
  });
});

describe('lastReviewAt', () => {
  test('the newest review in the period, by the reviewer when one is given', () => {
    const reviewed = pull('ann', [['bob', '2026-10-02T10:00:00Z'], ['zoe', '2026-10-05T10:00:00Z'], ['bob', '2026-10-03T10:00:00Z']]);
    expect(lastReviewAt(reviewed, SINCE, '')).toBe(Date.parse('2026-10-05T10:00:00Z'));
    expect(lastReviewAt(reviewed, SINCE, 'bob')).toBe(Date.parse('2026-10-03T10:00:00Z'));
    expect(lastReviewAt(reviewed, SINCE, 'amy')).toBeNull();
  });
});
