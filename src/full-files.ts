import { fetchFileAt } from './github';

const CACHE_LIMIT = 400;
const PREFETCH_CONCURRENCY = 3;
const PREFETCH_LIMIT = 80;

const cache = new Map<string, Promise<string>>();
let prefetchRun = 0;

/** A file at a commit, fetched once and shared by the prefetch and an expand click. */
export function fullFile(repo: string, rev: string, path: string): Promise<string> {
  const key = `${repo}@${rev}:${path}`;
  const cached = cache.get(key);
  if (cached != null) return cached;
  const pending = fetchFileAt(repo, rev, path);
  pending.catch(() => cache.delete(key));
  cache.set(key, pending);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value ?? '');
  return pending;
}

/** Fetches files in the background, a few at a time, in order; a later call drops whatever an earlier one had not started. */
export function prefetchFullFiles(repo: string, rev: string, paths: readonly string[]): void {
  const run = ++prefetchRun;
  const queue = paths.slice(0, PREFETCH_LIMIT);
  const work = async (): Promise<void> => {
    for (let path = queue.shift(); path != null && run === prefetchRun; path = queue.shift()) {
      await fullFile(repo, rev, path).catch(() => undefined);
    }
  };
  for (let worker = 0; worker < PREFETCH_CONCURRENCY; worker++) void work();
}

export function cancelFullFilePrefetch(): void {
  prefetchRun++;
}
