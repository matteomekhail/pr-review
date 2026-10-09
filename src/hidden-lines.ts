import type { FileDiffMetadata } from '@pierre/diffs';
import type { ParsedFile } from './diffs';

/** Whether the diff hides unchanged lines that the file at head can fill in. */
export function hasHiddenLines({ diff }: Pick<ParsedFile, 'diff'>): boolean {
  return diff.isPartial && diff.hunks.length > 0 && (diff.type === 'change' || diff.type === 'rename-changed');
}

/**
 * The old side of a file, rebuilt from its new side and the patch: outside the hunks both sides are the same lines,
 * so one fetch per file is enough. Throws when the file does not match the patch (the branch moved since).
 */
export function oldContents(diff: FileDiffMetadata, newContents: string): string {
  const newLines = newContents === '' ? [] : newContents.split(/(?<=\n)/);
  const oldLines: string[] = [];
  let cursor = 0;
  for (const hunk of diff.hunks) {
    const start = hunk.additionStart - (hunk.additionCount === 0 ? 0 : 1);
    const end = start + hunk.additionCount;
    const patched = diff.additionLines.slice(hunk.additionLineIndex, hunk.additionLineIndex + hunk.additionCount).join('');
    if (start < cursor || end > newLines.length || newLines.slice(start, end).join('') !== patched) throw new Error(`${diff.name} at head does not match the diff`);
    oldLines.push(...newLines.slice(cursor, start));
    if (oldLines.length !== hunk.deletionStart - (hunk.deletionCount === 0 ? 0 : 1)) throw new Error(`${diff.name} does not line up with the diff`);
    oldLines.push(...diff.deletionLines.slice(hunk.deletionLineIndex, hunk.deletionLineIndex + hunk.deletionCount));
    cursor = end;
  }
  oldLines.push(...newLines.slice(cursor));
  return oldLines.join('');
}
