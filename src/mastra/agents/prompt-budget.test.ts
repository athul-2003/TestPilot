import { describe, expect, it } from 'vitest';

import type { PromptPayload, PromptTest } from './impact-agent.ts';
import { applyPromptBudget, estimateTokens, rankTestsByPriority, testPriority } from './prompt-budget.ts';

function makeTest(overrides: Partial<PromptTest> & { path: string }): PromptTest {
  return {
    testType: 'unit',
    testTitles: ['does a thing'],
    directlyChanged: false,
    reachableFrom: [],
    ...overrides,
  };
}

function makePayload(tests: PromptTest[], impact: PromptPayload['impact'] = []): PromptPayload {
  return {
    changedFiles: [{ path: 'src/changed.ts', changeType: 'modified', isTypeScript: true, candidateSymbols: ['doThing'] }],
    impact,
    tests,
  };
}

describe('estimateTokens', () => {
  it('scales with length and never returns a fraction', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2); // rounds up rather than under-counting
    expect(estimateTokens('x'.repeat(4000))).toBe(1000);
  });
});

describe('testPriority', () => {
  it('ranks a directly-changed test above everything else', () => {
    expect(testPriority(makeTest({ path: 'a.test.ts', directlyChanged: true }))).toBe(0);
  });

  it('uses the shortest path when a test is reachable by several routes', () => {
    const test = makeTest({
      path: 'a.test.ts',
      reachableFrom: [
        { changedFile: 'src/x.ts', depth: 4, throughBarrel: false },
        { changedFile: 'src/y.ts', depth: 2, throughBarrel: false },
      ],
    });
    expect(testPriority(test)).toBe(2);
  });

  it('ranks an unreachable test last', () => {
    expect(testPriority(makeTest({ path: 'a.test.ts' }))).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('rankTestsByPriority', () => {
  it('orders directly-changed, then by depth, then unreachable', () => {
    const ranked = rankTestsByPriority([
      makeTest({ path: 'unreachable.test.ts' }),
      makeTest({ path: 'deep.test.ts', reachableFrom: [{ changedFile: 'src/x.ts', depth: 5, throughBarrel: false }] }),
      makeTest({ path: 'edited.test.ts', directlyChanged: true }),
      makeTest({ path: 'near.test.ts', reachableFrom: [{ changedFile: 'src/x.ts', depth: 1, throughBarrel: false }] }),
    ]);

    expect(ranked.map((t) => t.path)).toEqual([
      'edited.test.ts',
      'near.test.ts',
      'deep.test.ts',
      'unreachable.test.ts',
    ]);
  });

  it('is deterministic for equal priorities, so the same diff builds the same prompt', () => {
    const tests = [makeTest({ path: 'b.test.ts' }), makeTest({ path: 'a.test.ts' }), makeTest({ path: 'c.test.ts' })];
    expect(rankTestsByPriority(tests).map((t) => t.path)).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts']);
    // Same input, shuffled, must produce the same order.
    expect(rankTestsByPriority([...tests].reverse()).map((t) => t.path)).toEqual(['a.test.ts', 'b.test.ts', 'c.test.ts']);
  });
});

describe('applyPromptBudget', () => {
  it('sends everything and defers nothing when the payload already fits', () => {
    const payload = makePayload([makeTest({ path: 'a.test.ts' }), makeTest({ path: 'b.test.ts' })]);
    const result = applyPromptBudget(payload, 100_000);

    expect(result.deferredTests).toEqual([]);
    expect(result.payload.tests).toHaveLength(2);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('defers the least-reachable tests first, keeping the ones the graph implicates', () => {
    const payload = makePayload([
      makeTest({ path: 'unreachable-1.test.ts' }),
      makeTest({ path: 'unreachable-2.test.ts' }),
      makeTest({ path: 'edited.test.ts', directlyChanged: true }),
      makeTest({ path: 'near.test.ts', reachableFrom: [{ changedFile: 'src/changed.ts', depth: 1, throughBarrel: false }] }),
    ]);

    // A budget deliberately too small for all four.
    const full = applyPromptBudget(payload, 100_000).estimatedTokens;
    const result = applyPromptBudget(payload, Math.floor(full * 0.75));

    expect(result.deferredTests.length).toBeGreaterThan(0);
    const sentPaths = result.payload.tests.map((t) => t.path);
    // The two the graph actually implicates must survive the cut.
    expect(sentPaths).toContain('edited.test.ts');
    expect(sentPaths).toContain('near.test.ts');
    // Everything deferred is unreachable, never a graph-implicated test.
    for (const deferred of result.deferredTests) expect(deferred).toMatch(/^unreachable-/);
  });

  it('never loses a test: every input is either sent or explicitly deferred', () => {
    const paths = Array.from({ length: 40 }, (_, i) => `t${String(i).padStart(2, '0')}.test.ts`);
    const payload = makePayload(paths.map((path) => makeTest({ path })));

    const result = applyPromptBudget(payload, 300);

    const accounted = [...result.payload.tests.map((t) => t.path), ...result.deferredTests].sort();
    expect(accounted).toEqual([...paths].sort());
  });

  it('always keeps at least one test, even under an impossibly small budget', () => {
    const payload = makePayload([makeTest({ path: 'a.test.ts' }), makeTest({ path: 'b.test.ts' })]);
    const result = applyPromptBudget(payload, 1);

    expect(result.payload.tests).toHaveLength(1);
    expect(result.deferredTests).toHaveLength(1);
  });

  it('preserves the original test ordering in the payload it sends', () => {
    const payload = makePayload([
      makeTest({ path: 'z.test.ts', directlyChanged: true }),
      makeTest({ path: 'a.test.ts', directlyChanged: true }),
    ]);
    const result = applyPromptBudget(payload, 100_000);
    // Ranking decides membership, not the order the model reads them in.
    expect(result.payload.tests.map((t) => t.path)).toEqual(['z.test.ts', 'a.test.ts']);
  });

  it('actually fits the budget when the context sections alone would blow it', () => {
    // Mirrors the real failure this module exists for: a sprawling diff whose
    // changed-file and impact sections exceed the whole budget by themselves.
    // Trimming only the tests is not enough — an earlier version of this code
    // sent one test and still came in at twice the budget.
    const changedFiles = Array.from({ length: 50 }, (_, i) => ({
      path: `src/changed-${i}.ts`,
      changeType: 'modified',
      isTypeScript: true,
      candidateSymbols: Array.from({ length: 30 }, (_, s) => `symbolNumber${s}InFile${i}`),
    }));
    const impact = Array.from({ length: 25 }, (_, i) => ({
      changedFile: `src/changed-${i}.ts`,
      dependents: Array.from({ length: 40 }, (_, d) => ({
        file: `src/dependent-${i}-${d}.ts`,
        depth: (d % 6) + 1,
        throughBarrel: false,
      })),
      depthLimitReached: false,
    }));
    const tests = Array.from({ length: 30 }, (_, i) =>
      makeTest({ path: `src/test-${String(i).padStart(2, '0')}.test.ts`, testTitles: ['a fairly long test title here'] }),
    );

    const budget = 3800; // the real default: 7000 request - 3200 overhead
    const result = applyPromptBudget({ changedFiles, impact, tests }, budget);

    expect(result.estimatedTokens).toBeLessThanOrEqual(budget);
    // Still asked about something, and accounted for everything it didn't ask about.
    expect(result.payload.tests.length).toBeGreaterThan(0);
    expect(result.payload.tests.length + result.deferredTests.length).toBe(tests.length);
  });

  it('fits the budget across a wide range of payload sizes', () => {
    for (const testCount of [1, 5, 25, 100, 400]) {
      const payload = makePayload(
        Array.from({ length: testCount }, (_, i) => makeTest({ path: `src/t-${String(i).padStart(3, '0')}.test.ts` })),
        Array.from({ length: Math.min(testCount, 30) }, (_, i) => ({
          changedFile: `src/c-${i}.ts`,
          dependents: Array.from({ length: 20 }, (_, d) => ({ file: `src/d-${i}-${d}.ts`, depth: 1, throughBarrel: false })),
          depthLimitReached: false,
        })),
      );

      const result = applyPromptBudget(payload, 2000);
      expect(result.estimatedTokens, `testCount=${testCount}`).toBeLessThanOrEqual(2000);
      expect(result.payload.tests.length + result.deferredTests.length).toBe(testCount);
    }
  });

  it('caps an oversized dependent list, keeping the shallowest relationships', () => {
    const dependents = Array.from({ length: 60 }, (_, i) => ({
      file: `src/dep-${String(i).padStart(2, '0')}.ts`,
      depth: (i % 5) + 1,
      throughBarrel: false,
    }));
    const payload = makePayload([makeTest({ path: 'a.test.ts' })], [
      { changedFile: 'src/changed.ts', dependents, depthLimitReached: false },
    ]);

    const result = applyPromptBudget(payload, 100_000, 10);

    expect(result.payload.impact[0]!.dependents).toHaveLength(10);
    expect(result.droppedDependents).toBe(50);
    // Shallowest depth is the strongest signal, so it is what survives.
    expect(result.payload.impact[0]!.dependents.every((d) => d.depth === 1)).toBe(true);
  });

  it('leaves a dependent list alone when it is already within the cap', () => {
    const payload = makePayload([makeTest({ path: 'a.test.ts' })], [
      {
        changedFile: 'src/changed.ts',
        dependents: [{ file: 'src/dep.ts', depth: 1, throughBarrel: false }],
        depthLimitReached: false,
      },
    ]);

    const result = applyPromptBudget(payload, 100_000, 25);
    expect(result.payload.impact[0]!.dependents).toHaveLength(1);
    expect(result.droppedDependents).toBe(0);
  });
});
