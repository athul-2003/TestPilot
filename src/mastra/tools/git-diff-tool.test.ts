import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseUnifiedDiff } from './git-diff-tool.ts';

const fixturesDir = fileURLToPath(new URL('../../../fixtures/diffs/', import.meta.url));

function loadFixture(name: string): string {
  return readFileSync(`${fixturesDir}${name}`, 'utf8');
}

describe('parseUnifiedDiff', () => {
  it('parses a plain modification', () => {
    const result = parseUnifiedDiff(loadFixture('simple-modify.diff'));

    expect(result.truncated).toBe(false);
    expect(result.files).toHaveLength(1);

    const file = result.files[0]!;
    expect(file.path).toBe('src/utils/math.ts');
    expect(file.oldPath).toBeUndefined();
    expect(file.changeType).toBe('modified');
    expect(file.isBinary).toBe(false);
    expect(file.isTypeScript).toBe(true);
    expect(file.truncated).toBe(false);

    expect(file.hunks).toHaveLength(1);
    const hunk = file.hunks[0]!;
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 7, newStart: 1, newLines: 7 });
    expect(hunk.removedLines).toEqual(['  return a - b;']);
    expect(hunk.addedLines).toEqual(['  return a - b + 0;']);

    // Only the "return" line is actually added/removed — the enclosing
    // "export function subtract" line is unchanged context, so it's
    // correctly invisible to symbol extraction, which only scans changed
    // lines. Symbol detection on real declarations is covered by the
    // new-file, deleted-file, and rename fixtures below.
    expect(file.candidateSymbols).toEqual([]);
  });

  it('parses a new file, with oldStart/oldLines at zero', () => {
    const result = parseUnifiedDiff(loadFixture('new-file.diff'));

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe('src/utils/greet.ts');
    expect(file.changeType).toBe('added');
    expect(file.isTypeScript).toBe(true);

    const hunk = file.hunks[0]!;
    expect(hunk).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 });
    expect(file.candidateSymbols).toEqual(['greet']);
  });

  it('parses a deleted file, with newStart/newLines at zero', () => {
    const result = parseUnifiedDiff(loadFixture('deleted-file.diff'));

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.path).toBe('src/utils/legacy.ts');
    expect(file.changeType).toBe('deleted');

    const hunk = file.hunks[0]!;
    expect(hunk).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 0, newLines: 0 });
    expect(file.candidateSymbols).toEqual(['legacy']);
  });

  it('parses a rename, capturing both the old and new path', () => {
    const result = parseUnifiedDiff(loadFixture('rename-file.diff'));

    expect(result.files).toHaveLength(1);
    const file = result.files[0]!;
    expect(file.changeType).toBe('renamed');
    expect(file.oldPath).toBe('src/utils/old-name.ts');
    expect(file.path).toBe('src/utils/new-name.ts');

    // Symbols come from both the removed and added lines of the hunk.
    expect(file.candidateSymbols).toEqual(expect.arrayContaining(['oldName', 'newName']));
  });

  it('handles a non-TypeScript file and a binary file in the same diff', () => {
    const result = parseUnifiedDiff(loadFixture('non-ts-and-binary.diff'));

    expect(result.files).toHaveLength(2);

    const [manifest, logo] = result.files;
    expect(manifest).toMatchObject({
      path: 'package.json',
      changeType: 'modified',
      isBinary: false,
      isTypeScript: false,
    });
    // JSON has no function/class/const declarations to find.
    expect(manifest!.candidateSymbols).toEqual([]);

    expect(logo).toMatchObject({
      path: 'assets/logo.png',
      changeType: 'added',
      isBinary: true,
      isTypeScript: false,
      hunks: [],
      candidateSymbols: [],
    });
  });

  it('returns an empty result for an empty diff', () => {
    const result = parseUnifiedDiff('');
    expect(result).toEqual({ files: [], truncated: false, totalChars: 0 });
  });

  it('truncates files once the character ceiling is reached, and signals it', () => {
    const makeFileBlock = (path: string, contentLine: string) =>
      [
        `diff --git a/${path} b/${path}`,
        'index 0000000..1111111 100644',
        `--- a/${path}`,
        `+++ b/${path}`,
        '@@ -1,1 +1,1 @@',
        '-old',
        `+${contentLine}`,
      ].join('\n');

    const fileA = makeFileBlock('a.ts', 'x'.repeat(100));
    const fileB = makeFileBlock('b.ts', 'y'.repeat(100));
    const diff = [fileA, fileB].join('\n');

    // A ceiling smaller than fileA alone: the file that first crosses the
    // budget is still parsed in full — only files after it are skipped.
    // Otherwise the single largest file in a diff would starve every other
    // file of a chance to be seen at all.
    const result = parseUnifiedDiff(diff, 50);

    expect(result.truncated).toBe(true);

    const [a, b] = result.files;
    expect(a!.truncated).toBe(false);
    expect(a!.hunks).toHaveLength(1);

    expect(b!.truncated).toBe(true);
    expect(b!.hunks).toEqual([]);
    expect(b!.candidateSymbols).toEqual([]);
  });

  it('never truncates binary files, regardless of budget', () => {
    const diff = loadFixture('non-ts-and-binary.diff');
    const result = parseUnifiedDiff(diff, 1); // budget exhausted before file 1 even starts

    const logo = result.files.find((f) => f.path === 'assets/logo.png')!;
    expect(logo.truncated).toBe(false);
    expect(logo.isBinary).toBe(true);
  });
});
