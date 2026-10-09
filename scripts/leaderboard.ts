// Who merged and who reviewed the most PRs in an organisation, for the PR Leaderboard dashboard.
//
//   bun scripts/leaderboard.ts --org RelevanceAI --out <dir>
//
// Writes <dir>/leaderboard.json (a row per person and period), <dir>/totals.json (a row per period) and <dir>/prs.json
// (a row per PR with its complexity). The last 30 days of PRs are kept in a cache, so after the first run only PRs that
// changed since the last one are fetched. Same rules as the app's Reviews tab: a review counts once per PR, bots and
// authors replying on their own PRs don't.
//
// Complexity: Jev (TypeSafe's systemone API, the model behind the app's readiness score) rates each PR's breadth, logic
// and review effort from 0 to 4 from its title, description and changed files; their sum maps onto 1 (trivial) to 10.
// A PR is rated once per head commit and the ratings are cached. The key comes from TYPESAFE_API_KEY or the macOS
// Keychain (service TYPESAFE_API_KEY), as in the app; without one, the counts still update and unrated PRs score
// nothing. A person's points are the complexity of each PR they merged plus the complexity of each PR they reviewed.
// The first run rates the whole month (about 1,600 PRs): pass --rating-budget-s 3600 to let it finish in one go.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name: string, fallback: string): string => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? (args.includes(`--${name}`) ? (args[args.indexOf(`--${name}`) + 1] ?? fallback) : fallback);
const ORG = option('org', 'RelevanceAI');
const OUT = option('out', '.');
const CACHE_DIR = join(homedir(), 'Library', 'Caches', 'pr-review-leaderboard');
const CACHE = join(CACHE_DIR, `${ORG}.v2.json`);
const RATINGS = join(CACHE_DIR, `${ORG}.complexity.json`);
const LOCK = join(CACHE_DIR, `${ORG}.rating.lock`);

const DAY_MS = 86_400_000;
const PAGE_SIZE = 50;
const MAX_RESULTS = 1_000;
const WINDOW_TARGET = 800;
const CONCURRENCY = 8;
/** GitHub's search index trails changes by minutes, so a delta reaches back this far before the last run. */
const INDEX_LAG_MS = 10 * 60_000;
/** A cache older than this is thrown away and the whole month fetched again. */
const FULL_REFRESH_MS = 6 * 3_600_000;
const SYSTEM_ONE_URL = 'https://api.typesafe.ai/v1/systemone';
const RATING_CONCURRENCY = 6;
/** A run stops rating after this long, so the first backfill spreads over several runs instead of holding one up. */
const RATING_BUDGET_MS = Number(option('rating-budget-s', '600')) * 1_000;
const CONTEXT_BATCH = 20;
const MAX_BODY_CHARS = 4_000;
const MAX_FILES = 60;
/** Bumped when the question changes, so every PR is rated again on the new scale. */
const RATING_VERSION = 3;

const FIELDS = `... on PullRequest { id number title url headRefOid mergedAt closedAt repository { nameWithOwner } author { login __typename } reviews(last: 100) { nodes { submittedAt author { login __typename } } } }`;

interface Actor {
  login: string;
  __typename?: string;
}
interface Pull {
  id: string;
  number: number;
  title: string;
  url: string;
  headRefOid: string;
  mergedAt: string | null;
  closedAt: string | null;
  repository: { nameWithOwner: string };
  author: Actor | null;
  reviews: { nodes: { submittedAt: string | null; author: Actor | null }[] };
}

async function gh(query: string, variables: Record<string, string>, ids: readonly string[] = []): Promise<any> {
  const flags = [...Object.entries(variables).flatMap(([key, value]) => ['-f', `${key}=${value}`]), ...ids.flatMap((id) => ['-f', `ids[]=${id}`])];
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
async function pooled<T>(tasks: (() => Promise<T>)[], limit = CONCURRENCY): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
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

// Complexity ratings: every kept PR, once per head commit.
interface Rating {
  v: number;
  sha: string;
  complexity: number;
  confidence: number;
  at: string;
}
let ratings: Record<string, Rating> = {};
try {
  ratings = JSON.parse(readFileSync(RATINGS, 'utf8'));
} catch {
  ratings = {};
}

const SIZE_NOTE = 'Size alone is not complexity: generated files, lockfiles, snapshots, renames, version bumps and mechanical refactors are simple even when large.';

/** Three sides of complexity, each 0–4; a PR's complexity is their sum mapped onto 1–10. One question alone put most PRs on the same level. */
const COMPLEXITY_QUESTIONS = {
  breadth: {
    type: 'score',
    instructions: `Judging by the \`files\` and the \`pull_request\` description, how many distinct parts of the system does this pull request change in a meaningful way (packages, services, layers such as UI, API, database and infrastructure)? ${SIZE_NOTE}`,
    criteria: ['Nothing meaningful: docs, config values or generated files only', 'One small area', 'One area in depth, or two areas lightly', 'Several areas or services that have to change together', 'Many areas across the system, or a cross-cutting change'],
  },
  logic: {
    type: 'score',
    instructions: `How hard is the logic this pull request adds or changes? Consider algorithms, state, data model and schema changes, concurrency, error handling and edge cases, as described in the \`pull_request\` body and implied by the \`files\`. ${SIZE_NOTE}`,
    criteria: ['No real logic: text, styling, wiring or values', 'Straightforward logic with obvious behaviour', 'Some real logic with a few cases to get right', 'Intricate logic: state, data model changes or many edge cases', 'Hard logic: concurrency, migrations, distributed state or novel algorithms'],
  },
  review_effort: {
    type: 'score',
    instructions: 'How much careful reasoning does a reviewer need to be confident this pull request is correct and safe, given what it touches (security, permissions, money, data, infrastructure, contracts between services) and how easy its changes are to follow?',
    criteria: ['A glance is enough', 'A quick read', 'A careful read of the main changes', 'Close study, possibly running it, with real risk if wrong', 'Deep study by someone who knows the system, high risk if wrong'],
  },
};

async function typesafeKey(): Promise<string | null> {
  const fromEnv = Bun.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const child = Bun.spawn(['security', 'find-generic-password', '-s', 'TYPESAFE_API_KEY', '-w'], { stdout: 'pipe', stderr: 'ignore' });
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return code === 0 && stdout.trim() !== '' ? stdout.trim() : null;
}

interface Context {
  id: string;
  title: string;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  files: { totalCount: number; nodes: { path: string; additions: number; deletions: number }[] } | null;
}

const clip = (text: string, limit: number): string => {
  const trimmed = text.replace(/\n{3,}/g, '\n\n').trim();
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed;
};

async function rate(key: string, context: Context): Promise<{ complexity: number; confidence: number }> {
  const files = context.files?.nodes ?? [];
  const state = {
    pull_request: { title: context.title, body: clip(context.body ?? '', MAX_BODY_CHARS), lines_added: context.additions, lines_deleted: context.deletions, files_changed: context.changedFiles },
    files: files.slice(0, MAX_FILES).map((file) => `${file.path} (+${file.additions} -${file.deletions})`),
    files_not_listed: Math.max(0, (context.files?.totalCount ?? files.length) - Math.min(files.length, MAX_FILES)),
  };
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(SYSTEM_ONE_URL, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'jev-latest', state, questions: COMPLEXITY_QUESTIONS }), signal: AbortSignal.timeout(90_000) });
      const body = (await response.json()) as { answers?: Record<string, { type: string; score: number; confidence: number }>; error?: { message?: string } };
      const answers = Object.keys(COMPLEXITY_QUESTIONS).map((name) => body.answers?.[name]);
      if (!response.ok || answers.some((answer) => answer?.type !== 'score')) throw new Error(body.error?.message ?? `HTTP ${response.status}`);
      const sum = answers.reduce((total, answer) => total + Math.min(4, Math.max(0, answer!.score)), 0);
      return { complexity: Math.round(1 + (sum / 12) * 9), confidence: Math.min(...answers.map((answer) => answer!.confidence)) };
    } catch (error) {
      if (attempt === 3 || String(error).includes('401') || String(error).toLowerCase().includes('unauthor')) throw error;
      await Bun.sleep(3_000 * attempt);
    }
  }
}

const CONTEXT_QUERY = `query($ids: [ID!]!) { nodes(ids: $ids) { ... on PullRequest { id title body additions deletions changedFiles files(first: ${MAX_FILES}) { totalCount nodes { path additions deletions } } } } }`;

/** Rates PRs without a rating for their current head, until the budget runs out; returns how many were rated and why it stopped early. */
async function rateMissing(): Promise<string> {
  const missing = pulls.filter((pull) => ratings[pull.id]?.v !== RATING_VERSION || (pull.headRefOid != null && ratings[pull.id]!.sha !== pull.headRefOid));
  if (missing.length === 0) return 'all PRs rated';
  const key = await typesafeKey();
  if (key == null) return `${missing.length} PRs unrated: no TYPESAFE_API_KEY`;
  try {
    const lock = JSON.parse(readFileSync(LOCK, 'utf8')) as { at: number };
    if (now - lock.at < 20 * 60_000) return `${missing.length} PRs unrated: another run is rating`;
  } catch {
    // no lock
  }
  writeFileSync(LOCK, JSON.stringify({ at: now }));
  const deadline = performance.now() + RATING_BUDGET_MS;
  let rated = 0;
  let failure = '';
  try {
    const batches = Array.from({ length: Math.ceil(missing.length / CONTEXT_BATCH) }, (_, index) => missing.slice(index * CONTEXT_BATCH, (index + 1) * CONTEXT_BATCH));
    for (const batch of batches) {
      if (performance.now() > deadline || failure !== '') break;
      const contexts = ((await gh(CONTEXT_QUERY, {}, batch.map((pull) => pull.id))).nodes as (Context | null)[]).filter((context): context is Context => context?.id != null);
      const sha = new Map(batch.map((pull) => [pull.id, pull.headRefOid]));
      await pooled(contexts.map((context) => async () => {
        if (failure !== '') return;
        try {
          const result = await rate(key, context);
          ratings[context.id] = { v: RATING_VERSION, sha: sha.get(context.id) ?? '', ...result, at: new Date().toISOString() };
          rated += 1;
        } catch (error) {
          if (String(error).includes('401') || String(error).toLowerCase().includes('unauthor')) failure = 'the TypeSafe key was refused';
        }
      }), RATING_CONCURRENCY);
      writeFileSync(RATINGS, JSON.stringify(ratings));
    }
  } finally {
    writeFileSync(RATINGS, JSON.stringify(ratings));
    writeFileSync(LOCK, JSON.stringify({ at: 0 }));
  }
  const left = pulls.filter((pull) => ratings[pull.id]?.v !== RATING_VERSION).length;
  return `rated ${rated}${left > 0 ? `, ${left} still unrated${failure !== '' ? ` (${failure})` : ' (continues next run)'}` : ''}`;
}

const ratingSummary = args.includes('--no-rating') ? 'rating skipped' : await rateMissing();
const ratingOf = (pull: Pull): Rating | undefined => (ratings[pull.id]?.v === RATING_VERSION ? ratings[pull.id] : undefined);
const complexityOf = (pull: Pull): number => ratingOf(pull)?.complexity ?? 0;

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
  const zero = () => new Map([...roster].map((login) => [login, 0]));
  const [mergedBy, reviewedBy, mergedPoints, reviewedPoints] = [zero(), zero(), zero(), zero()];
  const add = (map: Map<string, number>, login: string, value: number) => map.set(login, (map.get(login) ?? 0) + value);
  let mergedPrs = 0;
  let reviewedPrs = 0;
  let reviews = 0;
  let complexitySum = 0;
  let rated = 0;
  let unrated = 0;
  for (const pull of pulls) {
    const isMerged = !isBot(pull.author) && at(pull.mergedAt) >= since;
    const reviewers = reviewersSince(pull, since);
    if (isMerged || reviewers.size > 0) {
      if (ratingOf(pull) == null) unrated += 1;
      else rated += 1;
    }
    if (isMerged) {
      mergedPrs += 1;
      add(mergedBy, pull.author!.login, 1);
      add(mergedPoints, pull.author!.login, complexityOf(pull));
      if (ratingOf(pull) != null) complexitySum += complexityOf(pull);
    }
    if (reviewers.size > 0) reviewedPrs += 1;
    reviews += reviewsSince(pull, since);
    reviewers.forEach((login) => {
      add(reviewedBy, login, 1);
      add(reviewedPoints, login, complexityOf(pull));
    });
  }
  const combined = new Map([...roster].map((login) => [login, (mergedBy.get(login) ?? 0) + (reviewedBy.get(login) ?? 0)]));
  const points = new Map([...roster].map((login) => [login, (mergedPoints.get(login) ?? 0) + (reviewedPoints.get(login) ?? 0)]));
  const [mergedRank, reviewedRank, combinedRank, pointsRank] = [ranks(mergedBy), ranks(reviewedBy), ranks(combined), ranks(points)];
  const mergedRated = pulls.filter((pull) => !isBot(pull.author) && at(pull.mergedAt) >= since && ratingOf(pull) != null).length;
  [...roster]
    .sort((left, right) => (points.get(right) ?? 0) - (points.get(left) ?? 0) || left.localeCompare(right))
    .forEach((login) => people.push({ period, login, merged: mergedBy.get(login) ?? 0, reviewed: reviewedBy.get(login) ?? 0, combined: combined.get(login) ?? 0, merged_points: mergedPoints.get(login) ?? 0, reviewed_points: reviewedPoints.get(login) ?? 0, points: points.get(login) ?? 0, merged_rank: mergedRank.get(login)!, reviewed_rank: reviewedRank.get(login)!, combined_rank: combinedRank.get(login)!, points_rank: pointsRank.get(login)! }));
  totals.push({ period, label, since: new Date(since).toISOString(), merged_prs: mergedPrs, reviewed_prs: reviewedPrs, reviews, active_people: [...combined.values()].filter((value) => value > 0).length, avg_complexity: mergedRated === 0 ? null : Math.round((complexitySum / mergedRated) * 10) / 10, rated_prs: rated, unrated_prs: unrated, as_of: new Date(now).toISOString() });
}

mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, 'leaderboard.json'), JSON.stringify(people));
writeFileSync(join(OUT, 'totals.json'), JSON.stringify(totals));
const prs = pulls
  .map((pull) => ({ id: `${pull.repository.nameWithOwner}#${pull.number}`, repo: pull.repository.nameWithOwner.split('/')[1] ?? pull.repository.nameWithOwner, number: pull.number, title: pull.title ?? '', author: pull.author?.login ?? '', is_bot: isBot(pull.author), complexity: ratingOf(pull)?.complexity ?? null, merged_at: pull.mergedAt, last_review_at: pull.reviews.nodes.reduce<string | null>((latest, review) => (review.submittedAt != null && !isBot(review.author) && (latest == null || review.submittedAt > latest) ? review.submittedAt : latest), null), url: pull.url }))
  .sort((left, right) => (right.complexity ?? 0) - (left.complexity ?? 0) || String(right.merged_at ?? '').localeCompare(String(left.merged_at ?? '')));
writeFileSync(join(OUT, 'prs.json'), JSON.stringify(prs));
console.log(`${isDelta ? 'delta' : 'full'} fetch: ${fetched.length} PRs in ${((performance.now() - started) / 1000).toFixed(1)}s; ${pulls.length} kept, ${roster.size} people; ${ratingSummary}; wrote ${OUT}`);
