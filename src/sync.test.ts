import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { pullArbitrary } from './testing/arbitraries';
import { mergeSearch } from './sync';

const [a, b, c] = fc.sample(pullArbitrary, { numRuns: 3, seed: 7 }).map((pull, index) => ({ ...pull, id: `id-${index}` }));
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('mergeSearch', () => {
  test('null when the same PRs come back unchanged and in order', () => {
    expect(mergeSearch([a!, b!], [copy(a!), copy(b!)])).toBeNull();
  });

  test('a changed PR is replaced while the others keep their objects', () => {
    const changed = { ...copy(b!), checkState: b!.checkState === 'SUCCESS' ? ('FAILURE' as const) : ('SUCCESS' as const) };
    const merged = mergeSearch([a!, b!], [copy(a!), changed]);
    expect(merged?.[0]).toBe(a!);
    expect(merged?.[1]).toBe(changed);
  });

  test('new, missing and reordered PRs count as changes', () => {
    expect(mergeSearch([a!], [copy(a!), c!])).toEqual([a!, c!]);
    expect(mergeSearch([a!, b!], [copy(a!)])).toEqual([a!]);
    const reordered = mergeSearch([a!, b!], [copy(b!), copy(a!)]);
    expect(reordered?.[0]).toBe(b!);
    expect(reordered?.[1]).toBe(a!);
  });
});
