import { describe, expect, it } from 'vitest';

import type { GitDiffResult } from '../tools/git-diff-tool.ts';
import type { ImpactedEntry } from '../tools/import-graph-tool.ts';
import { computeConfidence } from './confidence.ts';

function diff(overrides: Partial<GitDiffResult> = {}): GitDiffResult {
  return { files: [], truncated: false, totalChars: 200, ...overrides };
}

function entry(overrides: Partial<ImpactedEntry> = {}): ImpactedEntry {
  return { file: 'src/x.ts', found: true, isBarrel: false, dependents: [], depthLimitReached: false, ...overrides };
}

describe('computeConfidence', () => {
  it('scores a small, fully-resolved, fully-covered change near the top of the range', () => {
    const { confidence, signals } = computeConfidence({
      diff: diff(),
      impacted: [entry({ dependents: [{ file: 'src/x.test.ts', depth: 1, throughBarrel: false }] })],
      inventorySize: 5,
      selectionWarningCount: 0,
    });

    expect(signals.diffCompleteness).toBeCloseTo(1, 1);
    expect(signals.graphCoverage).toBe(1);
    expect(signals.graphCertainty).toBe(1);
    expect(signals.selectionCompleteness).toBe(1);
    expect(confidence).toBeGreaterThan(0.9);
  });

  it('drops sharply, not proportionally, when the diff was truncated', () => {
    const truncated = computeConfidence({
      diff: diff({ truncated: true, totalChars: 100 }),
      impacted: [],
      inventorySize: 0,
      selectionWarningCount: 0,
    });
    const untruncatedSameSize = computeConfidence({
      diff: diff({ truncated: false, totalChars: 100 }),
      impacted: [],
      inventorySize: 0,
      selectionWarningCount: 0,
    });

    // A truncated diff is a known, certain gap, not just "somewhat large" —
    // it should score well below an untruncated diff of the identical size.
    expect(truncated.signals.diffCompleteness).toBeLessThan(untruncatedSameSize.signals.diffCompleteness);
    expect(truncated.signals.diffCompleteness).toBe(0.3);
  });

  it('penalizes a changed file the graph could not find', () => {
    const result = computeConfidence({
      diff: diff(),
      impacted: [entry({ found: true }), entry({ file: 'src/y.ts', found: false })],
      inventorySize: 3,
      selectionWarningCount: 0,
    });

    expect(result.signals.graphCoverage).toBe(0.5);
  });

  it('penalizes hitting the depth limit more than a barrel-heavy but complete search', () => {
    const depthLimited = computeConfidence({
      diff: diff(),
      impacted: [entry({ depthLimitReached: true })],
      inventorySize: 1,
      selectionWarningCount: 0,
    });
    const barrelHeavy = computeConfidence({
      diff: diff(),
      impacted: [
        entry({
          dependents: [
            { file: 'a.ts', depth: 1, throughBarrel: true },
            { file: 'b.ts', depth: 2, throughBarrel: true },
          ],
        }),
      ],
      inventorySize: 1,
      selectionWarningCount: 0,
    });

    expect(depthLimited.signals.graphCertainty).toBeLessThan(barrelHeavy.signals.graphCertainty);
  });

  it('treats zero changed TypeScript files as fully certain, not a gap', () => {
    // A diff that only touched, say, a README has nothing for the graph to
    // have missed — it should not read as a low-confidence result.
    const result = computeConfidence({ diff: diff(), impacted: [], inventorySize: 0, selectionWarningCount: 0 });
    expect(result.signals.graphCoverage).toBe(1);
    expect(result.signals.graphCertainty).toBe(1);
  });

  it('scores every changed file being unresolvable as fully uncertain', () => {
    const result = computeConfidence({
      diff: diff(),
      impacted: [entry({ found: false }), entry({ file: 'y.ts', found: false })],
      inventorySize: 2,
      selectionWarningCount: 0,
    });
    expect(result.signals.graphCoverage).toBe(0);
    expect(result.signals.graphCertainty).toBe(0);
  });

  it('reduces selection completeness in proportion to warning count', () => {
    const result = computeConfidence({ diff: diff(), impacted: [], inventorySize: 4, selectionWarningCount: 2 });
    expect(result.signals.selectionCompleteness).toBe(0.5);
  });

  it('never returns a confidence outside [0, 1]', () => {
    const worst = computeConfidence({
      diff: diff({ truncated: true, totalChars: 999_999 }),
      impacted: [entry({ found: false }), entry({ file: 'y.ts', found: false, depthLimitReached: true })],
      inventorySize: 10,
      selectionWarningCount: 20,
    });
    expect(worst.confidence).toBeGreaterThanOrEqual(0);
    expect(worst.confidence).toBeLessThanOrEqual(1);
  });
});
