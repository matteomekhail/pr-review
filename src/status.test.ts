import { describe, expect, test } from 'bun:test';
import type { FailingCheck } from './github';
import { pullArbitrary } from './testing/arbitraries';
import fc from 'fast-check';
import { describeFailingChecks } from './status';

const withChecks = (failingChecks: FailingCheck[]) => ({ ...fc.sample(pullArbitrary, { numRuns: 1, seed: 1 })[0]!, failingChecks });

describe('describeFailingChecks', () => {
  test('puts real failures first and says how the others ended', () => {
    expect(describeFailingChecks(withChecks([{ name: 'Slack', outcome: 'CANCELLED' }, { name: 'e2e', outcome: 'TIMED_OUT' }, { name: 'lint', outcome: 'FAILURE' }]))).toBe('lint · e2e (timed out) · Slack (cancelled)');
  });

  test('lists four, then counts the rest', () => {
    const checks = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => ({ name, outcome: 'FAILURE' }));
    expect(describeFailingChecks(withChecks(checks))).toBe('a · b · c · d · +2 more');
  });

  test('empty when nothing is listed', () => {
    expect(describeFailingChecks(withChecks([]))).toBe('');
  });
});
