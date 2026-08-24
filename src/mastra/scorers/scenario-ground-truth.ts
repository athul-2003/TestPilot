/**
 * Hand-derived expectations for every seeded scenario, written **before**
 * any scenario was run through Testpilot — a fixture tuned until the agent
 * passes is worthless as evidence. Nothing in this file
 * is edited after seeing real results; a scenario whose result look wrong
 * gets a new scenario or a bug report, not a quietly adjusted expectation.
 *
 * Two different kinds of "correct" are recorded, and the eval harness
 * checks them differently:
 *
 * - `idealMustRun` / `idealSafeToSkip` — the selection a perfectly-informed
 *   tool *would* make, derived by hand from this fixture's real, by-
 *   construction dependency graph. Used to measure **efficiency**: how
 *   close Testpilot's actual skip list gets to the theoretical best case.
 *   This is a judgment call, not an empirical fact — it can't be verified
 *   by running tests, because a test staying green doesn't prove it didn't
 *   need to run, only that this particular change didn't happen to break it.
 *
 * - Real vitest execution against each scenario's `after/` state is the
 *   **empirical** ground truth the regression-guard scorer actually checks
 *   against: whichever test files genuinely fail. That list isn't written
 *   here by hand — it's measured, every run, by the harness itself. This
 *   file only records *expectations about it* (e.g. "nothing should fail"),
 *   which the harness can assert against the real measurement.
 */

export type ScenarioName =
  | '01-pure-logic-isolated'
  | '02-shared-util-bug'
  | '03-type-only'
  | '04-test-only'
  | '05-config-change'
  | '06-trip-fallback';

export interface ScenarioGroundTruth {
  name: ScenarioName;
  description: string;
  /** Relative to this scenario's directory. */
  diffFile: string;
  /** Relative to this scenario's directory; undefined when the diff references a path that doesn't exist on disk (06). */
  afterDir?: string;
  /** Every test file that genuinely could not be skipped without risking a missed regression. */
  idealMustRun: string[];
  /** Every test file a perfectly-informed tool could safely skip. */
  idealSafeToSkip: string[];
  /** Whether real vitest, run against the after/ state, is expected to report any failure at all. */
  expectRealFailures: boolean;
  /** Whether this scenario is expected to leave Testpilot's own confidence below its threshold. */
  expectFallback: boolean;
  /** What makes this scenario worth having, beyond its category label. */
  whyItMatters: string;
}

export const SCENARIOS: ScenarioGroundTruth[] = [
  {
    name: '01-pure-logic-isolated',
    description: 'Behavior-preserving refactor of formatCurrency — no other file imports format.ts.',
    diffFile: 'change.diff',
    afterDir: 'after',
    idealMustRun: ['src/format.test.ts'],
    idealSafeToSkip: ['src/math.test.ts', 'src/discount.test.ts', 'src/pricing.test.ts', 'src/validate.test.ts'],
    expectRealFailures: false,
    expectFallback: false,
    whyItMatters:
      'The cleanest possible case for CI-minute savings — a genuinely isolated file with zero dependents. ' +
      'If Testpilot cannot skip confidently here, it cannot skip confidently anywhere.',
  },
  {
    name: '02-shared-util-bug',
    description:
      'A REAL, deliberate off-by-one bug in math.multiply (`a * b + 1`), which discount.ts and pricing.ts both ' +
      'depend on transitively. This is the only scenario with an actual introduced defect.',
    diffFile: 'change.diff',
    afterDir: 'after',
    idealMustRun: ['src/math.test.ts', 'src/discount.test.ts', 'src/pricing.test.ts'],
    idealSafeToSkip: ['src/format.test.ts', 'src/validate.test.ts'],
    expectRealFailures: true,
    expectFallback: false,
    whyItMatters:
      'The one scenario with teeth. Real vitest execution against the buggy after/ state should show ' +
      'math.test.ts, discount.test.ts, and pricing.test.ts genuinely failing. If Testpilot skips any of ' +
      'them, that is exactly what "missed regressions" means, and the regression-guard must catch it.',
  },
  {
    name: '03-type-only',
    description: 'Adds an optional, unused field to the Order interface — no runtime code path changes.',
    diffFile: 'change.diff',
    afterDir: 'after',
    idealMustRun: [],
    idealSafeToSkip: [
      'src/math.test.ts',
      'src/discount.test.ts',
      'src/pricing.test.ts',
      'src/format.test.ts',
      'src/validate.test.ts',
    ],
    expectRealFailures: false,
    expectFallback: false,
    whyItMatters:
      'Ideally every test is skippable — an optional field nothing reads yet changes no behavior. ' +
      "Testpilot's import graph does not currently distinguish `import type` from a runtime import (a known, " +
      'documented limitation, not yet fixed), so pricing.test.ts and validate.test.ts are expected ' +
      'to show up as reachable anyway. That is a measurable efficiency gap, not a missed regression — flagged ' +
      'honestly here before the run, not discovered and explained away after it.',
  },
  {
    name: '04-test-only',
    description: 'Adds a new boundary-condition test case directly to discount.test.ts.',
    diffFile: 'change.diff',
    afterDir: 'after',
    idealMustRun: ['src/discount.test.ts'],
    idealSafeToSkip: ['src/math.test.ts', 'src/pricing.test.ts', 'src/format.test.ts', 'src/validate.test.ts'],
    expectRealFailures: false,
    expectFallback: false,
    whyItMatters:
      "Directly exercises impact-agent's rule 5 (a directly-edited test file is always must-run) in isolation " +
      'from any reachability reasoning at all.',
  },
  {
    name: '05-config-change',
    description: "Edits package.json's description field — no TypeScript file changes at all.",
    diffFile: 'change.diff',
    afterDir: 'after',
    idealMustRun: [],
    idealSafeToSkip: [
      'src/math.test.ts',
      'src/discount.test.ts',
      'src/pricing.test.ts',
      'src/format.test.ts',
      'src/validate.test.ts',
    ],
    expectRealFailures: false,
    expectFallback: false,
    whyItMatters:
      'A genuinely interesting finding, recorded before the run: a change with zero TypeScript files touched ' +
      'gives the import graph literally nothing to search, which the current confidence formula ' +
      'treats as full certainty (graphCoverage/graphCertainty = 1 when there are no changed TS files) rather ' +
      "than as a blind spot. A config change *could* have real behavioral consequences Testpilot's " +
      'reasoning cannot see at all, and confidence should arguably reflect that — a candidate follow-up, not ' +
      'something silently patched here.',
  },
  {
    name: '06-trip-fallback',
    description:
      'Diff references src/phantom.ts, a path that does not exist anywhere in this fixture — the same ' +
      "technique used in Phases 4 and 5's own low-confidence verification.",
    diffFile: 'change.diff',
    afterDir: undefined,
    idealMustRun: [],
    idealSafeToSkip: [],
    expectRealFailures: false,
    expectFallback: true,
    whyItMatters:
      'The deliberate demonstration of the safety net itself: when the import graph cannot find the changed ' +
      'file at all, confidence should fall below threshold and Testpilot should run everything rather than ' +
      'guess.',
  },
];
