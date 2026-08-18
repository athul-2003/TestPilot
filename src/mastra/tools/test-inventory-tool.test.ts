import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildTestInventory, classifyTestFile } from './test-inventory-tool.ts';

const fixtureRoot = fileURLToPath(new URL('../../../fixtures/test-inventory/', import.meta.url));

describe('buildTestInventory, against the fixture tree', () => {
  it('finds every test file and none of the plain source files', () => {
    const result = buildTestInventory(fixtureRoot);
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
    const result = buildTestInventory(fixtureRoot);
    const math = result.tests.find((t) => t.path === 'src/math.test.ts')!;
    expect(math).toMatchObject({ testType: 'unit', classifiedBy: 'default' });
  });

  it('classifies by filename marker before ever looking at imports', () => {
    const result = buildTestInventory(fixtureRoot);

    const e2e = result.tests.find((t) => t.path === 'src/checkout.e2e.test.ts')!;
    expect(e2e).toMatchObject({ testType: 'e2e', classifiedBy: 'path' });

    const integration = result.tests.find((t) => t.path === 'src/api.integration.spec.ts')!;
    expect(integration).toMatchObject({ testType: 'integration', classifiedBy: 'path' });
  });

  it('falls back to import-based classification when the path gives no signal', () => {
    const result = buildTestInventory(fixtureRoot);

    // Neither filename contains "e2e" or "integration" — only the imports say what these are.
    const e2e = result.tests.find((t) => t.path === 'src/browser-flow.test.ts')!;
    expect(e2e).toMatchObject({ testType: 'e2e', classifiedBy: 'imports' });

    const integration = result.tests.find((t) => t.path === 'src/orders-api.test.ts')!;
    expect(integration).toMatchObject({ testType: 'integration', classifiedBy: 'imports' });
  });

  it('extracts nested and wrapped test titles in source order', () => {
    const result = buildTestInventory(fixtureRoot);
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
