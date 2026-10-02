import { describe, expect, test } from 'bun:test';
import type { PullRequest } from './github';
import { isReady, matchesSmartFilter, sortPulls } from './smart';

const NOW = Date.parse('2026-09-26T12:00:00Z');

function pull(overrides: Partial<PullRequest>): PullRequest {
  return {
    id: overrides.id ?? 'id',
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
    baseRefName: 'main',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    author: null,
    repository: { nameWithOwner: 'o/r' },
    checkState: 'SUCCESS',
    queueEntry: null,
    ...overrides,
  };
}

describe('isReady', () => {
  test('green, clean and not rejected is ready', () => {
    expect(isReady(pull({}))).toBe(true);
  });

  test('failing checks, conflicts, drafts, blocked rules and change requests are not ready', () => {
    expect(isReady(pull({ checkState: 'FAILURE' }))).toBe(false);
    expect(isReady(pull({ mergeable: 'CONFLICTING' }))).toBe(false);
    expect(isReady(pull({ isDraft: true }))).toBe(false);
    expect(isReady(pull({ mergeStateStatus: 'BLOCKED' }))).toBe(false);
    expect(isReady(pull({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe(false);
  });
});

describe('matchesSmartFilter', () => {
  test('small uses total changed lines and recent uses the last update', () => {
    expect(matchesSmartFilter(pull({ additions: 100, deletions: 50 }), 'small', NOW)).toBe(true);
    expect(matchesSmartFilter(pull({ additions: 100, deletions: 51 }), 'small', NOW)).toBe(false);
    expect(matchesSmartFilter(pull({ updatedAt: '2026-09-24T13:00:00Z' }), 'recent', NOW)).toBe(true);
    expect(matchesSmartFilter(pull({ updatedAt: '2026-09-24T11:00:00Z' }), 'recent', NOW)).toBe(false);
  });
});

describe('sortPulls smart', () => {
  test('ready small recent first, blocked last', () => {
    const readySmall = pull({ id: 'ready-small' });
    const readyLarge = pull({ id: 'ready-large', additions: 4_000 });
    const failing = pull({ id: 'failing', checkState: 'FAILURE' });
    const conflicted = pull({ id: 'conflicted', mergeable: 'CONFLICTING' });
    const order = sortPulls([conflicted, failing, readyLarge, readySmall], 'smart', NOW).map((item) => item.id);
    expect(order).toEqual(['ready-small', 'ready-large', 'failing', 'conflicted']);
  });
});

describe('sortPulls smart with AI scores', () => {
  test('AI readiness reorders ready pulls, hard blockers still sink', () => {
    const cleanButRisky = pull({ id: 'risky', additions: 20 });
    const reviewedLarge = pull({ id: 'reviewed', additions: 2_000 });
    const failing = pull({ id: 'failing', checkState: 'FAILURE' });
    const scores: Record<string, number> = { risky: 0.2, reviewed: 0.8, failing: 0.95 };
    const order = sortPulls([cleanButRisky, failing, reviewedLarge], 'smart', NOW, (item) => scores[item.id]).map((item) => item.id);
    expect(order).toEqual(['reviewed', 'risky', 'failing']);
  });

  test('falls back to rule-based score for pulls without an AI score', () => {
    const small = pull({ id: 'small' });
    const large = pull({ id: 'large', additions: 4_000 });
    expect(sortPulls([large, small], 'smart', NOW, () => undefined).map((item) => item.id)).toEqual(['small', 'large']);
  });
});
