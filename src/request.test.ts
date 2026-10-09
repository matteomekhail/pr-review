import { describe, expect, test } from 'bun:test';
import type { PullActivity, PullRequest } from './github';
import { describeAsk, inAskScope, isStaleRequest, reviewAsk } from './request';

const ME = 'me';
const ENG = 'Acme/engineering';
const DATA = 'Acme/data';

function pull(author: string, reviewRequests: PullActivity['reviewRequests']): PullRequest {
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
    author: { login: author, avatarUrl: '' },
    repository: { nameWithOwner: 'o/r' },
    checkState: 'SUCCESS',
    failingChecks: [],
    mergedAt: null,
    mergedBy: null,
    closedAt: null,
    queueEntry: null,
    activity: { lastCommitAt: null, reviewRequests, reviews: [], comments: [], checks: [] },
  };
}

const user = (name: string) => ({ name, isTeam: false });
const team = (name: string) => ({ name, isTeam: true });
const myTeams = new Set([ENG.toLowerCase()]);

describe('reviewAsk', () => {
  test('a request by name is for me, even when my team is asked too', () => {
    expect(reviewAsk(pull('alice', [team(ENG), user('Me')]), ME, myTeams, true)).toEqual({ to: 'me' });
  });

  test('a team request names only the teams I am in', () => {
    expect(reviewAsk(pull('alice', [team(DATA), team(ENG), user('bob')]), ME, myTeams, true)).toEqual({ to: 'team', teams: [ENG] });
  });

  test('nothing when neither I nor my teams are asked', () => {
    expect(reviewAsk(pull('alice', [team(DATA), user('bob')]), ME, myTeams, false)).toBeNull();
  });

  test('without my teams, trusts GitHub and lists every requested team', () => {
    expect(reviewAsk(pull('alice', [team(DATA), team(ENG)]), ME, null, true)).toEqual({ to: 'team', teams: [DATA, ENG] });
    expect(reviewAsk(pull('alice', [team(DATA), team(ENG)]), ME, null, false)).toBeNull();
  });

  test('requested through a team GitHub did not list', () => {
    expect(reviewAsk(pull('alice', [user('bob')]), ME, myTeams, true)).toEqual({ to: 'team', teams: [] });
  });

  test('never on my own pull request', () => {
    expect(reviewAsk(pull(ME, [team(ENG)]), ME, myTeams, true)).toBeNull();
  });
});

describe('labels', () => {
  test('describe who was asked', () => {
    expect(describeAsk({ to: 'me' })).toBe('Review requested from you by name');
    expect(describeAsk({ to: 'team', teams: [ENG, DATA] })).toBe('Review requested from @Acme/engineering, @Acme/data');
    expect(describeAsk({ to: 'team', teams: [] })).toBe('Review requested from a team you are in');
  });
});

describe('inAskScope', () => {
  test('me keeps everything but team-only requests; team keeps only those', () => {
    const team = { to: 'team' as const, teams: [ENG] };
    expect([null, { to: 'me' as const }, team].map((ask) => inAskScope(ask, 'me'))).toEqual([true, true, false]);
    expect([null, { to: 'me' as const }, team].map((ask) => inAskScope(ask, 'team'))).toEqual([false, false, true]);
    expect([null, { to: 'me' as const }, team].map((ask) => inAskScope(ask, 'all'))).toEqual([true, true, true]);
  });
});

describe('isStaleRequest', () => {
  const reviewed = (requests: PullActivity['reviewRequests']): PullRequest => {
    const base = pull('alice', requests);
    return { ...base, activity: { ...base.activity, reviews: [{ state: 'APPROVED', at: '2026-09-25T10:00:00Z', author: { login: ME, avatarUrl: '', isBot: false } }] } };
  };

  test('stale once I reviewed and nobody asks me or my teams any more', () => {
    expect(isStaleRequest(reviewed([team(DATA)]), ME, myTeams)).toBe(true);
  });

  test('still live when I am asked again, or have not reviewed, or my teams are unknown', () => {
    expect(isStaleRequest(reviewed([user(ME)]), ME, myTeams)).toBe(false);
    expect(isStaleRequest(reviewed([team(ENG)]), ME, myTeams)).toBe(false);
    expect(isStaleRequest(pull('alice', []), ME, myTeams)).toBe(false);
    expect(isStaleRequest(reviewed([]), ME, null)).toBe(false);
  });
});
