import { describe, expect, it } from 'vitest';

import { applyStructuralFloor, computeRepeatBudget } from './flaky-budget.ts';

describe('computeRepeatBudget', () => {
  it('gives a never-observed-to-fail test the minimum budget', () => {
    expect(computeRepeatBudget(0)).toBe(1);
  });

  it('gives a rarely-flaky test close to the cap, not close to one', () => {
    // The corrected formula's whole point: a LOW failure rate needs MORE
    // repeats to distinguish "always fine" from "fine 98% of the time,"
    // not fewer. A test failing 2% of the time is exactly the case a
    // single green run tells you almost nothing about.
    expect(computeRepeatBudget(0.02)).toBe(10);
  });

  it('never exceeds the cap, however unstable the input', () => {
    expect(computeRepeatBudget(0.5)).toBeLessThanOrEqual(10);
    expect(computeRepeatBudget(0.99)).toBeLessThanOrEqual(10);
  });

  it('gives an always-failing test the minimum budget — one run already shows the problem', () => {
    // A consistently broken test isn't "flaky" in the sense that needs
    // repeat-testing budget; it needs a bug fix, and a single run already
    // demonstrates that reliably.
    expect(computeRepeatBudget(1)).toBe(1);
  });

  it('decreases as failure probability rises past the low end — a rarer flake needs more scrutiny, not less', () => {
    // This is the formula's defining, slightly counterintuitive property:
    // it answers "how many repeats to trust a green streak," and a test
    // that fails often gets caught almost immediately, while a test that
    // fails rarely needs many repeats to rule out a lucky streak.
    const rare = computeRepeatBudget(0.1);
    const moderate = computeRepeatBudget(0.3);
    const frequent = computeRepeatBudget(0.7);
    expect(rare).toBeGreaterThanOrEqual(moderate);
    expect(moderate).toBeGreaterThanOrEqual(frequent);
  });

  it('respects a custom target confidence and cap', () => {
    const lenient = computeRepeatBudget(0.3, 0.8, 5);
    expect(lenient).toBeLessThanOrEqual(5);
    expect(lenient).toBeGreaterThanOrEqual(1);
  });

  it('always returns an integer, never a fractional run count', () => {
    const n = computeRepeatBudget(0.15);
    expect(Number.isInteger(n)).toBe(true);
  });
});

describe('applyStructuralFloor', () => {
  it('never lowers the statistical budget, regardless of risk level', () => {
    // The property this whole function exists to guarantee: structural risk
    // can only ever push the count up. An earlier version of this module
    // raised the *probability* fed into the formula instead, which could
    // silently lower the result — this test is the regression guard for
    // that exact mistake.
    for (const statisticalBudget of [1, 3, 5, 10]) {
      for (const risk of ['low', 'medium', 'high'] as const) {
        expect(applyStructuralFloor(statisticalBudget, risk)).toBeGreaterThanOrEqual(statisticalBudget);
      }
    }
  });

  it('imposes no floor at low risk — the statistics alone decide', () => {
    expect(applyStructuralFloor(1, 'low')).toBe(1);
  });

  it('raises a low statistical budget up to the risk floor', () => {
    expect(applyStructuralFloor(1, 'medium')).toBeGreaterThan(1);
    expect(applyStructuralFloor(1, 'high')).toBeGreaterThan(applyStructuralFloor(1, 'medium'));
  });

  it('leaves an already-high statistical budget untouched by a lower floor', () => {
    expect(applyStructuralFloor(10, 'medium')).toBe(10);
  });
});
