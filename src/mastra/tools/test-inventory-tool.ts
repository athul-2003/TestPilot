import fs from 'node:fs';
import path from 'node:path';

import { createTool } from '@mastra/core/tools';
import ts from 'typescript';
import { z } from 'zod';

import { IMPORT_GRAPH_CACHE_DIRNAME } from '../config.ts';
import { parseTypeScriptFile } from './ast-parse-tool.ts';
import { walkTypeScriptFiles } from './import-graph-tool.ts';

/**
 * Finds every test file in a repo and tags each as `unit`, `integration`, or
 * `e2e`. The impact agent (Phase 3's other half) needs this bucket before it
 * can reason sensibly: a unit test one hop from a changed file is a strong
 * `must-run` signal, but an e2e test the same one hop away is expensive
 * enough that the agent should think harder before including it.
 */

const testTypeSchema = z.enum(['unit', 'integration', 'e2e']);

const testFileSchema = z.object({
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
});

export type TestType = z.infer<typeof testTypeSchema>;
export type TestFileInfo = z.infer<typeof testFileSchema>;
export type TestInventoryResult = z.infer<typeof testInventoryOutputSchema>;

const TEST_FILE_RE = /\.(test|spec)\.tsx?$/;

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

// --- Discovery -----------------------------------------------------------

/**
 * Walks the repo, finds every test file, and classifies each.
 *
 * Exported separately from the Mastra tool so it can be unit tested
 * directly, the same pattern used throughout this codebase.
 */
export function buildTestInventory(repoRoot: string): TestInventoryResult {
  const allFiles = walkTypeScriptFiles(repoRoot, IMPORT_GRAPH_CACHE_DIRNAME);
  const testFiles = allFiles.filter((f) => TEST_FILE_RE.test(f));

  const tests: TestFileInfo[] = testFiles.map((relFile) => {
    const absFile = path.join(repoRoot, ...relFile.split('/'));
    const content = fs.readFileSync(absFile, 'utf8');

    const { imports } = parseTypeScriptFile(relFile, content);
    const { testType, classifiedBy } = classifyTestFile(
      relFile,
      imports.map((i) => i.specifier),
    );
    const testTitles = extractTestTitles(content, relFile);

    return { path: relFile, testType, classifiedBy, testTitles };
  });

  return { tests, filesScanned: allFiles.length };
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
