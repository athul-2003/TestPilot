import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { MAX_DIFF_CHARS } from '../config.ts';

/**
 * A **Zod schema** describes the shape of data and validates it at runtime —
 * Mastra uses it both to check inputs before a tool runs and to tell the
 * model what shape to produce. `z.object({...})` is a plain JS object with
 * typed fields; `.describe()` attaches a human-readable hint the model sees.
 */

const changeTypeSchema = z.enum(['added', 'modified', 'deleted', 'renamed']);

const hunkSchema = z.object({
  oldStart: z.number().describe('First line number in the pre-change file.'),
  oldLines: z.number().describe('Line count the hunk covers in the pre-change file.'),
  newStart: z.number().describe('First line number in the post-change file.'),
  newLines: z.number().describe('Line count the hunk covers in the post-change file.'),
  addedLines: z.array(z.string()).describe('Content of every added ("+") line, prefix stripped.'),
  removedLines: z.array(z.string()).describe('Content of every removed ("-") line, prefix stripped.'),
});

const fileChangeSchema = z.object({
  path: z.string().describe('Current path of the file (post-change; the pre-change path for deletions).'),
  oldPath: z.string().optional().describe('Present only when changeType is "renamed" — the path before the rename.'),
  changeType: changeTypeSchema,
  isBinary: z.boolean().describe('True for binary files, which carry no readable hunks.'),
  isTypeScript: z.boolean().describe('True for .ts/.tsx files — the files this tool can usefully reason about.'),
  hunks: z.array(hunkSchema).describe('Empty for binary files, or for files skipped by truncation.'),
  candidateSymbols: z
    .array(z.string())
    .describe(
      'Function/class/type/const names touched by this diff, found via pattern matching on the raw text. ' +
        'These are CANDIDATES, not authoritative — regex over diff text cannot see the whole file, so it ' +
        'misses renamed-but-unchanged signatures and can pick up false positives inside strings or comments. ' +
        'Phase 2 resolves the real symbol set from the AST.',
    ),
  truncated: z
    .boolean()
    .describe('True when this file was past the size ceiling and its hunks were not parsed.'),
});

export const gitDiffInputSchema = z.object({
  diff: z.string().describe('A unified diff, such as the output of `git diff <merge-base> HEAD`.'),
});

export const gitDiffOutputSchema = z.object({
  files: z.array(fileChangeSchema),
  truncated: z.boolean().describe('True if any file in the diff was truncated.'),
  totalChars: z.number().describe('Length of the raw diff string that was parsed.'),
});

export type Hunk = z.infer<typeof hunkSchema>;
export type FileChange = z.infer<typeof fileChangeSchema>;
export type GitDiffResult = z.infer<typeof gitDiffOutputSchema>;

// --- Parsing -----------------------------------------------------------
//
// A unified diff is plain text, not a data format with a library-grade
// parser everyone agrees on — so this reads it by hand, one file block at a
// time. The format, for reference:
//
//   diff --git a/old/path b/new/path
//   <metadata lines: new/deleted file mode, rename from/to, index, ...>
//   --- a/old/path            (or /dev/null for a new file)
//   +++ b/new/path            (or /dev/null for a deleted file)
//   @@ -oldStart,oldLines +newStart,newLines @@ optional context
//    context line (unchanged)
//   -removed line
//   +added line
//
// Binary files skip the --- / +++ / @@ lines entirely and instead have a
// single "Binary files a/x and b/y differ" line.

const FILE_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;
const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BINARY_PREFIX = 'Binary files ';
const BINARY_SUFFIX = ' differ';

const TS_EXTENSIONS = new Set(['.ts', '.tsx']);

function isTypeScriptPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot !== -1 && TS_EXTENSIONS.has(path.slice(dot));
}

/**
 * Candidate patterns for top-level TypeScript declarations. Deliberately
 * conservative: matched against individual added/removed lines, with no
 * knowledge of the surrounding file, so nesting (a method inside a class) is
 * out of reach here. That's fine — the point of this tool is a fast first
 * pass; Phase 2's AST parse is what makes the symbol list trustworthy.
 */
const SYMBOL_PATTERNS: RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/,
];

function extractCandidateSymbols(lines: string[]): string[] {
  const found = new Set<string>();
  for (const line of lines) {
    for (const pattern of SYMBOL_PATTERNS) {
      const match = pattern.exec(line);
      if (match?.[1]) {
        found.add(match[1]);
        break;
      }
    }
  }
  return [...found];
}

/** Splits a full diff into per-file chunks, each starting at its `diff --git` line. */
function splitIntoFileBlocks(diff: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] | undefined;

  // Split on \n and drop a trailing \r rather than splitting on /\r?\n/: a
  // diff can legitimately contain a lone \r as *content* inside an added or
  // removed line (a file that itself uses CR line endings), and only \n is
  // guaranteed to be the diff's own line separator. Stripping \r here, once,
  // means every downstream line comparison — header markers, hunk prefixes,
  // symbol regexes — never has to think about it again. This matters in
  // practice, not just in theory: on a Windows checkout with the common
  // `core.autocrlf=true` setting, `git diff` output is CRLF-terminated by
  // default.
  for (const rawLine of diff.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (FILE_HEADER_RE.test(line)) {
      current = [line];
      blocks.push(current);
    } else if (current) {
      current.push(line);
    }
    // Lines before the first "diff --git" (e.g. a stray commit message
    // pasted above the diff) have nowhere to go and are dropped.
  }

  return blocks;
}

interface ParsedHeader {
  path: string;
  oldPath?: string;
  changeType: FileChange['changeType'];
  isBinary: boolean;
  /** Index into `lines` where hunk content begins. */
  bodyStartIndex: number;
}

function parseFileHeader(lines: string[]): ParsedHeader {
  const headerMatch = FILE_HEADER_RE.exec(lines[0] ?? '');
  // Paths with spaces are quoted by git and this simple split does not
  // unquote them — a known limitation. The --- / +++ / rename lines below
  // are the authoritative source whenever they're present; this guess is
  // only the fallback for binary diffs, which have no --- / +++ lines.
  const guessOld = headerMatch?.[1];
  const guessNew = headerMatch?.[2];

  let isNewFile = false;
  let isDeletedFile = false;
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let leftPath: string | undefined;
  let leftIsDevNull = false;
  let rightPath: string | undefined;
  let rightIsDevNull = false;
  let isBinary = false;
  let bodyStartIndex = lines.length;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';

    if (line.startsWith('new file mode')) {
      isNewFile = true;
    } else if (line.startsWith('deleted file mode')) {
      isDeletedFile = true;
    } else if (line.startsWith('rename from ')) {
      renameFrom = line.slice('rename from '.length);
    } else if (line.startsWith('rename to ')) {
      renameTo = line.slice('rename to '.length);
    } else if (line.startsWith(BINARY_PREFIX) && line.endsWith(BINARY_SUFFIX)) {
      isBinary = true;
      const middle = line.slice(BINARY_PREFIX.length, -BINARY_SUFFIX.length);
      const [left, right] = middle.split(' and ');
      if (left === '/dev/null') leftIsDevNull = true;
      else leftPath = left?.replace(/^a\//, '');
      if (right === '/dev/null') rightIsDevNull = true;
      else rightPath = right?.replace(/^b\//, '');
      bodyStartIndex = i + 1;
      break;
    } else if (line === '--- /dev/null') {
      leftIsDevNull = true;
    } else if (line.startsWith('--- a/')) {
      leftPath = line.slice('--- a/'.length);
    } else if (line === '+++ /dev/null') {
      rightIsDevNull = true;
      bodyStartIndex = i + 1;
      break;
    } else if (line.startsWith('+++ b/')) {
      rightPath = line.slice('+++ b/'.length);
      bodyStartIndex = i + 1;
      break;
    }
  }

  if (renameFrom && renameTo) {
    return {
      path: renameTo,
      oldPath: renameFrom,
      changeType: 'renamed',
      isBinary,
      bodyStartIndex,
    };
  }
  if (isNewFile || leftIsDevNull) {
    return {
      path: rightPath ?? guessNew ?? guessOld ?? 'unknown',
      changeType: 'added',
      isBinary,
      bodyStartIndex,
    };
  }
  if (isDeletedFile || rightIsDevNull) {
    return {
      path: leftPath ?? guessOld ?? guessNew ?? 'unknown',
      changeType: 'deleted',
      isBinary,
      bodyStartIndex,
    };
  }
  return {
    path: rightPath ?? guessNew ?? guessOld ?? 'unknown',
    changeType: 'modified',
    isBinary,
    bodyStartIndex,
  };
}

function parseHunks(lines: string[], startIndex: number): { hunks: Hunk[]; changedLines: string[] } {
  const hunks: Hunk[] = [];
  const changedLines: string[] = [];
  let current: Hunk | undefined;

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const headerMatch = HUNK_HEADER_RE.exec(line);

    if (headerMatch) {
      current = {
        // A hunk header omits the count when it's 1, e.g. "@@ -5 +5 @@".
        oldStart: Number(headerMatch[1]),
        oldLines: headerMatch[2] !== undefined ? Number(headerMatch[2]) : 1,
        newStart: Number(headerMatch[3]),
        newLines: headerMatch[4] !== undefined ? Number(headerMatch[4]) : 1,
        addedLines: [],
        removedLines: [],
      };
      hunks.push(current);
      continue;
    }

    if (!current) continue; // stray line before any hunk header

    if (line.startsWith('+') && !line.startsWith('+++')) {
      const content = line.slice(1);
      current.addedLines.push(content);
      changedLines.push(content);
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      const content = line.slice(1);
      current.removedLines.push(content);
      changedLines.push(content);
    }
    // Context lines (leading space) and "\ No newline at end of file"
    // carry no change information and are skipped.
  }

  return { hunks, changedLines };
}

/**
 * Parses a unified diff into structured per-file changes.
 *
 * Exported separately from the tool so it can be unit tested directly,
 * without going through Mastra's tool-execution machinery.
 */
export function parseUnifiedDiff(diff: string, maxChars: number = MAX_DIFF_CHARS): GitDiffResult {
  const totalChars = diff.length;
  const blocks = splitIntoFileBlocks(diff);

  const files: FileChange[] = [];
  let consumedChars = 0;
  let anyTruncated = false;

  for (const block of blocks) {
    const header = parseFileHeader(block);
    const overBudget = consumedChars >= maxChars;

    let hunks: Hunk[] = [];
    let candidateSymbols: string[] = [];
    let fileTruncated = false;

    if (header.isBinary) {
      // No textual content to parse or extract symbols from, regardless of budget.
    } else if (overBudget) {
      fileTruncated = true;
      anyTruncated = true;
    } else {
      const parsed = parseHunks(block, header.bodyStartIndex);
      hunks = parsed.hunks;
      candidateSymbols = extractCandidateSymbols(parsed.changedLines);
      consumedChars += block.join('\n').length;
    }

    files.push({
      path: header.path,
      oldPath: header.oldPath,
      changeType: header.changeType,
      isBinary: header.isBinary,
      isTypeScript: isTypeScriptPath(header.path),
      hunks,
      candidateSymbols,
      truncated: fileTruncated,
    });
  }

  return { files, truncated: anyTruncated, totalChars };
}

/**
 * The Mastra tool wrapping the parser above.
 *
 * A tool's `execute` receives the already-validated input as its first
 * argument (`inputData`, matching `inputSchema`) and an optional execution
 * context as its second — different from a workflow step's `execute`, which
 * takes one destructured object. Mixing the two up is the most common wiring
 * mistake in Mastra code.
 */
export const gitDiffTool = createTool({
  id: 'git-diff-tool',
  description:
    'Parses a unified diff (the output of `git diff`) into structured per-file changes: change type, ' +
    'hunks, and candidate symbol names touched by the change. Truncates per-file past a size ceiling and ' +
    'signals it, rather than silently reasoning over a partial diff.',
  inputSchema: gitDiffInputSchema,
  outputSchema: gitDiffOutputSchema,
  execute: async (inputData) => parseUnifiedDiff(inputData.diff),
});
