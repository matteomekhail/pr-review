import type { FixturePull } from './fixtures';

export const DEMO_NOW = Date.parse('2026-09-28T09:00:00Z');

interface DemoSpec {
  title: string;
  repo: string;
  hoursAgo: number;
  additions: number;
  deletions: number;
  files: number;
  review: FixturePull['reviewDecision'];
  checks: 'SUCCESS' | 'FAILURE' | 'PENDING';
  conflict?: boolean;
  draft?: boolean;
  queued?: number;
}

const SPECS: DemoSpec[] = [
  { title: 'perf(search): debounce semantic search and cancel stale requests', repo: 'acme/web', hoursAgo: 0.3, additions: 84, deletions: 21, files: 3, review: 'APPROVED', checks: 'SUCCESS' },
  { title: 'feat(billing): show prorated credit on plan downgrade', repo: 'acme/web', hoursAgo: 1.2, additions: 212, deletions: 40, files: 7, review: 'APPROVED', checks: 'SUCCESS' },
  { title: 'fix(auth): refresh session before it expires on idle tabs', repo: 'acme/api', hoursAgo: 2, additions: 46, deletions: 12, files: 2, review: 'APPROVED', checks: 'SUCCESS', queued: 1 },
  { title: 'refactor(ui): share one Dialog shell across settings panels', repo: 'acme/web', hoursAgo: 3, additions: 318, deletions: 402, files: 11, review: 'REVIEW_REQUIRED', checks: 'SUCCESS' },
  { title: 'feat(api): add cursor pagination to /v1/invoices', repo: 'acme/api', hoursAgo: 4, additions: 157, deletions: 18, files: 5, review: 'APPROVED', checks: 'SUCCESS' },
  { title: 'fix(editor): keep caret position after remote patch', repo: 'acme/web', hoursAgo: 5, additions: 38, deletions: 9, files: 2, review: 'CHANGES_REQUESTED', checks: 'SUCCESS' },
  { title: 'chore(deps): bump vite to 7.1 and drop legacy plugin', repo: 'acme/web', hoursAgo: 6, additions: 22, deletions: 61, files: 4, review: 'APPROVED', checks: 'FAILURE' },
  { title: 'feat(onboarding): checklist with progress in the sidebar', repo: 'acme/web', hoursAgo: 9, additions: 486, deletions: 33, files: 14, review: 'REVIEW_REQUIRED', checks: 'PENDING' },
  { title: 'fix(queue): retry webhook delivery with jittered backoff', repo: 'acme/workers', hoursAgo: 11, additions: 91, deletions: 27, files: 3, review: 'APPROVED', checks: 'SUCCESS' },
  { title: 'refactor(db): move tenant scoping into a query helper', repo: 'acme/api', hoursAgo: 14, additions: 263, deletions: 298, files: 9, review: 'APPROVED', checks: 'SUCCESS', conflict: true },
  { title: 'test(e2e): cover invite flow on mobile viewport', repo: 'acme/web', hoursAgo: 18, additions: 144, deletions: 0, files: 2, review: 'APPROVED', checks: 'SUCCESS' },
  { title: 'feat(search): highlight matched terms in results', repo: 'acme/web', hoursAgo: 22, additions: 73, deletions: 14, files: 3, review: 'REVIEW_REQUIRED', checks: 'SUCCESS' },
  { title: 'docs(readme): document local setup with one command', repo: 'acme/workers', hoursAgo: 26, additions: 58, deletions: 31, files: 1, review: 'APPROVED', checks: 'SUCCESS' },
  { title: 'perf(list): virtualize the activity feed', repo: 'acme/web', hoursAgo: 30, additions: 201, deletions: 87, files: 4, review: 'APPROVED', checks: 'SUCCESS' },
  { title: 'wip: new reporting dashboard layout', repo: 'acme/web', hoursAgo: 40, additions: 612, deletions: 12, files: 18, review: null, checks: 'PENDING', draft: true },
  { title: 'fix(i18n): pluralize seat counts in German', repo: 'acme/web', hoursAgo: 46, additions: 12, deletions: 4, files: 2, review: 'APPROVED', checks: 'SUCCESS' },
];

export const DEMO_PULLS: FixturePull[] = SPECS.map((spec, index) => {
  const number = 4812 - index * 3;
  return {
    id: `DEMO_${index}`,
    number,
    title: spec.title,
    url: `https://github.com/${spec.repo}/pull/${number}`,
    isDraft: spec.draft === true,
    createdAt: new Date(DEMO_NOW - (spec.hoursAgo + 20) * 3_600_000).toISOString(),
    updatedAt: new Date(DEMO_NOW - spec.hoursAgo * 3_600_000).toISOString(),
    additions: spec.additions,
    deletions: spec.deletions,
    changedFiles: spec.files,
    headRefName: spec.title.replace(/^[a-z]+(\([^)]*\))?:\s*/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 42).replace(/-$/, ''),
    baseRefName: 'main',
    reviewDecision: spec.review,
    mergeQueueEntry: spec.queued == null ? null : { position: spec.queued - 1, state: 'AWAITING_CHECKS' },
    author: { login: 'sam-rivera', avatarUrl: '' },
    repository: { nameWithOwner: spec.repo },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: spec.checks } } }] },
  };
});

export const FEATURED_TITLE = 'perf(search): debounce semantic search and cancel stale requests';

function isFeatured(pull: FixturePull): boolean {
  return pull.title === FEATURED_TITLE;
}

export const DEMO_CONFLICTS = new Set(SPECS.flatMap((spec, index) => (spec.conflict === true ? [`DEMO_${index}`] : [])));

export function demoBody(pull: FixturePull): string {
  if (!isFeatured(pull)) return `<h2>Summary</h2><p>${pull.title}.</p><h2>How to test</h2><ol><li>Run <code>bun run dev</code>.</li><li>Follow the steps in the linked issue.</li></ol>`;
  return `<h2>Summary</h2>
<p>Semantic search fired a request on every keystroke and let slow responses overwrite newer ones. This debounces input by 180&nbsp;ms and aborts the in-flight request when the query changes, so results always match what is in the box.</p>
<h2>What changed?</h2>
<ul>
<li><code>src/search/semantic.ts</code>: wraps the fetch in an <code>AbortController</code> keyed by query and debounces with a trailing edge.</li>
<li><code>src/search/useSearch.ts</code>: ignores responses whose query no longer matches the input.</li>
<li><code>src/search/semantic.test.ts</code>: covers debounce timing, abort on change and stale-response suppression.</li>
</ul>
<h2>Show me</h2>
<pre><code>  typing "invoice"
- 7 requests, last response wins at random     p95 640 ms
+ 1 request after 180 ms idle, stale ones aborted   p95 210 ms</code></pre>
<h2>How to test</h2>
<ol><li>Open search and type quickly; the network tab shows one request per pause.</li><li>Throttle to Slow 3G and type two queries; only the second renders.</li></ol>
<p>Preview: <a href="https://pr-4812.preview.acme.dev/search">https://pr-4812.preview.acme.dev/search</a></p>`;
}

export function demoConversation(pull: FixturePull): unknown {
  const nodes = !isFeatured(pull) ? [] : [
    { id: 'd1', bodyHTML: '<h3>🚀 Web preview deployed</h3><p><a href="https://pr-4812.preview.acme.dev">https://pr-4812.preview.acme.dev</a></p>', createdAt: new Date(DEMO_NOW - 0.25 * 3_600_000).toISOString(), url: `${pull.url}#issuecomment-1`, author: { login: 'github-actions', avatarUrl: '', __typename: 'Bot' } },
    { id: 'd2', bodyHTML: '<p>Nice, the abort handling reads cleanly. One nit: can we export the 180 ms as <code>SEARCH_DEBOUNCE_MS</code> so the test does not hard-code it?</p>', createdAt: new Date(DEMO_NOW - 0.2 * 3_600_000).toISOString(), url: `${pull.url}#issuecomment-2`, author: { login: 'jordan-lee', avatarUrl: '', __typename: 'User' } },
  ];
  const reviews = !isFeatured(pull) ? [] : [
    { id: 'r1', state: 'APPROVED', bodyHTML: '<p>Verified locally on Slow 3G; one request per pause and no stale results. Approving.</p>', submittedAt: new Date(DEMO_NOW - 0.15 * 3_600_000).toISOString(), url: `${pull.url}#pullrequestreview-1`, author: { login: 'jordan-lee', avatarUrl: '', __typename: 'User' }, comments: { totalCount: 0 } },
  ];
  return { data: { repository: { pullRequest: { comments: { totalCount: nodes.length, nodes }, reviews: { totalCount: reviews.length, nodes: reviews } } } } };
}

export function demoDiff(pull: FixturePull): string | null {
  if (!isFeatured(pull)) return null;
  return `diff --git a/src/search/semantic.ts b/src/search/semantic.ts
--- a/src/search/semantic.ts
+++ b/src/search/semantic.ts
@@ -1,18 +1,34 @@
 import { fetchScores } from './api';
+import { debounce } from '../lib/debounce';
 
-export async function semanticSearch(query: string): Promise<Score[]> {
-  if (query.trim() === '') return [];
-  return fetchScores(query);
+export const SEARCH_DEBOUNCE_MS = 180;
+
+let controller: AbortController | null = null;
+
+export function semanticSearch(query: string): Promise<Score[]> {
+  controller?.abort();
+  if (query.trim() === '') return Promise.resolve([]);
+  controller = new AbortController();
+  return fetchScores(query, { signal: controller.signal });
 }
 
+export const debouncedSearch = debounce(semanticSearch, SEARCH_DEBOUNCE_MS);
+
 export function rank(scores: Score[]): Score[] {
   return [...scores].sort((left, right) => right.value - left.value);
 }
diff --git a/src/search/useSearch.ts b/src/search/useSearch.ts
--- a/src/search/useSearch.ts
+++ b/src/search/useSearch.ts
@@ -8,11 +8,15 @@ export function useSearch(input: string): SearchState {
   const [results, setResults] = useState<Score[]>([]);
 
   useEffect(() => {
-    semanticSearch(input).then(setResults);
+    let isCurrent = true;
+    debouncedSearch(input)
+      .then((scores) => isCurrent && setResults(rank(scores)))
+      .catch((error) => isAbort(error) || reportError(error));
+    return () => {
+      isCurrent = false;
+    };
   }, [input]);
 
   return { results };
 }
`;
}
