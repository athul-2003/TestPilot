import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildImportGraph,
  computeImpactedFiles,
  loadTsconfigAliases,
  resolveModuleSpecifier,
  type ImportGraph,
} from './import-graph-tool.ts';

const fixtureRoot = fileURLToPath(new URL('../../../fixtures/import-graph/', import.meta.url));

// A fresh cache directory per test keeps runs hermetic: nothing here should
// depend on, or leave behind, state from another test.
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(path.join(tmpdir(), 'testpilot-import-graph-'));
});

afterEach(() => {
  rmSync(cacheDir, { recursive: true, force: true });
});

describe('buildImportGraph + computeImpactedFiles, against the fixture tree', () => {
  it('finds direct and transitive dependents of a plain leaf file', () => {
    const graph = buildImportGraph(fixtureRoot, cacheDir);
    const [result] = computeImpactedFiles(graph, ['src/leaf.ts'], 6);

    expect(result!.found).toBe(true);
    expect(result!.isBarrel).toBe(false);
    expect(result!.depthLimitReached).toBe(false);

    const byFile = Object.fromEntries(result!.dependents.map((d) => [d.file, d]));

    // Direct importers of leaf.ts.
    expect(byFile['src/mid.ts']).toMatchObject({ depth: 1, throughBarrel: false });
    expect(byFile['src/external-consumer.ts']).toMatchObject({ depth: 1, throughBarrel: false });
    expect(byFile['src/dynamic-consumer.ts']).toMatchObject({ depth: 1, throughBarrel: false });
    expect(byFile['src/extensionless-consumer.ts']).toMatchObject({ depth: 1, throughBarrel: false });

    // entry.ts only reaches leaf.ts through mid.ts — two hops away.
    expect(byFile['src/entry.ts']).toMatchObject({ depth: 2, throughBarrel: false });

    expect(result!.dependents).toHaveLength(5);
  });

  it('does not create a graph edge for an external package import', () => {
    const graph = buildImportGraph(fixtureRoot, cacheDir);
    expect(graph.forward.get('src/external-consumer.ts')).toEqual(['src/leaf.ts']); // not 'zod'
  });

  it('resolves a tsconfig path alias', () => {
    const graph = buildImportGraph(fixtureRoot, cacheDir);
    const [result] = computeImpactedFiles(graph, ['lib/aliased.ts'], 6);

    expect(result!.found).toBe(true);
    expect(result!.dependents).toEqual([{ file: 'src/alias-consumer.ts', depth: 1, throughBarrel: false }]);
  });

  it('flags every hop through a barrel file, in both directions of the chain', () => {
    const graph = buildImportGraph(fixtureRoot, cacheDir);

    expect(graph.isBarrel.get('barrel/index.ts')).toBe(true);
    expect(graph.isBarrel.get('barrel/a.ts')).toBe(false);

    const [result] = computeImpactedFiles(graph, ['barrel/a.ts'], 6);
    const byFile = Object.fromEntries(result!.dependents.map((d) => [d.file, d]));

    // The barrel itself: one hop away, and it IS the barrel.
    expect(byFile['barrel/index.ts']).toMatchObject({ depth: 1, throughBarrel: true });
    // The consumer only ever sees the barrel, never a.ts directly — the
    // relationship is genuinely weaker than a direct import, and it's
    // flagged as such.
    expect(byFile['src/barrel-consumer.ts']).toMatchObject({ depth: 2, throughBarrel: true });
  });

  it('returns an empty dependents list for a file nothing imports', () => {
    const graph = buildImportGraph(fixtureRoot, cacheDir);
    const [result] = computeImpactedFiles(graph, ['src/entry.ts'], 6);

    expect(result).toEqual({
      file: 'src/entry.ts',
      found: true,
      isBarrel: false,
      dependents: [],
      depthLimitReached: false,
    });
  });

  it('reports found: false for a path that does not exist in the tree', () => {
    const graph = buildImportGraph(fixtureRoot, cacheDir);
    const [result] = computeImpactedFiles(graph, ['src/does-not-exist.ts'], 6);

    expect(result).toEqual({
      file: 'src/does-not-exist.ts',
      found: false,
      isBarrel: false,
      dependents: [],
      depthLimitReached: false,
    });
  });

  it('reuses the on-disk cache on a second run without re-parsing', () => {
    const first = buildImportGraph(fixtureRoot, cacheDir);
    expect(first.filesParsed).toBe(first.filesScanned); // cold cache: everything freshly parsed

    const second = buildImportGraph(fixtureRoot, cacheDir);
    expect(second.filesScanned).toBe(first.filesScanned);
    expect(second.filesParsed).toBe(0); // warm cache: nothing needed re-parsing
    expect(second.forward.get('src/mid.ts')).toEqual(first.forward.get('src/mid.ts'));
  });
});

describe('computeImpactedFiles, depth limiting', () => {
  // A hand-built four-link chain (d -> c -> b -> a), bypassing the file
  // system entirely, so the depth cap can be tested in isolation from
  // parsing and resolution.
  function chainGraph(): ImportGraph {
    return {
      forward: new Map([
        ['a.ts', []],
        ['b.ts', ['a.ts']],
        ['c.ts', ['b.ts']],
        ['d.ts', ['c.ts']],
      ]),
      isBarrel: new Map([
        ['a.ts', false],
        ['b.ts', false],
        ['c.ts', false],
        ['d.ts', false],
      ]),
      filesScanned: 4,
      filesParsed: 4,
    };
  }

  it('stops at maxDepth and signals that the result may be incomplete', () => {
    const [result] = computeImpactedFiles(chainGraph(), ['a.ts'], 1);

    expect(result!.dependents).toEqual([{ file: 'b.ts', depth: 1, throughBarrel: false }]);
    expect(result!.depthLimitReached).toBe(true);
  });

  it('finds the full chain when maxDepth covers it, with no limit flagged', () => {
    const [result] = computeImpactedFiles(chainGraph(), ['a.ts'], 6);

    expect(result!.dependents).toEqual([
      { file: 'b.ts', depth: 1, throughBarrel: false },
      { file: 'c.ts', depth: 2, throughBarrel: false },
      { file: 'd.ts', depth: 3, throughBarrel: false },
    ]);
    expect(result!.depthLimitReached).toBe(false);
  });
});

describe('resolveModuleSpecifier', () => {
  const existingFiles = new Set(['src/leaf.ts', 'src/utils/index.ts']);

  it('resolves a relative import missing its extension', () => {
    expect(resolveModuleSpecifier('src/mid.ts', './leaf', undefined, existingFiles)).toBe('src/leaf.ts');
  });

  it('resolves a relative import with an explicit extension', () => {
    expect(resolveModuleSpecifier('src/mid.ts', './leaf.ts', undefined, existingFiles)).toBe('src/leaf.ts');
  });

  it('resolves a directory import to its index.ts', () => {
    expect(resolveModuleSpecifier('src/mid.ts', './utils', undefined, existingFiles)).toBe('src/utils/index.ts');
  });

  it('leaves an external package specifier unresolved', () => {
    expect(resolveModuleSpecifier('src/mid.ts', 'zod', undefined, existingFiles)).toBeUndefined();
  });

  it('leaves an unresolvable relative import unresolved, rather than guessing', () => {
    expect(resolveModuleSpecifier('src/mid.ts', './does-not-exist', undefined, existingFiles)).toBeUndefined();
  });

  it('leaves a non-relative specifier unresolved when no alias config is present', () => {
    expect(resolveModuleSpecifier('src/mid.ts', '@lib/aliased', undefined, existingFiles)).toBeUndefined();
  });
});

describe('loadTsconfigAliases', () => {
  it('reads baseUrl and paths from the fixture tsconfig', () => {
    const alias = loadTsconfigAliases(fixtureRoot);
    expect(alias).toEqual({
      baseUrl: '.',
      entries: [{ prefix: '@lib/', hasWildcard: true, targets: ['lib/'] }],
    });
  });

  it('returns undefined when the repo has no tsconfig.json', () => {
    expect(loadTsconfigAliases(tmpdir())).toBeUndefined();
  });
});
