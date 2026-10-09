// Who merged and who reviewed the most PRs in an organisation, for the PR Leaderboard dashboard.
//
//   bun scripts/leaderboard.ts --org RelevanceAI --out <dir>
//
// Writes <dir>/leaderboard.json (a row per person and period) and <dir>/totals.json (a row per period). The last
// 30 days of PRs are kept in a cache, so after the first run only PRs that changed since the last one are fetched.
// Same rules as the app's Reviews tab: a review counts once per PR, bots and authors replying on their own PRs don't.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? (args.includes(`--${name}`) ? (args[args.indexOf(`--${name}`) + 1] ?? fallback) : fallback);
const ORG = option('org', 'RelevanceAI');
const OUT = option('out', '.');
const CACHE = join(homedir(), 'Library', 'Caches', 'pr-review-leaderboard', `${ORG}.json`);

const DAY_MS = 86_400_000;
const PAGE_SIZE = 50;
const MAX_RESULTS = 1_000;
const WINDOW_TARGET = 800;
const CONCURRENCY = 8;
/** GitHub's search index trails changes by minutes, so a delta reaches back this far before the last run. */
const INDEX_LAG_MS = 10 * 60_000;
/** A cache older than this is thrown away and the whole month fetched again. */
const FULL_REFRESH_MS = 6 * 3_600_000;

const FIELDS = `... on PullRequest { id number url mergedAt closedAt repository { nameWithOwner } author { login __typename } reviews(last: 100) { nodes { submittedAt author { login __typename } } } }`;

interface Actor {
  login: string;
  __typename?: string;
}
interface Pull {
  id: string;
  number: number;
  url: string;
  mergedAt: string | null;
  closedAt: string | null;
  repository: { nameWithOwner: string };
  author: Actor | null;
  reviews: { nodes: { submittedAt: string | null; author: Actor | null }[] };
}

async function gh(query: string, variables: Record<string, string>): Promise<any> {
  const flags = Object.entries(variables).flatMap(([key, value]) => ['-f', `${key}=${value}`]);
  for (let attempt = 1; ; attempt += 1) {
    const child = Bun.spawn(['gh', 'api', 'graphql', '-f', `query=${query}`, ...flags], { stdout: 'pipe', stderr: 'pipe', env: { ...Bun.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    const body = code === 0 ? JSON.parse(stdout) : null;
    if (body?.data != null) return body.data;
    if (attempt === 3) throw new Error(`gh: ${body?.errors?.[0]?.message ?? (stderr.trim() || `exit ${code}`)}`);
    await Bun.sleep(2_000 * attempt);
  }
}

/** Runs tasks with at most CONCURRENCY at a time. */
async function pooled<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, async () => {
    for (let index = next++; index < tasks.length; index = next++) results[index] = await tasks[index]!();
  }));
  return results;
}

const searchTime = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}+00:00`;
const cursor = (offset: number): string => Buffer.from(`cursor:${offset}`).toString('base64');

async function count(q: string): Promise<number> {
  return (await gh('query($q: String!) { search(query: $q, type: ISSUE, first: 0) { issueCount } }', { q })).search.issueCount;
}

/** `{base} {field}:>=since` as date ranges of at most 1,000 PRs each, with their counts. */
async function windows(base: string, field: string, since: number, now: number): Promise<{ q: string; total: number }[]> {
  const query = (from: number, to: number | null): string => `${base} ${field}:${searchTime(from)}..${to == null ? '*' : searchTime(to)}`;
  let pending: [number, number | null][] = [[since, null]];
  const done: { q: string; total: number }[] = [];
  while (pending.length > 0) {
    const totals = await pooled(pending.map(([from, to]) => () => count(query(from, to))));
    const next: [number, number | null][] = [];
    pending.forEach(([from, to], index) => {
      const total = totals[index]!;
      const end = Math.max(from, to ?? now);
      if (total <= MAX_RESULTS || end - from < 120_000) return void done.push({ q: query(from, to), total });
      const pieces = Math.ceil(total / WINDOW_TARGET);
      const step = Math.ceil((end - from) / pieces);
      for (let piece = 0; piece < pieces; piece += 1) next.push([from + piece * step, piece === pieces - 1 ? to : from + (piece + 1) * step]);
    });
    pending = next;
  }
  return done;
}

const PAGE_QUERY = `query($q: String!, $endCursor: String) { search(query: $q, type: ISSUE, first: ${PAGE_SIZE}, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { ${FIELDS} } } }`;

/** Every PR open and updated since `since`, or closed since then: where any review in that time can be. */
async function fetchPulls(since: number, now: number): Promise<Pull[]> {
  const ranges = (await Promise.all([
    windows(`is:pr is:open archived:false org:${ORG} sort:created-asc`, 'updated', since, now),
    windows(`is:pr is:closed org:${ORG} sort:created-asc`, 'closed', since, now),
  ])).flat().filter((range) => range.total > 0);
  const tasks = ranges.flatMap(({ q, total }) => Array.from({ length: Math.ceil(Math.min(total, MAX_RESULTS) / PAGE_SIZE) }, (_, page) => async () => {
    const variables: Record<string, string> = page === 0 ? { q } : { q, endCursor: cursor(page * PAGE_SIZE) };
    return (await gh(PAGE_QUERY, variables)).search.nodes as Pull[];
  }));
  const byId = new Map<string, Pull>();
  (await pooled(tasks)).flat().forEach((pull) => pull?.id != null && byId.set(pull.id, pull));
  return [...byId.values()];
}

const isBot = (actor: Actor | null): boolean => actor == null || actor.__typename === 'Bot' || actor.login.endsWith('[bot]');
const at = (iso: string | null): number => (iso == null ? Number.NaN : Date.parse(iso));

/** People's reviews on a PR at or after `since`: not bots, not the author. */
function reviewersSince(pull: Pull, since: number): Set<string> {
  const author = pull.author?.login.toLowerCase();
  return new Set(pull.reviews.nodes.filter((review) => !isBot(review.author) && review.author!.login.toLowerCase() !== author && at(review.submittedAt) >= since).map((review) => review.author!.login));
}

const reviewsSince = (pull: Pull, since: number): number => {
  const author = pull.author?.login.toLowerCase();
  return pull.reviews.nodes.filter((review) => !isBot(review.author) && review.author!.login.toLowerCase() !== author && at(review.submittedAt) >= since).length;
};

// Fetch: the whole month when there is no fresh cache, else what changed since the last run.
const now = Date.now();
const monthAgo = now - 30 * DAY_MS;
let cache: { fetchedAt: number; pulls: Pull[] } | null = null;
try {
  cache = JSON.parse(readFileSync(CACHE, 'utf8'));
} catch {
  cache = null;
}
const isDelta = cache != null && now - cache.fetchedAt < FULL_REFRESH_MS && !args.includes('--full');
const started = performance.now();
const fetched = await fetchPulls(isDelta ? cache!.fetchedAt - INDEX_LAG_MS : monthAgo, now);
const merged = new Map((isDelta ? cache!.pulls : []).map((pull) => [pull.id, pull]));
fetched.forEach((pull) => merged.set(pull.id, pull));
const pulls = [...merged.values()].filter((pull) => at(pull.mergedAt) >= monthAgo || reviewersSince(pull, monthAgo).size > 0);
mkdirSync(join(CACHE, '..'), { recursive: true });
writeFileSync(CACHE, JSON.stringify({ fetchedAt: now, pulls }));

// Periods in local time; a week starts on Monday.
const midnight = new Date(new Date(now).setHours(0, 0, 0, 0));
const monday = new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - ((midnight.getDay() + 6) % 7));
const PERIODS = [
  { period: 'today', label: 'Today', since: midnight.getTime() },
  { period: 'week', label: 'This week', since: monday.getTime() },
  { period: '7d', label: 'Last 7 days', since: now - 7 * DAY_MS },
  { period: '30d', label: 'Last 30 days', since: monthAgo },
];

/** Standard competition ranks (1, 2, 2, 4) by value, highest first. */
function ranks(values: Map<string, number>): Map<string, number> {
  const sorted = [...values.values()].sort((left, right) => right - left);
  return new Map([...values].map(([login, value]) => [login, sorted.indexOf(value) + 1]));
}

const roster = new Set<string>();
pulls.forEach((pull) => {
  if (!isBot(pull.author) && at(pull.mergedAt) >= monthAgo) roster.add(pull.author!.login);
  reviewersSince(pull, monthAgo).forEach((login) => roster.add(login));
});

const people: Record<string, string | number>[] = [];
const totals: Record<string, string | number>[] = [];
for (const { period, label, since } of PERIODS) {
  const mergedBy = new Map([...roster].map((login) => [login, 0]));
  const reviewedBy = new Map([...roster].map((login) => [login, 0]));
  let mergedPrs = 0;
  let reviewedPrs = 0;
  let reviews = 0;
  for (const pull of pulls) {
    if (!isBot(pull.author) && at(pull.mergedAt) >= since) {
      mergedPrs += 1;
      mergedBy.set(pull.author!.login, (mergedBy.get(pull.author!.login) ?? 0) + 1);
    }
    const reviewers = reviewersSince(pull, since);
    if (reviewers.size > 0) reviewedPrs += 1;
    reviews += reviewsSince(pull, since);
    reviewers.forEach((login) => reviewedBy.set(login, (reviewedBy.get(login) ?? 0) + 1));
  }
  const combined = new Map([...roster].map((login) => [login, (mergedBy.get(login) ?? 0) + (reviewedBy.get(login) ?? 0)]));
  const [mergedRank, reviewedRank, combinedRank] = [ranks(mergedBy), ranks(reviewedBy), ranks(combined)];
  [...roster]
    .sort((left, right) => (combined.get(right) ?? 0) - (combined.get(left) ?? 0) || left.localeCompare(right))
    .forEach((login) => people.push({ period, login, merged: mergedBy.get(login) ?? 0, reviewed: reviewedBy.get(login) ?? 0, combined: combined.get(login) ?? 0, merged_rank: mergedRank.get(login)!, reviewed_rank: reviewedRank.get(login)!, combined_rank: combinedRank.get(login)! }));
  totals.push({ period, label, since: new Date(since).toISOString(), merged_prs: mergedPrs, reviewed_prs: reviewedPrs, reviews, active_people: [...combined.values()].filter((value) => value > 0).length, as_of: new Date(now).toISOString() });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'leaderboard.json'), JSON.stringify(people));
writeFileSync(join(OUT, 'totals.json'), JSON.stringify(totals));
console.log(`${isDelta ? 'delta' : 'full'} fetch: ${fetched.length} PRs in ${((performance.now() - started) / 1000).toFixed(1)}s; ${pulls.length} kept, ${roster.size} people; wrote ${OUT}`);
