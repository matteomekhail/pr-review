import { invoke } from '@tauri-apps/api/core';
import type { PullRequest } from './github';

export interface PullGroup {
  id: string;
  label: string;
  pullIds: string[];
}

interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
}

interface SystemOneResponse {
  answers?: Record<string, ChoiceAnswer>;
  error?: { message?: string };
}

const CHUNK_SIZE = 8;
const PAIR_THRESHOLD = 0.3;
const MERGE_THRESHOLD = 0.5;
const MAX_PULLS = 200;
const NONE = 'none';

const PAIR_QUESTION = 'Which other pull request in `pull_requests` belongs to the same body of work as `target`: the same initiative, the same kind of change applied to a different area, or a sibling part of one larger effort? Pick the single closest one, or none if nothing is clearly part of the same effort.';
const GROUP_QUESTION = 'Which other group in `groups` is part of the same broader effort as `target`, for example the same kind of refactor applied to different areas, or sibling packages extracted from the same place? Pick none if no group clearly belongs with it.';

function branchWords(branch: string): string {
  return branch.replace(/^[^/]+\//, '').replace(/^\d+-/, '').replace(/[-_/]+/g, ' ').trim();
}

const MAX_TITLE_CHARS = 110;

function describe(pull: PullRequest): string {
  const title = pull.title.length > MAX_TITLE_CHARS ? `${pull.title.slice(0, MAX_TITLE_CHARS)}…` : pull.title;
  const words = branchWords(pull.headRefName).split(' ').slice(0, 6).join(' ');
  return words === '' ? title : `${title} [${words}]`;
}

function mostCommon(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  values.forEach((value) => counts.set(value, (counts.get(value) ?? 0) + 1));
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0];
}

async function askJev(state: unknown, questions: Record<string, unknown>): Promise<Record<string, ChoiceAnswer>> {
  const raw = await invoke<string>('readiness', { request: JSON.stringify({ model: 'jev-latest', state, questions }) });
  const response: SystemOneResponse = JSON.parse(raw);
  if (response.answers == null) throw new Error(response.error?.message ?? 'Jev returned no answers');
  return response.answers;
}

function choiceQuestion(target: string, question: string, keys: string[], self: string): unknown {
  const criteria: Record<string, string | null> = { [NONE]: 'Nothing else clearly belongs to the same effort' };
  keys.forEach((key) => {
    if (key !== self) criteria[key] = null;
  });
  return { type: 'choice', instructions: { target, question }, criteria };
}

class DisjointSet {
  private readonly parent = new Map<string, string>();

  add(key: string): void {
    if (!this.parent.has(key)) this.parent.set(key, key);
  }

  find(key: string): string {
    const parent = this.parent.get(key) ?? key;
    if (parent === key) return key;
    const root = this.find(parent);
    this.parent.set(key, root);
    return root;
  }

  union(left: string, right: string): void {
    this.parent.set(this.find(left), this.find(right));
  }

  groups(): string[][] {
    const buckets = new Map<string, string[]>();
    for (const key of this.parent.keys()) buckets.set(this.find(key), [...(buckets.get(this.find(key)) ?? []), key]);
    return [...buckets.values()];
  }
}

const STOP_WORDS = new Set(['emit', 'add', 'use', 'make', 'move', 'render', 'extract', 'converge', 'duplicated', 'components', 'component', 'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'across', 'with', 'from', 'into', 'onto', 'through', 'between', 'by', 'at', 'as', 'its', 'all', 'one', 'shared', 'share', 'feat', 'fix', 'refactor', 'perf', 'chore', 'test', 'web', 'frontend']);

function labelFor(pulls: PullRequest[]): string {
  const prefixes = pulls.map((pull) => pull.title.match(/^(\w+)(\(([^)]+)\))?:/));
  const types = new Map<string, number>();
  const scopes = new Map<string, number>();
  prefixes.forEach((match) => {
    if (match?.[1] != null) types.set(match[1], (types.get(match[1]) ?? 0) + 1);
    if (match?.[3] != null) scopes.set(match[3], (scopes.get(match[3]) ?? 0) + 1);
  });
  const words = new Map<string, number>();
  pulls.forEach((pull) => {
    const seen = new Set(
      pull.title
        .replace(/^[^:]+:\s*/, '')
        .toLowerCase()
        .split(/[^a-z0-9-]+/)
        .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
    );
    seen.forEach((word) => words.set(word, (words.get(word) ?? 0) + 1));
  });
  const top = (map: Map<string, number>, minimum: number): string | undefined => [...map.entries()].filter(([, count]) => count >= minimum).sort((left, right) => right[1] - left[1])[0]?.[0];
  const type = top(types, Math.ceil(pulls.length / 2));
  const scope = top(scopes, Math.max(2, Math.ceil(pulls.length / 2)));
  const keywords = [...words.entries()].filter(([, count]) => count >= Math.max(2, Math.ceil(pulls.length / 3))).sort((left, right) => right[1] - left[1]).slice(0, 2).map(([word]) => word);
  const subject = [scope, ...keywords].filter((part, index, all): part is string => part != null && part !== '' && all.indexOf(part) === index).slice(0, 2).join(' ');
  const typeLabel = type == null ? '' : ({ feat: 'Features', fix: 'Fixes', refactor: 'Refactors', perf: 'Performance', chore: 'Chores', test: 'Tests', docs: 'Docs' } as Record<string, string>)[type] ?? type;
  if (subject === '' && typeLabel === '') return 'Related work';
  if (subject === '') return typeLabel;
  return typeLabel === '' ? subject : `${typeLabel}: ${subject}`;
}

export async function groupPulls(pulls: readonly PullRequest[]): Promise<PullGroup[]> {
  const candidates = pulls.slice(0, MAX_PULLS);
  if (candidates.length < 2) return [];
  const primaryRepo = mostCommon(candidates.map((pull) => pull.repository.nameWithOwner));
  const byKey = new Map(candidates.map((pull) => [pull.repository.nameWithOwner === primaryRepo ? `#${pull.number}` : `${pull.repository.nameWithOwner.split('/')[1] ?? pull.repository.nameWithOwner}#${pull.number}`, pull]));
  const keys = [...byKey.keys()];
  const state = { pull_requests: Object.fromEntries(keys.map((key) => [key, describe(byKey.get(key) as PullRequest)])) };
  const sets = new DisjointSet();
  keys.forEach((key) => sets.add(key));
  const chunks = Array.from({ length: Math.ceil(keys.length / CHUNK_SIZE) }, (_, index) => keys.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
  const incoming = new Map<string, number>();
  const failures: string[] = [];
  await Promise.all(
    chunks.map(async (chunk) => {
      const questions = Object.fromEntries(chunk.map((key, index) => [`q${index}`, choiceQuestion(`${key} — ${state.pull_requests[key]}`, PAIR_QUESTION, keys, key)]));
      let answers: Record<string, ChoiceAnswer>;
      try {
        answers = await askJev(state, questions);
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
        return;
      }
      chunk.forEach((key, index) => {
        const answer = answers[`q${index}`];
        if (answer == null || answer.choice === NONE || (answer.probabilities[answer.choice] ?? 0) < PAIR_THRESHOLD || !byKey.has(answer.choice)) return;
        sets.union(key, answer.choice);
        incoming.set(answer.choice, (incoming.get(answer.choice) ?? 0) + 1);
      });
    }),
  );
  if (failures.length === chunks.length) throw new Error(failures[0] ?? 'Jev grouping failed');
  const clusters = sets.groups().filter((group) => group.length > 1);
  const merged = await mergeClusters(clusters, byKey);
  return merged
    .map((group) => {
      const members = group.map((key) => byKey.get(key) as PullRequest);
      return { id: group.slice().sort().join(','), label: labelFor(members), pullIds: members.map((pull) => pull.id) };
    })
    .sort((left, right) => right.pullIds.length - left.pullIds.length);
}

async function mergeClusters(clusters: string[][], byKey: Map<string, PullRequest>): Promise<string[][]> {
  if (clusters.length < 2) return clusters;
  const groupKeys = clusters.map((_, index) => `g${index}`);
  const state = { groups: Object.fromEntries(clusters.map((cluster, index) => [`g${index}`, cluster.slice(0, 8).map((key) => (byKey.get(key)?.title ?? key).slice(0, 90)).join(' | ')])) };
  const questions = Object.fromEntries(groupKeys.map((key) => [key, choiceQuestion(`${key} — ${state.groups[key]}`, GROUP_QUESTION, groupKeys, key)]));
  let answers: Record<string, ChoiceAnswer>;
  try {
    answers = await askJev(state, questions);
  } catch {
    return clusters;
  }
  const sets = new DisjointSet();
  groupKeys.forEach((key) => sets.add(key));
  groupKeys.forEach((key) => {
    const answer = answers[key];
    if (answer == null || answer.choice === NONE || (answer.probabilities[answer.choice] ?? 0) < MERGE_THRESHOLD) return;
    sets.union(key, answer.choice);
  });
  return sets.groups().map((members) => members.flatMap((key) => clusters[Number(key.slice(1))] ?? []));
}
