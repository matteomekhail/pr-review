import { describe, expect, test } from 'bun:test';
import type { PullActivity, PullRequest, ReviewState } from './github';
import { pullArbitrary } from './testing/arbitraries';
import fc from 'fast-check';
import { decisionFromVerdicts, verdictOf, withMyApproval } from './approval';

const review = (login: string, state: ReviewState, at: string, isBot = false): PullActivity['reviews'][number] => ({ state, at, author: { login, avatarUrl: '', isBot } });

describe('decisionFromVerdicts', () => {
  test('approved once a person approves and nobody asks for changes', () => {
    expect(decisionFromVerdicts('author', [review('alice', 'COMMENTED', '2026-09-25T09:00:00Z'), review('alice', 'APPROVED', '2026-09-25T10:00:00Z')])).toBe('APPROVED');
  });

  test('a standing change request wins, even after the same person comments', () => {
    const reviews = [review('alice', 'APPROVED', '2026-09-25T09:00:00Z'), review('bob', 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z'), review('bob', 'COMMENTED', '2026-09-25T11:00:00Z')];
    expect(decisionFromVerdicts('author', reviews)).toBe('CHANGES_REQUESTED');
  });

  test('a later approval or dismissal withdraws a change request', () => {
    expect(decisionFromVerdicts('author', [review('bob', 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z'), review('bob', 'APPROVED', '2026-09-25T11:00:00Z')])).toBe('APPROVED');
    expect(decisionFromVerdicts('author', [review('bob', 'APPROVED', '2026-09-25T10:00:00Z'), review('bob', 'DISMISSED', '2026-09-25T11:00:00Z')])).toBeNull();
  });

  test('bots and the author do not decide', () => {
    expect(decisionFromVerdicts('author', [review('claude', 'APPROVED', '2026-09-25T10:00:00Z', true), review('author', 'APPROVED', '2026-09-25T10:00:00Z')])).toBeNull();
    expect(decisionFromVerdicts('author', [review('claude', 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z', true), review('alice', 'APPROVED', '2026-09-25T11:00:00Z')])).toBe('APPROVED');
  });
});

describe('verdictOf', () => {
  test('my latest verdict, ignoring later comments and case', () => {
    expect(verdictOf([review('Me', 'APPROVED', '2026-09-25T10:00:00Z'), review('me', 'COMMENTED', '2026-09-25T11:00:00Z')], 'me')).toBe('APPROVED');
    expect(verdictOf([review('alice', 'APPROVED', '2026-09-25T10:00:00Z')], 'me')).toBeNull();
  });
});

describe('withMyApproval', () => {
  const base: PullRequest = { ...fc.sample(pullArbitrary, { numRuns: 1, seed: 2 })[0]!, author: { login: 'alice', avatarUrl: '' } };
  const asked = (reviewDecision: PullRequest['reviewDecision'], reviews: PullActivity['reviews'] = []): PullRequest => ({
    ...base,
    reviewDecision,
    activity: { ...base.activity, reviews, reviewRequests: [{ name: 'Me', isTeam: false }, { name: 'Acme/eng', isTeam: true }, { name: 'Acme/data', isTeam: true }, { name: 'bob', isTeam: false }] },
  });
  const at = '2026-09-26T10:00:00Z';

  test('answers my request and my teams, and reads as approved', () => {
    const approved = withMyApproval(asked(null), 'me', new Set(['acme/eng']), at);
    expect(approved.activity.reviewRequests.map((request) => request.name)).toEqual(['Acme/data', 'bob']);
    expect(approved.reviewDecision).toBe('APPROVED');
    expect(verdictOf(approved.activity.reviews, 'me')).toBe('APPROVED');
  });

  test('leaves required-review decisions and other people’s change requests to GitHub', () => {
    expect(withMyApproval(asked('REVIEW_REQUIRED'), 'me', null, at).reviewDecision).toBe('REVIEW_REQUIRED');
    expect(withMyApproval(asked('CHANGES_REQUESTED', [review('bob', 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z')]), 'me', null, at).reviewDecision).toBe('CHANGES_REQUESTED');
  });

  test('keeps team requests when my teams are unknown', () => {
    expect(withMyApproval(asked(null), 'me', null, at).activity.reviewRequests.map((request) => request.name)).toEqual(['Acme/eng', 'Acme/data', 'bob']);
  });
});
