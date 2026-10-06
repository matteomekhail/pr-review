import { describe, expect, test } from 'bun:test';
import type { Actor, PullActivity, PullRequest, ReviewState } from './github';
import { computeTurn } from './turn';

const ME = 'me';

function person(login: string, isBot = false): Actor {
  return { login, avatarUrl: '', isBot };
}

function review(login: string, state: ReviewState, at: string, isBot = false): PullActivity['reviews'][number] {
  return { state, at, author: person(login, isBot) };
}

function comment(login: string, at: string, isBot = false): PullActivity['comments'][number] {
  return { at, author: person(login, isBot) };
}

function pull(author: string, activity: Partial<PullActivity>, overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    id: 'id',
    number: 1,
    title: 't',
    url: 'https://github.com/o/r/pull/1',
    isDraft: false,
    createdAt: '2026-09-20T00:00:00Z',
    updatedAt: '2026-09-26T10:00:00Z',
    additions: 10,
    deletions: 2,
    changedFiles: 1,
    headRefName: 'h',
    headRefOid: 'abc',
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'REVIEW_REQUIRED',
    author: person(author),
    repository: { nameWithOwner: 'o/r' },
    checkState: 'SUCCESS',
    failingChecks: [],
    mergedAt: null,
    mergedBy: null,
    queueEntry: null,
    activity: { lastCommitAt: '2026-09-25T09:00:00Z', reviewRequests: [], reviews: [], comments: [], checks: [], ...activity },
    ...overrides,
  };
}

describe('computeTurn on my pull request', () => {
  test('waits on requested reviewers who have not answered', () => {
    expect(computeTurn(pull(ME, { reviewRequests: [{ name: 'alice', isTeam: false }] }), ME)).toEqual({ whose: 'theirs', waitingOn: ['alice'] });
  });

  test('is my turn once a reviewer answers after my last push', () => {
    const turn = computeTurn(pull(ME, { reviews: [review('alice', 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z')] }), ME);
    expect(turn).toEqual({ whose: 'mine', reason: 'Changes requested by @alice' });
  });

  test('goes back to them after I push or reply', () => {
    const answered = pull(ME, { lastCommitAt: '2026-09-25T11:00:00Z', reviews: [review('alice', 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z')] });
    expect(computeTurn(answered, ME)).toEqual({ whose: 'theirs', waitingOn: ['alice'] });
    const replied = pull(ME, { reviews: [review('alice', 'COMMENTED', '2026-09-25T10:00:00Z')], comments: [comment(ME, '2026-09-25T12:00:00Z')] });
    expect(computeTurn(replied, ME)).toEqual({ whose: 'theirs', waitingOn: ['alice'] });
  });

  test('a plain comment from a teammate hands me the turn', () => {
    expect(computeTurn(pull(ME, { comments: [comment('bob', '2026-09-25T10:00:00Z')] }), ME)).toEqual({ whose: 'mine', reason: 'New comment from @bob' });
  });

  test('an approval with nothing pending is mine to merge', () => {
    const approved = pull(ME, { lastCommitAt: '2026-09-25T12:00:00Z', reviews: [review('alice', 'APPROVED', '2026-09-25T10:00:00Z')] }, { reviewDecision: 'APPROVED' });
    expect(computeTurn(approved, ME)).toEqual({ whose: 'mine', reason: 'Approved · ready to merge' });
  });

  test('bots never take a turn', () => {
    const botOnly = pull(ME, { reviews: [review('claude', 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z', true)], comments: [comment('vercel', '2026-09-25T11:00:00Z', true)] });
    expect(computeTurn(botOnly, ME)).toBeNull();
  });

  test('nobody has a turn without reviewers, and drafts are skipped', () => {
    expect(computeTurn(pull(ME, {}), ME)).toBeNull();
    expect(computeTurn(pull(ME, { reviews: [review('alice', 'COMMENTED', '2026-09-25T10:00:00Z')] }, { isDraft: true }), ME)).toBeNull();
  });

  test('team review requests count as waiting', () => {
    expect(computeTurn(pull(ME, { reviewRequests: [{ name: 'frontend', isTeam: true }] }), ME)).toEqual({ whose: 'theirs', waitingOn: ['frontend'] });
  });

  test('matches logins case-insensitively', () => {
    expect(computeTurn(pull('Me', { comments: [comment('ME', '2026-09-25T12:00:00Z')], reviews: [review('alice', 'COMMENTED', '2026-09-25T10:00:00Z')] }), 'me')).toEqual({ whose: 'theirs', waitingOn: ['alice'] });
  });
});

describe('computeTurn on someone else’s pull request', () => {
  test('a review request is my turn', () => {
    expect(computeTurn(pull('alice', { reviewRequests: [{ name: ME, isTeam: false }] }), ME)).toEqual({ whose: 'mine', reason: 'Review requested' });
    expect(computeTurn(pull('alice', {}), ME, true)).toEqual({ whose: 'mine', reason: 'Review requested' });
  });

  test('a re-request after my review says so', () => {
    const turn = computeTurn(pull('alice', { reviewRequests: [{ name: ME, isTeam: false }], reviews: [review(ME, 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z')] }), ME);
    expect(turn).toEqual({ whose: 'mine', reason: 'Re-review requested' });
  });

  test('is mine again when the author pushes after my review', () => {
    const turn = computeTurn(pull('alice', { lastCommitAt: '2026-09-25T11:00:00Z', reviews: [review(ME, 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z')] }), ME);
    expect(turn).toEqual({ whose: 'mine', reason: '@alice updated it since your review' });
  });

  test('waits on the author after my review', () => {
    const turn = computeTurn(pull('alice', { reviews: [review(ME, 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z')] }), ME);
    expect(turn).toEqual({ whose: 'theirs', waitingOn: ['alice'] });
  });

  test('nothing is owed once I approved, or if I never took part', () => {
    expect(computeTurn(pull('alice', { lastCommitAt: '2026-09-25T11:00:00Z', reviews: [review(ME, 'APPROVED', '2026-09-25T10:00:00Z')] }), ME)).toBeNull();
    expect(computeTurn(pull('alice', {}), ME)).toBeNull();
  });
});
