import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import type { PullRequest } from './github';
import { StableOrder } from './stable-order';

const pull = (id: string): PullRequest => ({ id }) as unknown as PullRequest;
const ids = (pulls: PullRequest[]): string[] => pulls.map((item) => item.id);

describe('StableOrder', () => {
  test('keeps shown order when scores reshuffle', () => {
    const order = new StableOrder();
    order.apply(['a', 'b', 'c', 'd'].map(pull), 'v', 0);
    expect(ids(order.apply(['d', 'c', 'b', 'a'].map(pull), 'v', 1))).toEqual(['a', 'b', 'c', 'd']);
  });

  test('removing a pull leaves the rest in place', () => {
    const order = new StableOrder();
    order.apply(['a', 'b', 'c', 'd'].map(pull), 'v', 0);
    expect(ids(order.apply(['d', 'a', 'c'].map(pull), 'v', 1))).toEqual(['a', 'c', 'd']);
  });

  test('new pulls slot in before the next known pull in the fresh ranking', () => {
    const order = new StableOrder();
    order.apply(['a', 'b', 'c'].map(pull), 'v', 0);
    expect(ids(order.apply(['a', 'n', 'b', 'c'].map(pull), 'v', 1))).toEqual(['a', 'n', 'b', 'c']);
    expect(ids(order.apply(['z', 'a', 'n', 'b', 'c'].map(pull), 'v', 2))).toEqual(['z', 'a', 'n', 'b', 'c']);
  });

  test('a view change or long idle re-sorts', () => {
    const order = new StableOrder();
    order.apply(['a', 'b'].map(pull), 'v', 0);
    expect(ids(order.apply(['b', 'a'].map(pull), 'other', 1))).toEqual(['b', 'a']);
    expect(ids(order.apply(['a', 'b'].map(pull), 'other', 11 * 60_000))).toEqual(['a', 'b']);
  });

  test('property: output is exactly the input set, and surviving pulls never swap', () => {
    const idSet = fc.uniqueArray(fc.constantFrom(...'abcdefghijklmnop'), { minLength: 1, maxLength: 16 });
    fc.assert(
      fc.property(idSet, idSet, (first, second) => {
        const order = new StableOrder();
        const before = ids(order.apply(first.map(pull), 'v', 0));
        const after = ids(order.apply(second.map(pull), 'v', 1));
        expect([...after].sort()).toEqual([...second].sort());
        const survivors = before.filter((id) => second.includes(id));
        expect(after.filter((id) => survivors.includes(id))).toEqual(survivors);
      }),
      { numRuns: 2_000 },
    );
  });
});
