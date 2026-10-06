import type { PullRequest } from './github';

/** Who a review request reaches me through: my login, or teams I am in (`org/slug`; empty when GitHub did not say which). */
export type ReviewAsk = { to: 'me' } | { to: 'team'; teams: string[] };

/**
 * Why I am asked to review someone else's pull request. A request by name wins over team ones. `myTeams` is null
 * when my teams are unknown; `isRequested` is GitHub's own `review-requested:@me` answer, which counts teams.
 */
export function reviewAsk(pull: PullRequest, viewer: string | null, myTeams: ReadonlySet<string> | null, isRequested: boolean): ReviewAsk | null {
  if (viewer == null) return null;
  const me = viewer.toLowerCase();
  if (pull.author?.login.toLowerCase() === me) return null;
  const requests = pull.activity.reviewRequests;
  if (requests.some((request) => !request.isTeam && request.name.toLowerCase() === me)) return { to: 'me' };
  const teams = requests.filter((request) => request.isTeam).map((request) => request.name);
  const mine = myTeams == null ? (isRequested ? teams : []) : teams.filter((team) => myTeams.has(team.toLowerCase()));
  if (mine.length > 0 || isRequested) return { to: 'team', teams: mine };
  return null;
}

export function describeAsk(ask: ReviewAsk): string {
  if (ask.to === 'me') return 'Review requested from you by name';
  if (ask.teams.length === 0) return 'Review requested from a team you are in';
  return `Review requested from ${ask.teams.map((team) => `@${team}`).join(', ')}`;
}
