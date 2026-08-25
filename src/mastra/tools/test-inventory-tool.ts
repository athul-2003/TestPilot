import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { createTool } from '@mastra/core/tools';
import ts from 'typescript';
import { z } from 'zod';

import { TESTPILOT_CACHE_DIRNAME } from '../config.ts';
import { parseTypeScriptFile } from './ast-parse-tool.ts';
import { walkTypeScriptFiles } from './import-graph-tool.ts';

/**
 * Finds every test file in a repo and tags each as `unit`, `integration`, or
 * `e2e`. The impact agent needs this bucket before it
 * can reason sensibly: a unit test one hop from a changed file is a strong
 * `must-run` signal, but an e2e test the same one hop away is expensive
 * enough that the agent should think harder before including it.
 */

export const testTypeSchema = z.enum(['unit', 'integration', 'e2e']);

export const testFileSchema = z.object({
  path: z.string(),
  testType: testTypeSchema,
  classifiedBy: z
    .enum(['path', 'imports', 'default'])
    .describe(
      'Which rule decided testType: a filename/directory marker (most reliable), a known testing-library ' +
        'import (fallback), or the unit default (no signal found either way) — lets a human sanity-check a ' +
        'surprising classification instead of trusting it blindly.',
    ),
  testTitles: z
    .array(z.string())
    .describe('describe/it/test title strings found in the file, in source order — a cheap summary of what it covers.'),
});

export const testInventoryInputSchema = z.object({
  repoRoot: z.string().describe('Absolute path to the repository being analysed.'),
});

export const testInventoryOutputSchema = z.object({
  tests: z.array(testFileSchema),
  filesScanned: z.number().describe('Total .ts/.tsx files walked (test files are a subset of this).'),
  filesParsed: z
    .number()
    .describe('Subset of the test files that were freshly parsed rather than served from the on-disk cache.'),
});

export type TestType = z.infer<typeof testTypeSchema>;
export type TestFileInfo = z.infer<typeof testFileSchema>;
export type TestInventoryResult = z.infer<typeof testInventoryOutputSchema>;

/**
 * Test files by naming convention, across TypeScript and JavaScript alike.
 *
 * Convention rather than configuration: Testpilot never runs your tests, so
 * it has no test runner to ask. That also means the runner genuinely does
 * not matter — Vitest, Jest, Mocha, AVA and `node:test` all produce files
 * matching this shape, and Testpilot only reports which of them to run.
 */
const TEST_FILE_RE = /\.(test|spec)\.(?:tsx?|mts|cts|jsx?|mjs|cjs)$/;

// --- Classification --------------------------------------------------------

/**
 * A path segment or filename fragment bounded by `.`, `/`, or `-` (or string
 * start/end) — so "e2e" matches "src/e2e/x.test.ts" and "login.e2e.test.ts"
 * but not an incidental substring like "newe2etest.ts".
 */
function hasMarker(lowerPath: string, marker: string): boolean {
  return new RegExp(`(^|[./-])${marker}([./-]|$)`).test(lowerPath);
}

function classifyByPath(relPath: string): TestType | undefined {
  const lower = relPath.toLowerCase();
  if (hasMarker(lower, 'e2e')) return 'e2e';
  if (hasMarker(lower, 'integration')) return 'integration';
  return undefined;
}

const E2E_LIBRARIES = ['playwright', '@playwright/test', 'puppeteer', 'cypress', 'webdriverio'];
const INTEGRATION_LIBRARIES = ['supertest', 'testcontainers'];

function importsAny(specifiers: string[], libraries: string[]): boolean {
  return specifiers.some((s) => libraries.some((lib) => s === lib || s.startsWith(`${lib}/`)));
}

function classifyByImports(specifiers: string[]): TestType | undefined {
  if (importsAny(specifiers, E2E_LIBRARIES)) return 'e2e';
  if (importsAny(specifiers, INTEGRATION_LIBRARIES)) return 'integration';
  return undefined;
}

/**
 * Classifies a test file, preferring an explicit filename/path convention —
 * a developer who names a file `checkout.e2e.test.ts` is telling you exactly
 * what it is — and falling back to what it imports only when the path gives
 * no signal either way. Files matching neither rule default to `unit`,
 * which is the safe default: it's the bucket a human would assume in the
 * absence of any other information.
 */
export function classifyTestFile(
  relPath: string,
  importSpecifiers: string[],
): { testType: TestType; classifiedBy: TestFileInfo['classifiedBy'] } {
  const byPath = classifyByPath(relPath);
  if (byPath) return { testType: byPath, classifiedBy: 'path' };

  const byImports = classifyByImports(importSpecifiers);
  if (byImports) return { testType: byImports, classifiedBy: 'imports' };

  return { testType: 'unit', classifiedBy: 'default' };
}

// --- Test title extraction --------------------------------------------

const TEST_FUNCTION_NAMES = new Set(['describe', 'it', 'test']);

/**
 * Unwraps a call chain back to its root identifier — `describe`, from
 * `describe(...)`, `it.only(...)`, or even `describe.each([...])(...)`,
 * where the "call" being inspected is actually a call on the *result* of
 * another call. All three are real Vitest/Jest patterns.
 */
function rootCalleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return rootCalleeName(expr.expression);
  if (ts.isCallExpression(expr)) return rootCalleeName(expr.expression);
  return undefined;
}

/**
 * Walks the whole file (test titles can be arbitrarily nested inside
 * `describe` blocks, so a top-level-only scan would miss almost everything)
 * collecting the first string-literal argument of any `describe`/`it`/`test`
 * call, however it's wrapped (`.only`, `.skip`, `.each(...)`, ...).
 */
function extractTestTitles(sourceText: string, filePath: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const titles: string[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const rootName = rootCalleeName(node.expression);
      if (rootName && TEST_FUNCTION_NAMES.has(rootName)) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteral(arg)) titles.push(arg.text);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return titles;
}

// --- On-disk cache ---------------------------------------------------------
//
// Classifying a test file means reading it and parsing it twice — once for
// its imports, once for its describe/it titles. Nothing about that result
// changes while the file doesn't, so it's cached on disk exactly the way
// import-graph-tool.ts caches its parses: mtime first, content hash second.
// Without this, every triage run re-parsed every test file in the repo from
// scratch, even though the import graph running moments earlier in the same
// workflow had already cached its own parse of those same files.

const CACHE_VERSION = 1;

interface CacheFileEntry {
  mtimeMs: number;
  hash: string;
  testType: TestType;
  classifiedBy: TestFileInfo['classifiedBy'];
  testTitles: string[];
}

interface InventoryCacheFile {
  version: number;
  files: Record<string, CacheFileEntry>;
}

function loadCache(cachePath: string): InventoryCacheFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as InventoryCacheFile;
    if (parsed.version !== CACHE_VERSION) return { version: CACHE_VERSION, files: {} };
    return parsed;
  } catch {
    return { version: CACHE_VERSION, files: {} }; // missing, unreadable, or corrupt — rebuild from scratch
  }
}

function saveCache(cachePath: string, cache: InventoryCacheFile): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf8');
}

function hashContent(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

// --- Discovery -----------------------------------------------------------

/**
 * Walks the repo, finds every test file, and classifies each — reading from
 * and writing back to an on-disk cache so an unchanged test file isn't
 * re-parsed on the next run.
 *
 * Exported separately from the Mastra tool so it can be unit tested
 * directly, the same pattern used throughout this codebase. `cacheDir`
 * overrides where the cache lives, mainly so tests stay isolated from each
 * other — the same escape hatch `buildImportGraph` takes.
 */
export function buildTestInventory(repoRoot: string, cacheDir?: string): TestInventoryResult {
  const cachePath = path.join(cacheDir ?? path.join(repoRoot, TESTPILOT_CACHE_DIRNAME), 'test-inventory.json');
  const cache = loadCache(cachePath);

  const allFiles = walkTypeScriptFiles(repoRoot, TESTPILOT_CACHE_DIRNAME);
  const testFiles = allFiles.filter((f) => TEST_FILE_RE.test(f));

  const nextCacheFiles: Record<string, CacheFileEntry> = {};
  let filesParsed = 0;

  const tests: TestFileInfo[] = testFiles.map((relFile) => {
    const absFile = path.join(repoRoot, ...relFile.split('/'));
    const stat = fs.statSync(absFile);
    const cached = cache.files[relFile];

    let entry: CacheFileEntry;

    if (cached && cached.mtimeMs === stat.mtimeMs) {
      entry = cached;
    } else {
      const content = fs.readFileSync(absFile, 'utf8');
      const hash = hashContent(content);

      if (cached && cached.hash === hash) {
        // Touched but not actually changed — a fresh `git checkout` does this
        // to every file. Reuse the parse, record the new mtime.
        entry = { ...cached, mtimeMs: stat.mtimeMs };
      } else {
        const { imports } = parseTypeScriptFile(relFile, content);
        const { testType, classifiedBy } = classifyTestFile(
          relFile,
          imports.map((i) => i.specifier),
        );
        entry = {
          mtimeMs: stat.mtimeMs,
          hash,
          testType,
          classifiedBy,
          testTitles: extractTestTitles(content, relFile),
        };
        filesParsed++;
      }
    }

    nextCacheFiles[relFile] = entry;
    return { path: relFile, testType: entry.testType, classifiedBy: entry.classifiedBy, testTitles: entry.testTitles };
  });

  saveCache(cachePath, { version: CACHE_VERSION, files: nextCacheFiles });

  return { tests, filesScanned: allFiles.length, filesParsed };
}

export const testInventoryTool = createTool({
  id: 'test-inventory-tool',
  description:
    'Discovers every *.test.ts / *.spec.ts file in a repo and classifies each as unit, integration, or ' +
    'e2e — from its filename/path convention first, falling back to its imports, defaulting to unit. Also ' +
    'lists each file\'s describe/it/test titles as a cheap summary of what it covers.',
  inputSchema: testInventoryInputSchema,
  outputSchema: testInventoryOutputSchema,
  execute: async (inputData) => buildTestInventory(inputData.repoRoot),
});
