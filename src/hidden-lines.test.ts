import { describe, expect, test } from 'bun:test';
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePatchFiles } from '@pierre/diffs';
import { hasHiddenLines, oldContents } from './hidden-lines';

const dir = mkdtempSync(join(tmpdir(), 'hidden-lines-'));

/** The patch git (and so GitHub) prints for these two versions of one file. */
function gitPatch(before: string, after: string): string {
  writeFileSync(join(dir, 'before.ts'), before);
  writeFileSync(join(dir, 'after.ts'), after);
  const result = Bun.spawnSync(['git', 'diff', '--no-index', '--no-color', '-U3', 'before.ts', 'after.ts'], { cwd: dir });
  return result.stdout.toString();
}

/** One git run for many cases: each pair becomes case-N.ts in a before/ and an after/ folder. */
function gitPatches(cases: readonly { before: string; after: string }[]): string {
  const root = mkdtempSync(join(tmpdir(), 'hidden-lines-batch-'));
  mkdirSync(join(root, 'before'));
  mkdirSync(join(root, 'after'));
  cases.forEach(({ before, after }, index) => {
    writeFileSync(join(root, 'before', `case-${index}.ts`), before);
    writeFileSync(join(root, 'after', `case-${index}.ts`), after);
  });
  return Bun.spawnSync(['git', 'diff', '--no-index', '--no-color', '--no-renames', '-U3', 'before', 'after'], { cwd: root }).stdout.toString();
}

function parsed(before: string, after: string) {
  const file = parsePatchFiles(gitPatch(before, after), 'test')[0]?.files[0];
  if (file == null) throw new Error('no diff');
  return file;
}

const lines = (count: number, prefix = 'line'): string => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}\n`).join('');

describe('oldContents', () => {
  test('rebuilds the old file from the new one and the hunks', () => {
    const before = lines(60);
    const after = before.replace('line 10\n', 'line ten\n').replace('line 40\n', 'line 40\nadded\n');
    const diff = parsed(before, after);
    expect(diff.hunks.length).toBe(2);
    expect(oldContents(diff, after)).toBe(before);
  });

  test('matches git for any edit, with or without a final newline', () => {
    const edit = fc.record({ at: fc.nat(), remove: fc.nat({ max: 4 }), insert: fc.array(fc.constantFrom('x', 'y', '', '  z'), { maxLength: 4 }) });
    const scenario = fc.tuple(fc.integer({ min: 1, max: 80 }), fc.array(edit, { minLength: 1, maxLength: 5 }), fc.boolean(), fc.boolean());
    const cases = fc.sample(scenario, { numRuns: Number(process.env.PROPERTY_RUNS ?? 500), seed: 7 }).map(([size, edits, oldEndsInNewline, newEndsInNewline]) => {
      const original = Array.from({ length: size }, (_, index) => `line ${index + 1}`);
      const changed = [...original];
      for (const { at, remove, insert } of edits) changed.splice(at % (changed.length + 1), remove, ...insert);
      return { before: original.join('\n') + (oldEndsInNewline ? '\n' : ''), after: changed.join('\n') + (newEndsInNewline && changed.length > 0 ? '\n' : '') };
    });
    const diffs = new Map(parsePatchFiles(gitPatches(cases), 'test').flatMap((patch) => patch.files).map((file) => [file.name, file]));
    let checked = 0;
    cases.forEach(({ before, after }, index) => {
      const diff = diffs.get(`after/case-${index}.ts`);
      if (diff == null || after === '' || diff.hunks.length === 0) return;
      expect({ index, old: oldContents(diff, after) }).toEqual({ index, old: before });
      checked++;
    });
    expect(checked).toBeGreaterThan(cases.length / 2);
  });

  test('refuses a file that moved on since the diff', () => {
    const before = lines(30);
    const after = before.replace('line 15\n', 'line fifteen\n');
    const diff = parsed(before, after);
    expect(() => oldContents(diff, after.replace('line 16\n', 'line sixteen\n'))).toThrow();
    expect(() => oldContents(diff, lines(5))).toThrow();
  });
});

describe('hasHiddenLines', () => {
  test('only partial changes with hunks can expand', () => {
    expect(hasHiddenLines({ diff: parsed(lines(30), lines(30).replace('line 3\n', 'x\n')) })).toBe(true);
    const added = parsePatchFiles('diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+hi\n', 'n')[0]!.files[0]!;
    expect(hasHiddenLines({ diff: added })).toBe(false);
  });
});
