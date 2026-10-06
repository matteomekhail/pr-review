import type { PullRequest } from './github';

/**
 * Fresh search results against the ones on screen. Unchanged PRs keep their previous objects, so caches keyed by
 * object stay warm and nothing re-renders for them; null means nothing changed at all, not even the order.
 */
export function mergeSearch(previous: readonly PullRequest[], next: readonly PullRequest[]): PullRequest[] | null {
  const before = new Map(previous.map((pull) => [pull.id, pull]));
  let isChanged = previous.length !== next.length;
  const merged = next.map((pull, index) => {
    const old = before.get(pull.id);
    if (old != null && JSON.stringify(old) === JSON.stringify(pull)) {
      if (previous[index]?.id !== pull.id) isChanged = true;
      return old;
    }
    isChanged = true;
    return pull;
  });
  return isChanged ? merged : null;
}
