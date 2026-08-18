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
    ...overrides,
  };
}

describe('renderReport', () => {
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
});
