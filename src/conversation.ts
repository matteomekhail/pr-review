import { invoke } from '@tauri-apps/api/core';
import type { PullRequest } from './github';

export type AuthorKind = 'User' | 'Bot' | 'Mannequin' | 'Organization' | 'EnterpriseUserAccount';

export interface ConversationItem {
  id: string;
  kind: 'comment' | 'review';
  author: string;
  avatarUrl: string | null;
  isBot: boolean;
  html: string;
  at: string;
  url: string;
  reviewState: string | null;
  inlineCount: number;
  /** Code threads this review started; replies sit inside them rather than in reviews of their own. */
  threads: ReviewThread[];
}

export interface ThreadComment {
  id: string;
  /** The REST id, which replies are posted against. */
  databaseId: number;
  author: string;
  avatarUrl: string | null;
  isBot: boolean;
  html: string;
  at: string;
  url: string;
}

/** A conversation on code: where it sits in the diff now (`line` is null once the code it was on has changed). */
export interface ReviewThread {
  id: string;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  side: 'additions' | 'deletions';
  isResolved: boolean;
  isOutdated: boolean;
  diffHunk: string;
  comments: ThreadComment[];
}

export interface Conversation {
  items: ConversationItem[];
  threads: ReviewThread[];
}

interface RawReview {
  id: string;
  state: string;
  bodyHTML: string;
  submittedAt: string | null;
  url: string;
  author: Author | null;
  comments: { totalCount: number };
}

interface RawThreadComment {
  id: string;
  databaseId: number;
  bodyHTML: string;
  createdAt: string;
  url: string;
  diffHunk: string;
  author: Author | null;
  pullRequestReview: { id: string } | null;
}

interface RawThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  originalLine: number | null;
  diffSide: 'LEFT' | 'RIGHT';
  comments: { nodes: RawThreadComment[] };
}

interface Author {
  login: string;
  avatarUrl: string;
  __typename: AuthorKind;
}

interface Response {
  data?: {
    repository: {
      pullRequest: {
        comments: { totalCount: number; nodes: { id: string; bodyHTML: string; createdAt: string; url: string; author: Author | null }[] };
        reviews: { totalCount: number; nodes: RawReview[] };
        reviewThreads?: { nodes: RawThread[] };
      } | null;
    } | null;
  };
  errors?: { message: string }[];
}

const cache = new Map<string, Promise<Conversation>>();
const CACHE_LIMIT = 24;

function isBotAuthor(author: Author | null): boolean {
  return author != null && (author.__typename === 'Bot' || author.login.endsWith('[bot]'));
}

function toThread(raw: RawThread): ReviewThread {
  return {
    id: raw.id,
    path: raw.path,
    line: raw.line,
    startLine: raw.startLine,
    originalLine: raw.originalLine,
    side: raw.diffSide === 'LEFT' ? 'deletions' : 'additions',
    isResolved: raw.isResolved,
    isOutdated: raw.isOutdated,
    diffHunk: raw.comments.nodes[0]?.diffHunk ?? '',
    comments: raw.comments.nodes.map((node) => ({ id: node.id, databaseId: node.databaseId, author: node.author?.login ?? 'ghost', avatarUrl: node.author?.avatarUrl ?? null, isBot: isBotAuthor(node.author), html: node.bodyHTML, at: node.createdAt, url: node.url })),
  };
}

async function fetchConversation(pull: PullRequest): Promise<Conversation> {
  const response: Response = JSON.parse(await invoke<string>('conversation', { repo: pull.repository.nameWithOwner, number: pull.number }));
  const pr = response.data?.repository?.pullRequest;
  if (pr == null) throw new Error(response.errors?.[0]?.message ?? 'Conversation unavailable');
  const comments = pr.comments.nodes.map((node): ConversationItem => ({
    id: node.id,
    kind: 'comment',
    author: node.author?.login ?? 'ghost',
    avatarUrl: node.author?.avatarUrl ?? null,
    isBot: isBotAuthor(node.author),
    html: node.bodyHTML,
    at: node.createdAt,
    url: node.url,
    reviewState: null,
    inlineCount: 0,
    threads: [],
  }));
  const rawThreads = (pr.reviewThreads?.nodes ?? []).filter((thread) => thread.comments.nodes.length > 0);
  const threads = rawThreads.map(toThread);
  const startedBy = new Map<string, ReviewThread[]>();
  rawThreads.forEach((raw, index) => {
    const review = raw.comments.nodes[0]?.pullRequestReview?.id;
    const thread = threads[index];
    if (review != null && thread != null) startedBy.set(review, [...(startedBy.get(review) ?? []), thread]);
  });
  // A reply on GitHub is a review of its own with no body; it is shown inside its thread instead.
  const isReplyOnly = (node: RawReview): boolean => node.state === 'COMMENTED' && node.bodyHTML.trim() === '' && !startedBy.has(node.id);
  const reviews = pr.reviews.nodes
    .filter((node) => (node.bodyHTML.trim() !== '' || node.state === 'APPROVED' || node.state === 'CHANGES_REQUESTED' || node.comments.totalCount > 0) && !isReplyOnly(node))
    .map((node): ConversationItem => ({
      id: node.id,
      kind: 'review',
      author: node.author?.login ?? 'ghost',
      avatarUrl: node.author?.avatarUrl ?? null,
      isBot: isBotAuthor(node.author),
      html: node.bodyHTML,
      at: node.submittedAt ?? '',
      url: node.url,
      reviewState: node.state,
      inlineCount: node.comments.totalCount,
      threads: startedBy.get(node.id) ?? [],
    }));
  return { items: [...comments, ...reviews].sort((left, right) => Date.parse(left.at) - Date.parse(right.at)), threads };
}

export function invalidateConversation(pull: PullRequest): void {
  [...cache.keys()].filter((key) => key.startsWith(`${pull.id}:`)).forEach((key) => cache.delete(key));
}

function load(pull: PullRequest): Promise<Conversation> {
  const key = `${pull.id}:${pull.updatedAt}`;
  const cached = cache.get(key);
  if (cached != null) return cached;
  const pending = fetchConversation(pull);
  pending.catch(() => cache.delete(key));
  cache.set(key, pending);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value ?? '');
  return pending;
}

export function loadConversation(pull: PullRequest): Promise<ConversationItem[]> {
  return load(pull).then((conversation) => conversation.items);
}

/** The code threads, from the same request as the conversation. */
export function loadThreads(pull: PullRequest): Promise<ReviewThread[]> {
  return load(pull).then((conversation) => conversation.threads);
}
