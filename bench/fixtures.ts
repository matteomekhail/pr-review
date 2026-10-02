export interface FixturePull {
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
  baseRefName: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeQueueEntry: { position: number; state: string } | null;
  author: { login: string; avatarUrl: string };
  repository: { nameWithOwner: string };
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] };
}

export const FIXTURE_NOW = Date.parse('2026-09-26T12:00:00Z');

function mulberry32(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const WORDS = ['refactor', 'feat', 'fix', 'perf', 'test', 'chore', 'share', 'router', 'filter', 'accordion', 'cache', 'billing', 'models', 'sidebar', 'trust-score', 'merge', 'queue', 'i18n', 'dialog', 'icons'];

export function generatePulls(count: number, seed = 42): FixturePull[] {
  const random = mulberry32(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  return Array.from({ length: count }, (_, index) => {
    const number = 40_000 + index;
    const repo = pick(['o/web', 'o/web', 'o/web', 'o/api', 'o/plugins']);
    const title = `${pick(WORDS)}(${pick(WORDS)}): ${Array.from({ length: 4 + Math.floor(random() * 6) }, () => pick(WORDS)).join(' ')}`;
    return {
      id: `PR_${seed}_${index}`,
      number,
      title,
      url: `https://github.com/${repo}/pull/${number}`,
      isDraft: random() < 0.05,
      createdAt: new Date(FIXTURE_NOW - Math.floor(random() * 30 * 86_400_000)).toISOString(),
      updatedAt: new Date(FIXTURE_NOW - Math.floor(random() * 5 * 86_400_000)).toISOString(),
      additions: Math.floor(random() ** 3 * 3_000),
      deletions: Math.floor(random() ** 3 * 800),
      changedFiles: 1 + Math.floor(random() * 30),
      headRefName: `branch-${number}`,
      baseRefName: 'main',
      reviewDecision: pick(['APPROVED', 'APPROVED', 'REVIEW_REQUIRED', 'CHANGES_REQUESTED', null] as const),
      mergeQueueEntry: random() < 0.08 ? { position: Math.floor(random() * 6), state: 'QUEUED' } : null,
      author: { login: 'author', avatarUrl: '' },
      repository: { nameWithOwner: repo },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: pick(['SUCCESS', 'SUCCESS', 'SUCCESS', 'FAILURE', 'PENDING']) } } }] },
    };
  });
}

export function generateDiff(pull: FixturePull, seed = 7): string {
  const random = mulberry32(seed + pull.number);
  const files = Math.max(1, Math.min(pull.changedFiles, 24));
  return Array.from({ length: files }, (_, fileIndex) => {
    const path = `src/module-${fileIndex}/file-${pull.number}-${fileIndex}.ts`;
    const lines = 10 + Math.floor(random() * 120);
    const body = Array.from({ length: lines }, (_, line) => {
      const roll = random();
      const code = `  const value${line} = compute(${line}, '${WORDS[line % WORDS.length]}');`;
      return roll < 0.2 ? `+${code}` : roll < 0.3 ? `-${code}` : ` ${code}`;
    });
    const added = body.filter((line) => line.startsWith('+')).length;
    const removed = body.filter((line) => line.startsWith('-')).length;
    const context = body.length - added - removed;
    return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,${context + removed} +1,${context + added} @@\n${body.join('\n')}\n`;
  }).join('');
}

export function generateBody(pull: FixturePull): string {
  const section = (title: string, text: string): string => `<h2>${title}</h2><p>${text}</p>`;
  const paragraph = `${pull.title}. `.repeat(8);
  return [section('Summary', paragraph), section('What changed?', `<ul>${Array.from({ length: 6 }, (_, index) => `<li><code>src/file-${index}.ts</code> ${paragraph}</li>`).join('')}</ul>`), section('How to test', paragraph), `<pre><code>${'bun run test\n'.repeat(6)}</code></pre>`].join('');
}
