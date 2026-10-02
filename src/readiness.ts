import { invoke } from '@tauri-apps/api/core';
import type { PullRequest } from './github';

export interface ReadinessResult {
  score: number;
  evidence: number;
  risk: number;
  blocker: number;
  scope: number;
  tested: number;
  reason: string;
}

interface Author {
  login: string;
  __typename: 'User' | 'Bot' | 'Mannequin' | 'EnterpriseUserAccount' | 'Organization';
}

interface ReviewContext {
  body: string;
  files: { totalCount: number; nodes: { path: string; additions: number; deletions: number }[] };
  reviews: { nodes: { state: string; bodyText: string; author: Author | null }[] };
  comments: { nodes: { bodyText: string; author: Author | null }[] };
  reviewThreads: { nodes: { isResolved: boolean; isOutdated: boolean }[] };
}

interface ContextResponse {
  data?: { repository: { pullRequest: ReviewContext | null } | null };
  errors?: { message: string }[];
}

interface ScoreAnswer {
  type: 'score';
  score: number;
  confidence: number;
}

interface NoulAnswer {
  type: 'noul';
  noul: number;
}

interface SystemOneResponse {
  answers?: Record<string, ScoreAnswer | NoulAnswer>;
  error?: { message?: string };
}

const MAX_TEXT_CHARS = 1_500;
const MAX_BODY_CHARS = 4_000;
const MAX_ITEMS = 12;

const QUESTIONS = {
  merge_evidence: {
    type: 'score',
    instructions:
      'Across the `pull_request.body`, `reviews` and `comments`, how strong is the explicit evidence that this pull request has been reviewed, verified and is ready to merge? Count concrete signals such as approving reviews that engage with the change, statements that feedback was addressed, reported test or end-to-end verification results, passing checks, and sign-off language. Automated reviewers and bots count when they state a concrete verdict.',
    criteria: [
      'No evidence of review or verification',
      'Weak or generic signals only, such as a bare approval or an unverified claim',
      'Some concrete evidence: a substantive review or reported test results',
      'Strong evidence: a substantive approval plus reported verification, with feedback addressed',
      'Overwhelming evidence: multiple independent substantive approvals or verifications, all feedback resolved, explicit ready-to-merge sign-off',
    ],
  },
  outstanding_blockers: {
    type: 'noul',
    instructions:
      'Do the `reviews`, `comments` or `pull_request.body` contain an unresolved request for changes, an open question awaiting an answer, a reported failing test, or a statement that the pull request is not ready (for example work in progress, do not merge, or waiting on another change)? Ignore concerns that a later comment says were fixed or answered.',
    criteria: {
      true: 'At least one blocker or open concern is still outstanding',
      false: 'No outstanding blockers; any concerns raised were resolved',
    },
  },
  change_risk: {
    type: 'score',
    instructions:
      'Given the `files` list and the `pull_request.body`, how risky is merging this change? Consider what the changed paths touch (for example authentication, payments, data migrations, security boundaries, infrastructure, shared core libraries) versus low-risk areas (tests, documentation, styling, isolated leaf components), and how much behavior changes.',
    criteria: [
      'Trivial: documentation, comments, tests only, or cosmetic changes',
      'Low: small isolated change with clear, limited behavior impact',
      'Moderate: meaningful behavior change in a contained area',
      'High: touches shared core code, data handling, or user-facing flows broadly',
      'Critical: security, authentication, payments, migrations, or infrastructure with wide blast radius',
    ],
  },
  verified_testing: {
    type: 'score',
    instructions:
      'Across the `pull_request.body`, `reviews` and `comments`, how strong is the evidence that this change was actually exercised end to end, not just unit tested? Count concrete reports of running the real app, service or API and observing the result: end-to-end or integration test runs with results, manual QA steps with outcomes, screenshots, recordings, before/after measurements, or a reviewer or bot stating they ran it. A test plan that was never run, or only unit tests, is weak evidence.',
    criteria: [
      'No testing mentioned',
      'Only claims, an unrun test plan, or unit tests only',
      'Some real verification reported, such as an integration test run or manual check without detail',
      'Clear end-to-end verification with concrete results, commands or screenshots',
      'Thorough end-to-end proof: recorded runs or screenshots plus independent confirmation by a reviewer or bot',
    ],
  },
  scope_clarity: {
    type: 'score',
    instructions: 'How focused and clearly explained is this pull request, judging by the `pull_request.body` and whether the `files` match the stated purpose?',
    criteria: [
      'No description, or files unrelated to any stated purpose',
      'Vague description or scattered changes',
      'Reasonable description; files mostly match the purpose',
      'Clear description with rationale; files match the purpose',
      'Precise, well-scoped description with testing notes; every file clearly serves the purpose',
    ],
  },
} as const;

function clip(text: string, limit: number): string {
  const trimmed = text.replace(/\n{3,}/g, '\n\n').trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
}

function authorKind(author: Author | null): string {
  if (author == null) return 'unknown';
  return author.__typename === 'Bot' || author.login.endsWith('[bot]') ? 'automated' : 'human';
}

function buildState(pull: PullRequest, context: ReviewContext): Record<string, unknown> {
  const threads = context.reviewThreads.nodes;
  return {
    pull_request: {
      title: pull.title,
      body: clip(context.body, MAX_BODY_CHARS),
      is_draft: pull.isDraft,
      lines_added: pull.additions,
      lines_deleted: pull.deletions,
      files_changed: pull.changedFiles,
      checks: pull.checkState ?? 'none',
      github_review_decision: pull.reviewDecision ?? 'none',
      hours_since_update: Math.round((Date.now() - Date.parse(pull.updatedAt)) / 3_600_000),
    },
    files: context.files.nodes.slice(0, 60).map((file) => `${file.path} (+${file.additions} -${file.deletions})`),
    review_threads: { total: threads.length, unresolved: threads.filter((thread) => !thread.isResolved && !thread.isOutdated).length },
    reviews: context.reviews.nodes
      .filter((review) => review.bodyText.trim() !== '' || review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED')
      .slice(-MAX_ITEMS)
      .map((review) => ({ reviewer: authorKind(review.author), verdict: review.state, text: clip(review.bodyText, MAX_TEXT_CHARS) })),
    comments: context.comments.nodes
      .filter((comment) => comment.bodyText.trim() !== '')
      .slice(-MAX_ITEMS)
      .map((comment) => ({ author: authorKind(comment.author), text: clip(comment.bodyText, MAX_TEXT_CHARS) })),
  };
}

function scoreOf(answers: Record<string, ScoreAnswer | NoulAnswer>, key: string): number {
  const answer = answers[key];
  return answer?.type === 'score' ? answer.score / 4 : 0;
}

function noulOf(answers: Record<string, ScoreAnswer | NoulAnswer>, key: string): number {
  const answer = answers[key];
  return answer?.type === 'noul' ? answer.noul : 0;
}

function describe(result: Omit<ReadinessResult, 'reason'>): string {
  const parts = [
    result.evidence >= 0.75 ? 'strong sign-off' : result.evidence >= 0.5 ? 'reviewed' : 'little review evidence',
    result.blocker >= 0.5 ? 'open concerns' : null,
    result.tested >= 0.75 ? 'e2e tested' : null,
    result.risk >= 0.75 ? 'high-risk area' : result.risk <= 0.25 ? 'low risk' : null,
  ];
  return parts.filter((part) => part != null).join(' · ');
}

export function isReadinessAvailable(): Promise<boolean> {
  return invoke<boolean>('readiness_available').catch(() => false);
}

export async function assessReadiness(pull: PullRequest): Promise<ReadinessResult> {
  const contextResponse: ContextResponse = JSON.parse(await invoke<string>('review_context', { repo: pull.repository.nameWithOwner, number: pull.number }));
  const context = contextResponse.data?.repository?.pullRequest;
  if (context == null) throw new Error(contextResponse.errors?.[0]?.message ?? 'Pull request context unavailable');
  const request = JSON.stringify({ model: 'jev-latest', state: buildState(pull, context), questions: QUESTIONS });
  const response: SystemOneResponse = JSON.parse(await invoke<string>('readiness', { request }));
  const answers = response.answers;
  if (answers == null) throw new Error(response.error?.message ?? 'No answers returned');
  const evidence = scoreOf(answers, 'merge_evidence');
  const blocker = noulOf(answers, 'outstanding_blockers');
  const risk = scoreOf(answers, 'change_risk');
  const scope = scoreOf(answers, 'scope_clarity');
  const tested = scoreOf(answers, 'verified_testing');
  const score = 0.5 * evidence + 0.2 * scope + 0.3 * (1 - risk) - 0.6 * blocker;
  const result = { score, evidence, risk, blocker, scope, tested };
  return { ...result, reason: describe(result) };
}
