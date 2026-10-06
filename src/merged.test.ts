import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { pullArbitrary } from './testing/arbitraries';
import { authorCounts, localIso, mergedSince } from './merged';

describe('mergedSince', () => {
  const wednesday = new Date(2026, 9, 7, 15, 42);

  test('today and this week start at my midnight, the week on Monday', () => {
    expect(mergedSince('today', wednesday)).toStartWith('2026-10-07T00:00:00');
    expect(mergedSince('week', wednesday)).toStartWith('2026-10-05T00:00:00');
    expect(mergedSince('week', new Date(2026, 9, 11, 9, 0))).toStartWith('2026-10-05T00:00:00');
    expect(mergedSince('week', new Date(2026, 9, 5, 9, 0))).toStartWith('2026-10-05T00:00:00');
  });

  test('rolling periods count back from now', () => {
    expect(Date.parse(mergedSince('7d', wednesday))).toBe(wednesday.getTime() - 7 * 86_400_000);
    expect(Date.parse(mergedSince('30d', wednesday))).toBe(wednesday.getTime() - 30 * 86_400_000);
  });

  test('local times carry my offset and parse back to the same instant', () => {
    expect(localIso(wednesday)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00[+-]\d{2}:\d{2}$/);
    expect(Date.parse(localIso(wednesday))).toBe(wednesday.getTime());
  });
});

describe('authorCounts', () => {
  test('most merges first, ties by name', () => {
    const [a, b, c, d] = fc.sample(pullArbitrary, { numRuns: 4, seed: 3 });
    const by = (login: string, pull: typeof a) => ({ ...pull!, author: { login, avatarUrl: '' } });
    expect(authorCounts([by('zoe', a), by('ann', b), by('zoe', c), by('bob', d)])).toEqual([['zoe', 2], ['ann', 1], ['bob', 1]]);
  });
});
