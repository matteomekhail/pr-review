import { DEMO_CONFLICTS, DEMO_PULLS, DEMO_TEAMS, DEMO_VIEWER, demoBody, demoConversation, demoDiff } from '../demo';
import { generateBody, generateDiff, generatePulls, type FixturePull } from '../fixtures';

const COUNT = Number(new URLSearchParams(location.search).get('pulls') ?? 120);
const LATENCY_MS = Number(new URLSearchParams(location.search).get('latency') ?? 0);
const IS_DEMO = new URLSearchParams(location.search).has('demo');
const pulls = IS_DEMO ? DEMO_PULLS : generatePulls(COUNT);
const byId = new Map(pulls.map((pull) => [pull.id, pull]));
const byNumber = new Map(pulls.map((pull) => [pull.number, pull]));
const calls: Record<string, number> = {};

Object.assign(window, { __shimCalls: calls, __shimPulls: pulls });

function mergeStateOf(pull: FixturePull): { id: string; mergeable: string; mergeStateStatus: string } {
  const conflicted = IS_DEMO ? DEMO_CONFLICTS.has(pull.id) : pull.number % 13 === 0;
  const failing = pull.commits.nodes[0]?.commit.statusCheckRollup?.state === 'FAILURE';
  const status = conflicted ? 'DIRTY' : pull.isDraft ? 'DRAFT' : failing ? 'UNSTABLE' : pull.reviewDecision === 'APPROVED' ? 'CLEAN' : 'BLOCKED';
  return { id: pull.id, mergeable: conflicted ? 'CONFLICTING' : 'MERGEABLE', mergeStateStatus: status };
}

/** In the demo, the review searches only return what GitHub would; every other queue shows all fixtures. */
function queueFor(kind: string): FixturePull[] {
  if (!IS_DEMO) return pulls;
  if (kind === 'review') return pulls.filter((pull) => pull.reviewRequests?.nodes.some(({ requestedReviewer: reviewer }) => reviewer?.login === DEMO_VIEWER || DEMO_TEAMS.includes(reviewer?.combinedSlug ?? '')));
  if (kind === 'reviewed') return pulls.filter((pull) => pull.reviews?.nodes.some((review) => review.author.login === DEMO_VIEWER));
  return pulls;
}

const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
  queue: (args) => JSON.stringify([{ data: { search: { nodes: queueFor(args.kind as string) } } }]),
  merge_states: (args) => JSON.stringify({ data: { nodes: (args.ids as string[]).map((id) => byId.get(id)).filter((pull) => pull != null).map((pull) => mergeStateOf(pull as FixturePull)) } }),
  body: (args) => { const pull = byNumber.get(args.number as number) ?? pulls[0]!; return IS_DEMO ? demoBody(pull) : generateBody(pull); },
  diff: (args) => { const pull = byNumber.get(args.number as number) ?? pulls[0]!; return (IS_DEMO ? demoDiff(pull) : null) ?? generateDiff(pull); },
  conversation: (args) => IS_DEMO ? JSON.stringify(demoConversation(byNumber.get(args.number as number) ?? pulls[0]!)) : JSON.stringify({ data: { repository: { pullRequest: { comments: { totalCount: 2, nodes: [
    { id: 'c1', bodyHTML: `<p>Long review note.</p>${'<p>Line of detail that goes on for a while to make this comment tall.</p>'.repeat(30)}`, createdAt: '2026-09-26T10:00:00Z', url: 'https://github.com/o/web/pull/1#c1', author: { login: 'reviewer', avatarUrl: '', __typename: 'User' } },
    { id: 'c3', bodyHTML: '<h3>🚀 Web Preview Deployed</h3><p><a href="https://pr-47520.preview.acme.dev">https://pr-47520.preview.acme.dev</a></p>', createdAt: '2026-09-26T11:30:00Z', url: 'https://github.com/o/web/pull/1#c3', author: { login: 'github-actions', avatarUrl: '', __typename: 'Bot' } },
    { id: 'c2', bodyHTML: '<p>Tracking issue: <a href="https://github.com/acme/web/issues/4801">acme/web#4801</a></p>', createdAt: '2026-09-26T11:00:00Z', url: 'https://github.com/o/web/pull/1#c2', author: { login: 'ci-helper', avatarUrl: '', __typename: 'Bot' } },
  ] }, reviews: { totalCount: 0, nodes: [] } } } } }),
  viewer: () => (IS_DEMO ? DEMO_VIEWER : 'someone-else'),
  viewer_teams: () => (IS_DEMO ? DEMO_TEAMS.join('\n') : ''),
  comment: (args) => `https://github.com/${String(args.repo)}/pull/${String(args.number)}#issuecomment-1`,
  merge_queue: () => JSON.stringify({ data: { repository: { mergeQueue: null } } }),
  readiness_available: () => false,
  review_context: () => { throw new Error('offline harness'); },
  readiness: () => { throw new Error('offline harness'); },
  // The demo remembers approvals the way GitHub does: my review is added and the requests it answers are dropped.
  approve: (args) => {
    const pull = pulls.find((candidate) => candidate.number === Number(args.number) && candidate.repository.nameWithOwner === String(args.repo));
    if (pull == null || !IS_DEMO) return 'ok';
    pull.reviews = { nodes: [...(pull.reviews?.nodes ?? []), { state: 'APPROVED', submittedAt: new Date().toISOString(), author: { login: DEMO_VIEWER, avatarUrl: '', __typename: 'User' } }] };
    pull.reviewRequests = { nodes: (pull.reviewRequests?.nodes ?? []).filter(({ requestedReviewer: reviewer }) => reviewer?.login !== DEMO_VIEWER && !DEMO_TEAMS.includes(reviewer?.combinedSlug ?? '')) };
    return 'ok';
  },
  // Every fixture, merged a few hours apart by one of four people, so the Merged tab has periods and authors to filter.
  merged: (args) => {
    const authors = ['sam-rivera', 'jordan-lee', 'alex-kim', 'priya-n'];
    const viewerLogin = IS_DEMO ? DEMO_VIEWER : 'someone-else';
    const nodes = pulls
      .map((pull, index) => ({ ...pull, id: `${pull.id}-merged`, number: pull.number - 1000, mergedAt: new Date(Date.now() - (index * 5 + 1) * 3_600_000).toISOString(), mergedBy: { login: 'sam-rivera' }, author: { login: authors[index % authors.length] as string, avatarUrl: '' }, commits: undefined, reviewRequests: undefined, reviews: undefined, comments: undefined, reviewDecision: undefined, mergeQueueEntry: undefined }))
      .filter((pull) => Date.parse(pull.mergedAt) >= Date.parse(String(args.since)))
      .filter((pull) => args.author == null || pull.author.login === (args.author === '@me' ? viewerLogin : args.author));
    return JSON.stringify([{ data: { search: { issueCount: nodes.length, nodes } } }]);
  },
  pulls: (args) => JSON.stringify({ data: { nodes: (args.ids as string[]).map((id) => byId.get(id) ?? null) } }),
  merge: async (args) => {
    await new Promise((resolve) => setTimeout(resolve, Number(new URLSearchParams(location.search).get('mergeMs') ?? 0)));
    const failing = (new URLSearchParams(location.search).get('failMerge') ?? '').split(',').filter(Boolean).map(Number);
    if (failing.includes(Number(args.number))) throw new Error('Pull request is not mergeable: required status check "ci" is failing');
    return 'ok';
  },
  open_in_browser: (args) => { (window as unknown as { __opened: string[] }).__opened = [...((window as unknown as { __opened?: string[] }).__opened ?? []), String(args.url)]; return undefined; },
};

export async function invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
  calls[command] = (calls[command] ?? 0) + 1;
  const handler = handlers[command];
  if (handler == null) throw new Error(`harness: unhandled command ${command}`);
  if (LATENCY_MS > 0) await new Promise((resolve) => setTimeout(resolve, LATENCY_MS));
  return (await handler(args)) as T;
}

export class Resource {
  constructor(readonly rid: number) {}
  async close(): Promise<void> {}
}

export class Channel<T> {
  onmessage: (message: T) => void = () => undefined;
}
