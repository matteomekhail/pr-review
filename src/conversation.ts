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
        reviews: { totalCount: number; nodes: { id: string; state: string; bodyHTML: string; submittedAt: string | null; url: string; author: Author | null; comments: { totalCount: number } }[] };
      } | null;
    } | null;
  };
  errors?: { message: string }[];
}

const cache = new Map<string, Promise<ConversationItem[]>>();
const CACHE_LIMIT = 24;

function isBotAuthor(author: Author | null): boolean {
  return author != null && (author.__typename === 'Bot' || author.login.endsWith('[bot]'));
}

async function fetchConversation(pull: PullRequest): Promise<ConversationItem[]> {
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
  }));
  const reviews = pr.reviews.nodes
    .filter((node) => node.bodyHTML.trim() !== '' || node.state === 'APPROVED' || node.state === 'CHANGES_REQUESTED' || node.comments.totalCount > 0)
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
    }));
  return [...comments, ...reviews].sort((left, right) => Date.parse(left.at) - Date.parse(right.at));
}

export function invalidateConversation(pull: PullRequest): void {
  [...cache.keys()].filter((key) => key.startsWith(`${pull.id}:`)).forEach((key) => cache.delete(key));
}

export function loadConversation(pull: PullRequest): Promise<ConversationItem[]> {
  const key = `${pull.id}:${pull.updatedAt}`;
  const cached = cache.get(key);
  if (cached != null) return cached;
  const pending = fetchConversation(pull);
  pending.catch(() => cache.delete(key));
  cache.set(key, pending);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value ?? '');
  return pending;
}
