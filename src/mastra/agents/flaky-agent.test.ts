import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { recordTestRun } from '../tools/test-history-tool.ts';
import { assessFlakyRisk, computeFlakyBudget, flakyAssessmentOutputSchema, type FlakyAssessment } from './flaky-agent.ts';
import type { StructuredGenerator } from './structured-generator.ts';

let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'testpilot-flaky-'));
});

afterEach(() => {
  // See the identical, fully-explained comment in test-history-tool.test.ts
  // — a confirmed upstream Windows limitation of @libsql/client's local
  // driver (the mmap'd file isn't released until process exit), not
  // something fixable from this side. Best-effort only.
  try {
    rmSync(repoRoot, { recursive: true, force: true });
  } catch {
    // Expected on Windows — see above.
  }
});

// Real model calls are slow, cost tokens, and would make `npm test` depend
// on the network — same reasoning as impact-agent's fake generator.
function fakeGenerator(assessment: FlakyAssessment): StructuredGenerator<typeof flakyAssessmentOutputSchema> {
  return {
    generate: async () => ({ object: assessment, usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 } }),
  };
}

describe('assessFlakyRisk', () => {
  it('returns the model\'s assessment and records usage and latency', async () => {
    const fake = fakeGenerator({
      riskLevel: 'high',
      flags: [{ pattern: 'network', rationale: 'Calls a real HTTP endpoint without mocking it.' }],
    });

    const result = await assessFlakyRisk('src/api.test.ts', 'fetch("https://example.com")', fake);

    expect(result.assessment.riskLevel).toBe('high');
    expect(result.assessment.flags).toHaveLength(1);
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 20, totalTokens: 70 });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('computeFlakyBudget', () => {
  it('uses a default prior and skips the agent when no source text is given', async () => {
    // No history for this repo, and no sourceText — nothing to base a
    // structural assessment on, so the agent must not be called.
    const shouldNeverBeCalled = fakeGenerator({ riskLevel: 'high', flags: [] });
    let called = false;
    const spy: typeof shouldNeverBeCalled = {
      generate: async (...args) => {
        called = true;
        return shouldNeverBeCalled.generate(...args);
      },
    };

    const result = await computeFlakyBudget(repoRoot, 'src/never-run.test.ts', undefined, spy);

    expect(called).toBe(false);
    expect(result.priorSource).toBe('default');
    expect(result.riskLevel).toBeUndefined();
    expect(result.structuralFlags).toEqual([]);
    expect(result.budget).toBeGreaterThanOrEqual(1);
  });

  it('prefers a test\'s own history over the repo-wide or default prior', async () => {
    await recordTestRun(repoRoot, 'src/unstable.test.ts', 'fail');
    await recordTestRun(repoRoot, 'src/unstable.test.ts', 'pass');
    await recordTestRun(repoRoot, 'src/unstable.test.ts', 'pass');
    // Unrelated history that would produce a different repo-wide rate, to
    // prove the test's own history wins over it.
    await recordTestRun(repoRoot, 'src/other.test.ts', 'fail');
    await recordTestRun(repoRoot, 'src/other.test.ts', 'fail');

    const result = await computeFlakyBudget(repoRoot, 'src/unstable.test.ts', undefined);

    expect(result.priorSource).toBe('test-history');
    expect(result.basePrior).toBeCloseTo(1 / 3);
  });

  it('falls back to the repo-wide rate for a test with no history of its own', async () => {
    await recordTestRun(repoRoot, 'src/a.test.ts', 'fail');
    await recordTestRun(repoRoot, 'src/a.test.ts', 'pass');
    await recordTestRun(repoRoot, 'src/a.test.ts', 'pass');
    await recordTestRun(repoRoot, 'src/a.test.ts', 'pass');

    const result = await computeFlakyBudget(repoRoot, 'src/brand-new.test.ts', undefined);

    expect(result.priorSource).toBe('repo-fallback');
    expect(result.basePrior).toBeCloseTo(0.25);
  });

  it('raises the budget via a floor, not by changing the statistical prior, and never sets the count directly', async () => {
    // A moderate, non-saturated prior from real history — chosen so the
    // statistical formula alone gives an unsaturated result, which is what
    // makes the floor's effect actually visible in this test. (The default
    // prior used for a test with zero history already saturates to the cap
    // on its own, which would make this assertion trivially true for the
    // wrong reason.)
    await recordTestRun(repoRoot, 'src/moderate.test.ts', 'fail');
    await recordTestRun(repoRoot, 'src/moderate.test.ts', 'fail');
    await recordTestRun(repoRoot, 'src/moderate.test.ts', 'pass');
    await recordTestRun(repoRoot, 'src/moderate.test.ts', 'pass');

    const fake = fakeGenerator({
      riskLevel: 'high',
      flags: [{ pattern: 'timing', rationale: 'Uses a fixed setTimeout instead of awaiting the real condition.' }],
    });

    const withoutStructural = await computeFlakyBudget(repoRoot, 'src/moderate.test.ts', undefined);
    const withStructural = await computeFlakyBudget(repoRoot, 'src/moderate.test.ts', 'setTimeout(...)', fake);

    expect(withStructural.riskLevel).toBe('high');
    expect(withStructural.structuralFlags).toHaveLength(1);
    // The prior itself — the observed failure rate — is untouched by the
    // structural assessment; only the final budget, via the floor, moves.
    expect(withStructural.basePrior).toBe(withoutStructural.basePrior);
    expect(withStructural.basePrior).toBeCloseTo(0.5);
    expect(withStructural.budget).toBeGreaterThan(withoutStructural.budget);
  });
});
