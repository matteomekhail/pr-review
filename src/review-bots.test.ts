import { describe, expect, test } from 'bun:test';
import type { PullActivity, PullRequest, ReviewState } from './github';
import { botReviews, describeBotReview, isReviewBotCheck } from './review-bots';

function botReview(login: string, state: ReviewState, at: string): PullActivity['reviews'][number] {
  return { state, at, author: { login, avatarUrl: `https://avatars.example/${login}?v=4`, isBot: true } };
}

function pull(activity: Partial<PullActivity>): PullRequest {
  return {
    id: 'id', number: 1, title: 't', url: 'https://github.com/o/r/pull/1', isDraft: false,
    createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-26T10:00:00Z', additions: 1, deletions: 1, changedFiles: 1,
    headRefName: 'h', baseRefName: 'main', mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
    author: { login: 'me', avatarUrl: '' }, repository: { nameWithOwner: 'o/r' }, checkState: 'SUCCESS', queueEntry: null,
    activity: { lastCommitAt: '2026-09-25T09:00:00Z', reviewRequests: [], reviews: [], comments: [], checks: [], ...activity },
  };
}

const [claudeOf, greptileOf] = [(p: PullRequest) => botReviews(p)[0], (p: PullRequest) => botReviews(p)[1]];

describe('botReviews', () => {
  test('nothing to show when no bot touched the pull request', () => {
    expect(botReviews(pull({}))).toEqual([null, null]);
  });

  test('a running review check shows as running, even over an older review', () => {
    const running = pull({ checks: [{ name: 'claude-review', status: 'IN_PROGRESS', conclusion: null }], reviews: [botReview('claude', 'APPROVED', '2026-09-24T09:00:00Z')] });
    expect(claudeOf(running)).toMatchObject({ state: 'running', isOutdated: false, at: '2026-09-24T09:00:00Z' });
    expect(greptileOf(pull({ checks: [{ name: 'Greptile Review', status: 'QUEUED', conclusion: null }] }))).toMatchObject({ state: 'running', at: null });
  });

  test('the latest review sets the verdict', () => {
    const reviewed = pull({ reviews: [botReview('claude', 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z'), botReview('claude', 'APPROVED', '2026-09-25T11:00:00Z'), botReview('greptile-apps', 'COMMENTED', '2026-09-25T10:30:00Z')] });
    expect(claudeOf(reviewed)).toMatchObject({ state: 'approved', isOutdated: false, avatarUrl: 'https://avatars.example/claude?v=4' });
    expect(greptileOf(reviewed)).toMatchObject({ state: 'commented', isOutdated: false });
  });

  test('a review before the latest push is outdated, and so is a dismissed one', () => {
    expect(claudeOf(pull({ reviews: [botReview('claude', 'APPROVED', '2026-09-25T08:00:00Z')] }))).toMatchObject({ state: 'approved', isOutdated: true });
    expect(claudeOf(pull({ reviews: [botReview('claude', 'DISMISSED', '2026-09-25T10:00:00Z')] }))).toMatchObject({ state: 'commented', isOutdated: true });
  });

  test('completed or skipped checks alone do not count, and humans named like bots are ignored', () => {
    expect(claudeOf(pull({ checks: [{ name: 'claude-review', status: 'COMPLETED', conclusion: 'SKIPPED' }] }))).toBeNull();
    const human = pull({ reviews: [{ state: 'APPROVED', at: '2026-09-25T10:00:00Z', author: { login: 'claude', avatarUrl: '', isBot: false } }] });
    expect(claudeOf(human)).toBeNull();
  });

  test('falls back to the app avatar while the first review runs', () => {
    expect(claudeOf(pull({ checks: [{ name: 'claude-review', status: 'IN_PROGRESS', conclusion: null }] }))?.avatarUrl).toContain('avatars.githubusercontent.com/in/');
  });
});

describe('isReviewBotCheck', () => {
  test('matches the review jobs only', () => {
    expect(['claude-review', 'Greptile Review'].every(isReviewBotCheck)).toBe(true);
    expect(['claude', 'Run Test Suite / CI', 'Vercel Preview Comments'].some(isReviewBotCheck)).toBe(false);
  });
});

describe('describeBotReview', () => {
  test('reads naturally', () => {
    const ago = () => '3m ago';
    expect(describeBotReview({ bot: 'claude', name: 'Claude', avatarUrl: '', state: 'approved', isOutdated: false, at: 'x' }, ago)).toBe('Claude approved · 3m ago');
    expect(describeBotReview({ bot: 'claude', name: 'Claude', avatarUrl: '', state: 'changes', isOutdated: true, at: 'x' }, ago)).toBe('Claude requested changes (before the latest push) · 3m ago');
    expect(describeBotReview({ bot: 'greptile', name: 'Greptile', avatarUrl: '', state: 'running', isOutdated: false, at: null }, ago)).toBe('Greptile is reviewing…');
  });
});
