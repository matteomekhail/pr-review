import type { PullRequest } from './github';

const RESHUFFLE_AFTER_MS = 10 * 60_000;

/**
 * Keeps the list order steady across refreshes and merges. Pulls already shown keep their
 * relative order; new pulls slot in where the fresh ranking puts them. A full re-sort only
 * happens when the view changes, on an explicit refresh, or after a long idle.
 */
export class StableOrder {
  private order: string[] = [];
  private viewKey = '';
  private sortedAt = 0;

  reset(): void {
    this.order = [];
    this.viewKey = '';
  }

  apply(ranked: readonly PullRequest[], viewKey: string, now = Date.now()): PullRequest[] {
    const isNewView = viewKey !== this.viewKey || now - this.sortedAt > RESHUFFLE_AFTER_MS || this.order.length === 0;
    if (isNewView) {
      this.viewKey = viewKey;
      this.sortedAt = now;
      this.order = ranked.map((pull) => pull.id);
      return [...ranked];
    }
    const present = new Map(ranked.map((pull) => [pull.id, pull]));
    const kept = this.order.filter((id) => present.has(id));
    const keptSet = new Set(kept);
    const result = [...kept];
    ranked.forEach((pull, rankIndex) => {
      if (keptSet.has(pull.id)) return;
      const nextKnown = ranked.slice(rankIndex + 1).find((candidate) => keptSet.has(candidate.id));
      const insertAt = nextKnown == null ? result.length : result.indexOf(nextKnown.id);
      result.splice(insertAt, 0, pull.id);
      keptSet.add(pull.id);
    });
    this.order = result;
    return result.map((id) => present.get(id) as PullRequest);
  }
}
