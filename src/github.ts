import { invoke } from '@tauri-apps/api/core';
import { isReviewBotCheck } from './review-bots';
import { decisionFromVerdicts } from './approval';

/** A GitHub search behind a queue. */
export type SearchKind = 'review' | 'mine' | 'involved' | 'reviewed';
/** A tab: built from one or more searches (see QUEUE_SEARCHES in main.ts). */
export type QueueKind = Exclude<SearchKind, 'reviewed'> | 'turn' | 'approved' | 'merged';
export type MergeMethod = 'squash' | 'merge' | 'rebase';
export type MergeableState = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
export type CheckState = 'SUCCESS' | 'FAILURE' | 'ERROR' | 'PENDING' | 'EXPECTED';

export type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';

export interface Actor {
  login: string;
  avatarUrl: string;
  isBot: boolean;
}

/** Recent review-loop activity, used to work out whose turn it is. */
export interface PullActivity {
  lastCommitAt: string | null;
  /** Users by login; teams by `org/slug`, the handle GitHub mentions them with. */
  reviewRequests: { name: string; isTeam: boolean }[];
  reviews: { state: ReviewState; at: string; author: Actor }[];
  comments: { at: string; author: Actor }[];
  /** Check runs on the head commit that belong to review bots (see review-bots.ts). */
  checks: { name: string; status: string; conclusion: string | null }[];
}

/** A check run or commit status on the head commit that did not pass; `outcome` is GitHub's word for it, e.g. FAILURE or CANCELLED. */
export interface FailingCheck {
  name: string;
  outcome: string;
}

export interface PullRequest {
  id: string;
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  createdAt: string;
  updatedAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  headRefName: string;
  /** The head commit; it changes only when the code does, unlike `updatedAt`. */
  headRefOid: string;
  baseRefName: string;
  mergeable: MergeableState;
  mergeStateStatus: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  author: { login: string; avatarUrl: string } | null;
  repository: { nameWithOwner: string };
  checkState: CheckState | null;
  failingChecks: FailingCheck[];
  mergedAt: string | null;
  mergedBy: string | null;
  queueEntry: { position: number; state: string } | null;
  activity: PullActivity;
}

export interface MergeState {
  id: string;
  mergeable: MergeableState;
  mergeStateStatus: string;
}

interface RawAuthor {
  login: string;
  avatarUrl: string;
  __typename?: string;
}

/** A search node. Merged searches leave out the costly fields (decision, checks, activity, queue entry). */
interface RawPullRequest extends Omit<PullRequest, 'reviewDecision' | 'checkState' | 'failingChecks' | 'mergedAt' | 'mergedBy' | 'mergeable' | 'mergeStateStatus' | 'queueEntry' | 'activity'> {
  reviewDecision?: PullRequest['reviewDecision'];
  mergedAt?: string | null;
  mergedBy?: { login: string } | null;
  mergeQueueEntry?: { position: number; state: string } | null;
  commits?: { nodes: { commit: { committedDate?: string; statusCheckRollup: { state: CheckState; contexts?: { nodes: RawCheckContext[] } } | null } }[] };
  reviewRequests?: { nodes: { requestedReviewer: { __typename: string; login?: string; name?: string; combinedSlug?: string } | null }[] };
  reviews?: { nodes: { state: ReviewState; submittedAt: string | null; author: RawAuthor | null }[] };
  comments?: { nodes: { createdAt: string; author: RawAuthor | null }[] };
}

/** A CheckRun (name, status, conclusion) or a StatusContext (context, state). */
interface RawCheckContext {
  name?: string;
  status?: string;
  conclusion?: string | null;
  context?: string;
  state?: string;
}

const FAILED_OUTCOMES = new Set(['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);

function toFailingChecks(contexts: readonly RawCheckContext[]): FailingCheck[] {
  const seen = new Set<string>();
  return contexts.flatMap((context) => {
    const name = context.name ?? context.context;
    const outcome = context.conclusion ?? context.state;
    if (name == null || outcome == null || !FAILED_OUTCOMES.has(outcome) || seen.has(name)) return [];
    seen.add(name);
    return [{ name, outcome }];
  });
}

interface QueuePage {
  data?: { search: { issueCount?: number; nodes: (RawPullRequest | Record<string, never>)[] } };
  errors?: { message: string }[];
}

function isPullRequest(node: RawPullRequest | Record<string, never>): node is RawPullRequest {
  return typeof node.number === 'number';
}

function toActor(author: RawAuthor): Actor {
  return { login: author.login, avatarUrl: author.avatarUrl, isBot: author.__typename === 'Bot' || author.login.endsWith('[bot]') };
}

function toActivity({ commits, reviewRequests, reviews, comments }: RawPullRequest): PullActivity {
  return {
    lastCommitAt: commits?.nodes[0]?.commit.committedDate ?? null,
    reviewRequests: (reviewRequests?.nodes ?? []).flatMap(({ requestedReviewer: reviewer }) => {
      const name = reviewer?.login ?? reviewer?.combinedSlug ?? reviewer?.name;
      return name == null ? [] : [{ name, isTeam: reviewer?.__typename === 'Team' }];
    }),
    reviews: (reviews?.nodes ?? []).flatMap((review) => (review.author == null || review.submittedAt == null ? [] : [{ state: review.state, at: review.submittedAt, author: toActor(review.author) }])),
    comments: (comments?.nodes ?? []).flatMap((comment) => (comment.author == null ? [] : [{ at: comment.createdAt, author: toActor(comment.author) }])),
    checks: (commits?.nodes[0]?.commit.statusCheckRollup?.contexts?.nodes ?? []).flatMap((check) => (check.name == null || check.status == null || !isReviewBotCheck(check.name) ? [] : [{ name: check.name, status: check.status, conclusion: check.conclusion ?? null }])),
  };
}

function toPullRequest(raw: RawPullRequest): PullRequest {
  const { commits, mergeQueueEntry, mergedBy, reviewRequests: _requests, reviews: _reviews, comments: _comments, ...pull } = raw;
  const rollup = commits?.nodes[0]?.commit.statusCheckRollup;
  const activity = toActivity(raw);
  const reviewDecision = pull.reviewDecision ?? decisionFromVerdicts(pull.author?.login ?? null, activity.reviews);
  return { ...pull, reviewDecision, mergedAt: pull.mergedAt ?? null, mergedBy: mergedBy?.login ?? null, queueEntry: mergeQueueEntry ?? null, mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', checkState: rollup?.state ?? null, failingChecks: toFailingChecks(rollup?.contexts?.nodes ?? []), activity };
}

const MERGE_STATE_BATCH = 20;

interface MergeStateResponse {
  data?: { nodes: (MergeState | null)[] };
  errors?: { message: string }[];
}

export async function fetchMergeStates(ids: readonly string[], onBatch: (states: MergeState[]) => void): Promise<void> {
  const batches = Array.from({ length: Math.ceil(ids.length / MERGE_STATE_BATCH) }, (_, index) => ids.slice(index * MERGE_STATE_BATCH, (index + 1) * MERGE_STATE_BATCH));
  const results = await Promise.allSettled(
    batches.map(async (batch) => {
      const response: MergeStateResponse = JSON.parse(await invoke<string>('merge_states', { ids: batch }));
      if (response.data == null) throw new Error(response.errors?.map((error) => error.message).join('; ') ?? 'Empty response');
      onBatch(response.data.nodes.filter((node): node is MergeState => node?.id != null));
    }),
  );
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure != null) throw failure.reason instanceof Error ? failure.reason : new Error(String(failure.reason));
}

/** `expected` is how many PRs the search had last time, so its pages can be asked for together. */
/** A search's pull requests, and how many GitHub matched (it returns at most 1,000). */
export interface SearchResult {
  pulls: PullRequest[];
  total: number;
}

function parsePages(raw: string): SearchResult {
  const parsed: QueuePage | QueuePage[] = JSON.parse(raw);
  const pages = Array.isArray(parsed) ? parsed : [parsed];
  const failed = pages.find((page) => page.data == null);
  if (failed != null) throw new Error(failed.errors?.map((error) => error.message).join('; ') ?? 'Empty response');
  const seen = new Set<string>();
  const pulls = pages
    .flatMap((page) => page.data?.search.nodes ?? [])
    .filter(isPullRequest)
    .filter((node) => !seen.has(node.id) && seen.add(node.id) != null)
    .map(toPullRequest);
  return { pulls, total: pages[0]?.data?.search.issueCount ?? pulls.length };
}

/** `expected` is how many PRs the search had last time, so its pages can be asked for together. */
export async function fetchQueue(kind: SearchKind, expected = 0): Promise<SearchResult> {
  return parsePages(await invoke<string>('queue', { kind, expected }));
}

/** PRs merged since `since` in `orgs` (anything I was involved in when empty), by `author` when given (`@me` works). */
export async function fetchMerged(since: string, orgs: readonly string[], author: string | null, expected = 0): Promise<SearchResult> {
  return parsePages(await invoke<string>('merged', { since, orgs, author, expected }));
}

interface PullsResponse {
  data?: { nodes: (RawPullRequest | Record<string, never> | null)[] };
  errors?: { message: string }[];
}

/** Fresh copies of a few pull requests, without re-running their searches. */
export async function fetchPulls(ids: readonly string[]): Promise<PullRequest[]> {
  const response: PullsResponse = JSON.parse(await invoke<string>('pulls', { ids }));
  if (response.data == null) throw new Error(response.errors?.map((error) => error.message).join('; ') ?? 'Empty response');
  return response.data.nodes.filter((node): node is RawPullRequest => node != null && isPullRequest(node)).map(toPullRequest);
}

export function fetchBody(pull: PullRequest): Promise<string> {
  return invoke<string>('body', { repo: pull.repository.nameWithOwner, number: pull.number });
}

export function fetchDiff(pull: PullRequest): Promise<string> {
  return invoke<string>('diff', { repo: pull.repository.nameWithOwner, number: pull.number });
}

let viewerLogin: Promise<string | null> | null = null;

export function fetchViewerLogin(): Promise<string | null> {
  viewerLogin ??= invoke<string>('viewer').then((login) => (login === '' ? null : login)).catch(() => null);
  return viewerLogin;
}

let viewerTeams: Promise<Set<string> | null> | null = null;

/** My teams as lower-case `org/slug`; null when GitHub would not say (then the next call asks again). */
export function fetchViewerTeams(): Promise<Set<string> | null> {
  viewerTeams ??= invoke<string>('viewer_teams')
    .then((lines) => new Set(lines.split('\n').map((line) => line.trim().toLowerCase()).filter((line) => line !== '')))
    .catch(() => {
      viewerTeams = null;
      return null;
    });
  return viewerTeams;
}

export function commentOnPull(pull: PullRequest, body: string): Promise<string> {
  return invoke<string>('comment', { repo: pull.repository.nameWithOwner, number: pull.number, body });
}

export function approvePull(pull: PullRequest): Promise<string> {
  return invoke<string>('approve', { repo: pull.repository.nameWithOwner, number: pull.number });
}

interface MergeQueueResponse {
  data?: { repository: { mergeQueue: { url: string } | null } | null };
}

const mergeQueueCache = new Map<string, Promise<boolean>>();

export function usesMergeQueue(pull: PullRequest): Promise<boolean> {
  const key = `${pull.repository.nameWithOwner}#${pull.baseRefName}`;
  const cached = mergeQueueCache.get(key);
  if (cached != null) return cached;
  const pending = invoke<string>('merge_queue', { repo: pull.repository.nameWithOwner, base: pull.baseRefName })
    .then((raw) => (JSON.parse(raw) as MergeQueueResponse).data?.repository?.mergeQueue != null)
    .catch(() => false);
  mergeQueueCache.set(key, pending);
  return pending;
}

export async function mergePull(pull: PullRequest, method: MergeMethod): Promise<string> {
  const queued = await usesMergeQueue(pull);
  return invoke<string>('merge', { repo: pull.repository.nameWithOwner, number: pull.number, method, queued, nodeId: pull.id });
}

export function openInBrowser(url: string): Promise<void> {
  return invoke<void>('open_in_browser', { url });
}
