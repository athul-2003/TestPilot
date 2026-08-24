import { describe, expect, it } from 'vitest';

import { CONFIDENCE_THRESHOLD } from '../config.ts';
import { renderReport, type CiAnnotateInput } from './ci-annotate-tool.ts';

const signals = { diffCompleteness: 0.9, graphCoverage: 1, graphCertainty: 0.8, selectionCompleteness: 1 };

function baseInput(overrides: Partial<CiAnnotateInput> = {}): CiAnnotateInput {
  return {
    confidence: 0.85,
    signals,
    fellBackToRunAll: false,
    estimatedMinutesSaved: 0,
    selections: [],
    totalTestCount: 0,
    flakyBudgets: [],
    ...overrides,
  };
}

describe('renderReport', () => {
  it('renders warnings when there are any, and omits the section entirely when there are none', () => {
    const clean = renderReport(baseInput({ totalTestCount: 3 }));
    expect(clean).not.toContain('Warnings');

    const warned = renderReport(
      baseInput({
        totalTestCount: 3,
        warnings: ['Test selection failed, so every test is being run as a safety net. Cause: rate limited'],
      }),
    );
    expect(warned).toContain('⚠️ Warnings');
    expect(warned).toContain('rate limited');
  });

  it('renders each bucket with its rationale and confidence', () => {
    const report = renderReport(
      baseInput({
        selections: [
          { path: 'a.test.ts', bucket: 'must-run', rationale: 'Directly imports the change.', confidence: 0.95 },
          { path: 'b.test.ts', bucket: 'should-run', rationale: 'Reachable at depth 2.', confidence: 0.6 },
          { path: 'c.test.ts', bucket: 'skip', rationale: 'Covers an unrelated module.', confidence: 0.9 },
        ],
        estimatedMinutesSaved: 0.1,
        totalTestCount: 3,
      }),
    );

    expect(report).toContain('✅ **1 must-run**');
    expect(report).toContain('🟡 **1 should-run**');
    expect(report).toContain('⏭️ **1 skipped**');
    expect(report).toContain('`a.test.ts` — Directly imports the change. (confidence 0.95)');
    expect(report).toContain('`c.test.ts` — Covers an unrelated module. (confidence 0.90)');
    expect(report).not.toContain('below threshold');
  });

  it('omits a bucket section entirely when that bucket is empty', () => {
    const report = renderReport(
      baseInput({
        selections: [{ path: 'a.test.ts', bucket: 'must-run', rationale: 'x', confidence: 0.9 }],
        totalTestCount: 1,
      }),
    );

    expect(report).toContain('### ✅ Must run');
    expect(report).not.toContain('### 🟡 Should run');
    expect(report).not.toContain('### ⏭️ Skipped');
  });

  it('states the fell-back-to-run-all state explicitly, with zero minutes saved', () => {
    const report = renderReport(baseInput({ fellBackToRunAll: true, confidence: 0.4, totalTestCount: 12 }));

    expect(report).toContain('below threshold');
    expect(report).toContain('Falling back to running the full suite');
    expect(report).toContain('12 tests run** (all of them)');
    expect(report).toContain('**0 minutes** saved this run');
    // No per-test sections make sense when nothing was individually judged.
    expect(report).not.toContain('### ✅ Must run');
  });

  it('always states the confidence threshold it was measured against', () => {
    const report = renderReport(baseInput());
    expect(report).toContain(`(threshold ${CONFIDENCE_THRESHOLD})`);
  });

  it('always states the minutes-saved assumptions in the same report as the number', () => {
    const report = renderReport(baseInput({ estimatedMinutesSaved: 2.1 }));
    expect(report).toMatch(/placeholders until real historical run-time data/);
    expect(report).toContain('0.1 min/unit test');
  });

  it('renders the confidence signals table', () => {
    const report = renderReport(baseInput());
    expect(report).toContain('| Diff completeness | 0.90 |');
    expect(report).toContain('| Graph certainty | 0.80 |');
  });

  it('renders a flaky-risk section with structural flags when present', () => {
    const report = renderReport(
      baseInput({
        flakyBudgets: [
          {
            testPath: 'src/new.test.ts',
            budget: 8,
            priorSource: 'default',
            riskLevel: 'high',
            structuralFlags: [{ pattern: 'network', rationale: 'Calls a real HTTP endpoint.' }],
          },
          {
            testPath: 'src/unstable.test.ts',
            budget: 3,
            priorSource: 'test-history',
            structuralFlags: [],
          },
        ],
      }),
    );

    expect(report).toContain('### 🎲 Flaky risk');
    expect(report).toContain('`src/new.test.ts` — **8 repeat runs** (prior: default, risk high)');
    expect(report).toContain('*network*: Calls a real HTTP endpoint.');
    expect(report).toContain('`src/unstable.test.ts` — **3 repeat runs** (prior: test-history)');
    expect(report).toMatch(/formula over observed failure rate, not from a model guess/);
  });

  it('omits the flaky-risk section entirely when nothing needed a budget', () => {
    const report = renderReport(baseInput({ flakyBudgets: [] }));
    expect(report).not.toContain('Flaky risk');
  });

  it('singularizes "repeat run" for a budget of exactly one', () => {
    const report = renderReport(
      baseInput({
        flakyBudgets: [{ testPath: 'src/x.test.ts', budget: 1, priorSource: 'default', structuralFlags: [] }],
      }),
    );
    expect(report).toContain('**1 repeat run**');
    expect(report).not.toContain('1 repeat runs');
  });
});
