import type { PullRequest } from './github';

export type MergedPeriod = 'today' | 'week' | '7d' | '30d' | '90d';

export const MERGED_PERIODS: Record<MergedPeriod, string> = { today: 'Today', week: 'This week', '7d': 'Last 7 days', '30d': 'Last 30 days', '90d': 'Last 90 days' };

const DAY_MS = 86_400_000;

function pad(value: number): string {
  return String(Math.abs(value)).padStart(2, '0');
}

/** A time in ISO 8601 with my own offset, so "today" means my day rather than UTC's. */
export function localIso(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00${sign}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}

/** Where a period starts, for GitHub's `merged:>=`. A week starts on Monday. */
export function mergedSince(period: MergedPeriod, now = new Date()): string {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (period) {
    case 'today':
      return localIso(midnight);
    case 'week':
      return localIso(new Date(midnight.getFullYear(), midnight.getMonth(), midnight.getDate() - ((midnight.getDay() + 6) % 7)));
    case '7d':
      return localIso(new Date(now.getTime() - 7 * DAY_MS));
    case '30d':
      return localIso(new Date(now.getTime() - 30 * DAY_MS));
    case '90d':
      return localIso(new Date(now.getTime() - 90 * DAY_MS));
    default:
      return period satisfies never;
  }
}

/** People by count, most first, then by name. */
export function ranked(counts: ReadonlyMap<string, number>): [string, number][] {
  return [...counts].sort(([leftName, left], [rightName, right]) => right - left || leftName.localeCompare(rightName));
}

/** Authors by how many of these PRs they merged, most first, then by name. */
export function authorCounts(pulls: readonly PullRequest[]): [string, number][] {
  const counts = new Map<string, number>();
  pulls.forEach((pull) => {
    const login = pull.author?.login;
    if (login != null) counts.set(login, (counts.get(login) ?? 0) + 1);
  });
  return ranked(counts);
}
