import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { buildPromptPayload, selectTests, testSelectionOutputSchema, type TestSelectionResult } from './impact-agent.ts';
import type { StructuredGenerator } from './structured-generator.ts';

const fixtureRoot = fileURLToPath(new URL('../../../fixtures/impact-agent/', import.meta.url));
const diffsDir = fileURLToPath(new URL('../../../fixtures/impact-agent/diffs/', import.meta.url));

function loadDiff(name: string): string {
  return readFileSync(`${diffsDir}${name}`, 'utf8');
}

// These tests never touch a real model — `selectTests` takes the agent as a
// parameter specifically so a fake can stand in here. Real model calls are
// slow, cost real (if small) money, and would make `npm test` depend on a
// network connection and an API key just to run the suite; verifying the
// actual agent's judgement is a manual step during phase sign-off, not
// something the automated test suite should be doing on every run.
function fakeGenerator(object: TestSelectionResult): StructuredGenerator<typeof testSelectionOutputSchema> {
  return {
    generate: async () => ({ object, usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }),
  };
}

describe('buildPromptPayload', () => {
  it('correlates a changed file with its graph-reachable tests, at the correct depth', () => {
    const payload = buildPromptPayload(fixtureRoot, loadDiff('change-calc.diff'), 6);

    expect(payload.changedFiles).toEqual([
      { path: 'src/calc.ts', changeType: 'modified', isTypeScript: true, candidateSymbols: [] },
    ]);

    const byPath = Object.fromEntries(payload.tests.map((t) => [t.path, t]));

    // Direct: calc.test.ts imports calc.ts itself.
    expect(byPath['src/calc.test.ts']!.directlyChanged).toBe(false);
    expect(byPath['src/calc.test.ts']!.reachableFrom).toEqual([
      { changedFile: 'src/calc.ts', depth: 1, throughBarrel: false },
    ]);

    // Transitive: calc-user.test.ts imports calc-user.ts, which imports calc.ts.
    expect(byPath['src/calc-user.test.ts']!.reachableFrom).toEqual([
      { changedFile: 'src/calc.ts', depth: 2, throughBarrel: false },
    ]);

    // Unrelated: nothing connects unrelated.test.ts to the changed file.
    expect(byPath['src/unrelated.test.ts']!.reachableFrom).toEqual([]);
  });

  it('flags a test file as directly changed when the diff edits the test itself', () => {
    const payload = buildPromptPayload(fixtureRoot, loadDiff('change-calc-test.diff'), 6);
    const byPath = Object.fromEntries(payload.tests.map((t) => [t.path, t]));

    expect(byPath['src/calc.test.ts']!.directlyChanged).toBe(true);
    // Nothing imports calc.test.ts, so the graph itself shows no reach —
    // directlyChanged is what should actually drive the classification here.
    expect(byPath['src/calc.test.ts']!.reachableFrom).toEqual([]);
  });

  it('includes every test in the inventory, reachable or not', () => {
    const payload = buildPromptPayload(fixtureRoot, loadDiff('change-calc.diff'), 6);
    const paths = payload.tests.map((t) => t.path).sort();
    expect(paths).toEqual(['src/calc-user.test.ts', 'src/calc.test.ts', 'src/unrelated.test.ts']);
  });
});

describe('selectTests', () => {
  it('returns the model\'s selections and records token usage and latency', async () => {
    const fake = fakeGenerator({
      selections: [
        { path: 'src/calc.test.ts', bucket: 'must-run', rationale: 'Directly imports the changed function.', confidence: 0.95 },
        { path: 'src/calc-user.test.ts', bucket: 'should-run', rationale: 'Reaches the change through one intermediate file.', confidence: 0.7 },
        { path: 'src/unrelated.test.ts', bucket: 'skip', rationale: 'Covers unrelated.ts, which this diff never touches.', confidence: 0.9 },
      ],
    });

    const result = await selectTests({ repoRoot: fixtureRoot, diff: loadDiff('change-calc.diff') }, fake);

    expect(result.selections).toHaveLength(3);
    expect(result.warnings).toEqual([]);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('warns about a test the model forgot, without dropping the ones it did return', async () => {
    const fake = fakeGenerator({
      selections: [
        { path: 'src/calc.test.ts', bucket: 'must-run', rationale: 'Directly imports the changed function.', confidence: 0.95 },
        // calc-user.test.ts and unrelated.test.ts are both missing.
      ],
    });

    const result = await selectTests({ repoRoot: fixtureRoot, diff: loadDiff('change-calc.diff') }, fake);

    expect(result.selections).toHaveLength(1);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('src/calc-user.test.ts'),
        expect.stringContaining('src/unrelated.test.ts'),
      ]),
    );
  });

  it('warns about a hallucinated path that was never in the inventory', async () => {
    const fake = fakeGenerator({
      selections: [
        { path: 'src/calc.test.ts', bucket: 'must-run', rationale: 'x', confidence: 0.9 },
        { path: 'src/calc-user.test.ts', bucket: 'should-run', rationale: 'x', confidence: 0.6 },
        { path: 'src/unrelated.test.ts', bucket: 'skip', rationale: 'x', confidence: 0.9 },
        { path: 'src/does-not-exist.test.ts', bucket: 'must-run', rationale: 'x', confidence: 0.5 },
      ],
    });

    const result = await selectTests({ repoRoot: fixtureRoot, diff: loadDiff('change-calc.diff') }, fake);

    expect(result.warnings).toEqual([expect.stringContaining('src/does-not-exist.test.ts')]);
  });
});
