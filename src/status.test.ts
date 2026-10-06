import { describe, expect, test } from 'bun:test';
import type { FailingCheck, PullRequest, ReviewState } from './github';
import { pullArbitrary } from './testing/arbitraries';
import fc from 'fast-check';
import { describeBlockers, describeFailingChecks, prStatus } from './status';

const base: PullRequest = { ...fc.sample(pullArbitrary, { numRuns: 1, seed: 1 })[0]!, queueEntry: null, isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'REVIEW_REQUIRED', checkState: 'SUCCESS', failingChecks: [] };
const withChecks = (failingChecks: FailingCheck[]): PullRequest => ({ ...base, failingChecks });
const review = (login: string, state: ReviewState, at: string) => ({ state, at, author: { login, avatarUrl: '', isBot: false } });

describe('describeFailingChecks', () => {
  test('puts real failures first and says how the others ended', () => {
    expect(describeFailingChecks(withChecks([{ name: 'Slack', outcome: 'CANCELLED' }, { name: 'e2e', outcome: 'TIMED_OUT' }, { name: 'lint', outcome: 'FAILURE' }]))).toBe('lint, e2e (timed out), Slack (cancelled)');
  });

  test('lists four, then counts the rest', () => {
    const checks = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name, outcome: 'FAILURE' }));
    expect(describeFailingChecks(withChecks(checks))).toBe('a, b, c, d, +2 more');
  });

  test('empty when nothing is listed', () => {
    expect(describeFailingChecks(withChecks([]))).toBe('');
  });
});

describe('red status', () => {
  test('the icon shows the most pressing blocker and the tooltip lists them all', () => {
    const pull: PullRequest = { ...base, mergeable: 'CONFLICTING', checkState: 'FAILURE', failingChecks: [{ name: 'lint', outcome: 'FAILURE' }], reviewDecision: 'CHANGES_REQUESTED', activity: { ...base.activity, reviews: [review('alice', 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z')] } };
    expect(prStatus(pull).blocker).toBe('conflicts');
    expect(describeBlockers(pull)).toEqual(['Merge conflicts', 'Changes requested by @alice', 'Checks failing: lint']);
  });

  test('changes stay requested through later comments, not through a later approval', () => {
    const reviews = [review('alice', 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z'), review('alice', 'COMMENTED', '2026-09-25T11:00:00Z'), review('bob', 'CHANGES_REQUESTED', '2026-09-25T10:00:00Z'), review('bob', 'APPROVED', '2026-09-25T12:00:00Z')];
    const pull: PullRequest = { ...base, reviewDecision: 'CHANGES_REQUESTED', activity: { ...base.activity, reviews } };
    expect(prStatus(pull).blocker).toBe('changes requested');
    expect(describeBlockers(pull)).toEqual(['Changes requested by @alice']);
  });

  test('approved but held by branch rules gets its own reason', () => {
    const pull: PullRequest = { ...base, reviewDecision: 'APPROVED', mergeStateStatus: 'BLOCKED' };
    expect(prStatus(pull).blocker).toBe('blocked');
    expect(describeBlockers(pull)).toEqual(['Approved, but blocked by branch rules']);
  });
});
