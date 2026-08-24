import { FLAKY_REPEAT_CAP, FLAKY_TARGET_CONFIDENCE } from '../config.ts';

/**
 * How many times a new or historically-unstable test must
 * be re-run before an all-green streak means something, rather than being a
 * lucky roll. Pure arithmetic — the number a repeat-run budget is built on
 * must come from a formula anyone can check, never from an LLM asked "how
 * many times should I run this?", which will produce a confident round
 * number with no basis whatsoever.
 *
 * **A correction, made during implementation:** this formula was originally
 * recorded as `n = ceil(log(1-c) / log(p))` with
 * `p` as the test's observed per-run failure rate. That formula is wrong for
 * that `p`. Deriving it from first principles: if a test fails independently
 * with probability `p` on any given run, the chance that `n` repeats are
 * *all* green by luck — despite the instability — is `(1-p)^n`. We want that
 * chance to be at most `1-c` (i.e., seeing all-green gives us confidence `c`
 * that we didn't just get lucky):
 *
 * ```
 * (1-p)^n ≤ 1-c
 * n · log(1-p) ≤ log(1-c)        (log both sides)
 * n ≥ log(1-c) / log(1-p)        (divide by log(1-p), which is negative — flips the inequality)
 * ```
 *
 * So the denominator is `log(1-p)`, not `log(p)`. The two formulas only
 * agree by coincidence, if at all — plugging a real observed failure rate
 * into the original produces badly wrong results. For example, at `p = 0.02`
 * (a test failing 2% of the time, genuinely rare) the original formula
 * gives `n ≈ 1` — implying a single green run is basically conclusive, which
 * is backwards: a *rarely*-flaky test is exactly the case where you need the
 * *most* repeats to statistically tell "always fine" apart from "fine 98% of
 * the time." The corrected formula gives `n = 10` (the cap) for that same
 * input, which is the right shape of answer.
 */
export function computeRepeatBudget(
  failureProbability: number,
  targetConfidence: number = FLAKY_TARGET_CONFIDENCE,
  cap: number = FLAKY_REPEAT_CAP,
): number {
  // p <= 0 makes log(1-p) = log(1) = 0, an explicit division by zero rather
  // than a merely-large result — and correctly so: a test never observed to
  // fail has given us no evidence to budget repeats against yet.
  if (failureProbability <= 0) return 1;

  const n = Math.ceil(Math.log(1 - targetConfidence) / Math.log(1 - failureProbability));
  return Math.min(cap, Math.max(1, n));
}

export type StructuralRiskLevel = 'low' | 'medium' | 'high';

/**
 * Minimum repeat-run count a structural risk assessment (the
 * flaky-agent) imposes, regardless of what the statistical formula alone
 * would say. **Not** implemented as raising the probability fed into
 * {@link computeRepeatBudget} — an earlier version of this file did exactly
 * that, and it was wrong. `computeRepeatBudget` is *strictly decreasing* in
 * its input probability (a test that fails 99% of the time needs only 1 run
 * to show the problem; a test that fails 2% of the time needs the full cap
 * to rule out luck), so pushing the prior *up* toward "more likely to fail"
 * pushes the required repeat count *down* — the opposite of what "this test
 * looks risky, scrutinize it more" is supposed to mean. A floor applied
 * *after* the formula has no such trap: it can only ever raise the count
 * toward more scrutiny, never lower it.
 *
 * These floor values are a small, reasoned starting point — same
 * provisional status as the confidence threshold, subject to real
 * evidence. `low` imposes no floor at all: a single defensible pattern
 * shouldn't override what the actual statistics say.
 */
const STRUCTURAL_RISK_FLOOR: Record<StructuralRiskLevel, number> = {
  low: 0,
  medium: 4,
  high: 8,
};

/**
 * Combines a statistically-derived repeat budget with a structural risk
 * floor. By explicit design, the LLM never sets the count directly —
 * this only ever raises what the formula already computed.
 */
export function applyStructuralFloor(statisticalBudget: number, structuralRisk: StructuralRiskLevel): number {
  return Math.max(statisticalBudget, STRUCTURAL_RISK_FLOOR[structuralRisk]);
}
