import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildTestInventory, classifyTestFile } from './test-inventory-tool.ts';

const fixtureRoot = fileURLToPath(new URL('../../../fixtures/test-inventory/', import.meta.url));

// A fresh cache directory per test keeps runs hermetic — nothing here should
// depend on, or leave behind, another test's cached parses.
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'testpilot-inventory-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('buildTestInventory, against the fixture tree', () => {
  it('finds every test file and none of the plain source files', () => {
    const result = buildTestInventory(fixtureRoot, cacheDir);
    const paths = result.tests.map((t) => t.path).sort();

    expect(paths).toEqual([
      'src/api.integration.spec.ts',
      'src/browser-flow.test.ts',
      'src/checkout.e2e.test.ts',
      'src/math.test.ts',
      'src/nested-titles.test.ts',
      'src/orders-api.test.ts',
    ]);
    // src/math.ts (not a test) was walked but correctly excluded from `tests`.
    expect(result.filesScanned).toBe(paths.length + 1);
  });

  it('classifies a plain test as unit by default', () => {
    const result = buildTestInventory(fixtureRoot, cacheDir);
    const math = result.tests.find((t) => t.path === 'src/math.test.ts')!;
    expect(math).toMatchObject({ testType: 'unit', classifiedBy: 'default' });
  });

  it('classifies by filename marker before ever looking at imports', () => {
    const result = buildTestInventory(fixtureRoot, cacheDir);

    const e2e = result.tests.find((t) => t.path === 'src/checkout.e2e.test.ts')!;
    expect(e2e).toMatchObject({ testType: 'e2e', classifiedBy: 'path' });

    const integration = result.tests.find((t) => t.path === 'src/api.integration.spec.ts')!;
    expect(integration).toMatchObject({ testType: 'integration', classifiedBy: 'path' });
  });

  it('falls back to import-based classification when the path gives no signal', () => {
    const result = buildTestInventory(fixtureRoot, cacheDir);

    // Neither filename contains "e2e" or "integration" — only the imports say what these are.
    const e2e = result.tests.find((t) => t.path === 'src/browser-flow.test.ts')!;
    expect(e2e).toMatchObject({ testType: 'e2e', classifiedBy: 'imports' });

    const integration = result.tests.find((t) => t.path === 'src/orders-api.test.ts')!;
    expect(integration).toMatchObject({ testType: 'integration', classifiedBy: 'imports' });
  });

  it('extracts nested and wrapped test titles in source order', () => {
    const result = buildTestInventory(fixtureRoot, cacheDir);
    const nested = result.tests.find((t) => t.path === 'src/nested-titles.test.ts')!;

    expect(nested.testTitles).toEqual([
      'outer',
      'does the basic thing',
      'inner',
      'does the focused thing', // it.only(...)
      'table case %i', // describe.each([...])(...)
      'handles the case',
    ]);
  });

  it('reuses the on-disk cache on a second run without re-parsing', () => {
    const first = buildTestInventory(fixtureRoot, cacheDir);
    expect(first.filesParsed).toBe(first.tests.length); // cold cache: every test file freshly parsed

    const second = buildTestInventory(fixtureRoot, cacheDir);
    expect(second.filesParsed).toBe(0); // warm cache: nothing needed re-parsing
    expect(second.tests).toEqual(first.tests);
  });

  it('discovers JavaScript test files, not only TypeScript ones', () => {
    // Testpilot never runs your tests, so the runner is irrelevant — but the
    // *language* was, until this: a plain JavaScript project matched nothing
    // and got an empty inventory.
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'testpilot-inventory-js-'));
    try {
      mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
      const files = {
        'math.test.js': "describe('math', () => { it('adds', () => {}); });",
        'cart.spec.jsx': "describe('cart', () => { it('totals', () => {}); });",
        'util.test.mjs': "describe('util', () => { it('works', () => {}); });",
        'legacy.test.cjs': "describe('legacy', () => { it('still works', () => {}); });",
        'notatest.js': 'export const x = 1;',
      };
      for (const [name, body] of Object.entries(files)) {
        writeFileSync(path.join(repoRoot, 'src', name), body);
      }

      const result = buildTestInventory(repoRoot, cacheDir);
      expect(result.tests.map((t) => t.path).sort()).toEqual([
        'src/cart.spec.jsx',
        'src/legacy.test.cjs',
        'src/math.test.js',
        'src/util.test.mjs',
      ]);
      // Titles are extracted from JavaScript exactly as from TypeScript.
      expect(result.tests.find((t) => t.path === 'src/math.test.js')!.testTitles).toEqual(['math', 'adds']);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('re-parses a test file whose contents actually changed', () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'testpilot-inventory-repo-'));
    try {
      const testFile = path.join(repoRoot, 'src', 'sample.test.ts');
      mkdirSync(path.dirname(testFile), { recursive: true });
      writeFileSync(testFile, "import { describe, it } from 'vitest';\ndescribe('before', () => { it('a', () => {}); });\n");

      const first = buildTestInventory(repoRoot, cacheDir);
      expect(first.filesParsed).toBe(1);
      expect(first.tests[0]!.testTitles).toEqual(['before', 'a']);

      writeFileSync(testFile, "import { describe, it } from 'vitest';\ndescribe('after', () => { it('b', () => {}); });\n");

      const second = buildTestInventory(repoRoot, cacheDir);
      expect(second.filesParsed).toBe(1); // genuinely changed — the cache must not be trusted
      expect(second.tests[0]!.testTitles).toEqual(['after', 'b']);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});

describe('classifyTestFile', () => {
  it('prefers the path marker even when imports would suggest a different type', () => {
    // A file path-marked as e2e that also happens to import a supertest-style
    // library should still resolve to e2e — path is the developer's explicit
    // intent and always wins.
    const result = classifyTestFile('src/checkout.e2e.test.ts', ['supertest']);
    expect(result).toEqual({ testType: 'e2e', classifiedBy: 'path' });
  });

  it('matches a scoped package like @playwright/test', () => {
    const result = classifyTestFile('src/flow.test.ts', ['@playwright/test']);
    expect(result).toEqual({ testType: 'e2e', classifiedBy: 'imports' });
  });

  it('does not false-positive on an unrelated substring match', () => {
    // "newe2etest.ts" contains the letters "e2e" but not as a bounded segment.
    const result = classifyTestFile('src/newe2etest.test.ts', []);
    expect(result).toEqual({ testType: 'unit', classifiedBy: 'default' });
  });
});
