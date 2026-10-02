import { invoke } from '@tauri-apps/api/core';
import type { PullRequest } from './github';

interface NoulAnswer {
  type: 'noul';
  noul: number;
}

interface SystemOneResponse {
  answers?: Record<string, NoulAnswer>;
  error?: { message?: string };
}

const BATCH_SIZE = 40;
const MATCH_THRESHOLD = 0.5;
const MAX_TITLE_CHARS = 140;
const CACHE_LIMIT = 30;

const cache = new Map<string, Map<string, number>>();

function describe(pull: PullRequest): string {
  const title = pull.title.length > MAX_TITLE_CHARS ? `${pull.title.slice(0, MAX_TITLE_CHARS)}…` : pull.title;
  const branch = pull.headRefName.replace(/^[^/]+\//, '').replace(/^\d+-/, '').replace(/[-_/]+/g, ' ');
  return `${title} [branch: ${branch}; repo: ${pull.repository.nameWithOwner}]`;
}

function question(query: string, text: string): unknown {
  return {
    type: 'noul',
    instructions: { search: query, pull_request: text, question: 'Is this pull request relevant to what someone searching for `search` wants to find? Interpret `search` as a topic, area or kind of change (for example "frontend" covers UI, React components, CSS, pages and client code; "backend" covers APIs, workers, databases and servers). Judge from the title, branch and repository.' },
    criteria: { true: 'The pull request is clearly about the searched topic or area', false: 'The pull request is unrelated or only tangentially related' },
  };
}

export async function semanticMatches(query: string, pulls: readonly PullRequest[], signal: AbortSignal): Promise<Map<string, number>> {
  const key = `${query.toLowerCase()}::${pulls.map((pull) => `${pull.id}:${pull.updatedAt}`).join(',')}`;
  const cached = cache.get(key);
  if (cached != null) return cached;
  const scores = new Map<string, number>();
  const batches = Array.from({ length: Math.ceil(pulls.length / BATCH_SIZE) }, (_, index) => pulls.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE));
  await Promise.all(
    batches.map(async (batch) => {
      if (signal.aborted) return;
      const request = JSON.stringify({ model: 'jev-latest', state: { search: query }, questions: Object.fromEntries(batch.map((pull, index) => [`p${index}`, question(query, describe(pull))])) });
      const response: SystemOneResponse = JSON.parse(await invoke<string>('readiness', { request }));
      if (response.answers == null) throw new Error(response.error?.message ?? 'Jev returned no answers');
      batch.forEach((pull, index) => {
        const answer = response.answers?.[`p${index}`];
        if (answer?.type === 'noul') scores.set(pull.id, answer.noul);
      });
    }),
  );
  if (signal.aborted) return scores;
  cache.set(key, scores);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value ?? '');
  return scores;
}

export function isSemanticMatch(score: number | undefined): boolean {
  return score != null && score >= MATCH_THRESHOLD;
}
