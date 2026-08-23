import { createScorer } from '@mastra/core/evals';

/**
 * The headline credibility number, made mechanical. Everything else this
 * project measures — confidence, minutes saved, flaky budgets — is a
 * judgment call the tool makes. This scorer checks the one thing that isn't
 * allowed to be a judgment call: **a test Testpilot decided to skip must
 * never turn out to be one that would have failed.**
 *
 * A **Mastra Scorer** evaluates an input/output pair and produces a
 * numeric score, optionally through LLM-judged steps — but this one needs
 * no judge at all. "Did the skip list intersect the failure list" is a
 * plain function; running it through a judge model would only add cost,
 * latency, and a chance of the judge being wrong about something
 * mechanically checkable.
 */

export interface RegressionGuardInput {
  scenarioName: string;
  /**
   * Repo-relative test file paths that genuinely failed — measured by
   * actually running the real test suite against the scenario's changed
   * state, never asserted by hand. A hand-written "this should fail" list
   * would make the guard trivially satisfiable by construction; only a real
   * test run can catch a real miss.
   */
  actualFailedTestFiles: string[];
}

export interface RegressionGuardOutput {
  /** Testpilot's own skip list for this scenario. */
  skip: string[];
}

/**
 * The check itself, as a plain function — exported separately so it can be
 * unit tested directly, the same pattern used throughout this codebase, and
 * so the scorer's `generateScore`/`generateReason` steps share one
 * definition of "missed" rather than each re-deriving it.
 */
export function findMissedRegressions(
  skip: string[],
  actualFailedTestFiles: string[],
): string[] {
  const failed = new Set(actualFailedTestFiles);
  return skip.filter((path) => failed.has(path));
}

export const regressionGuardScorer = createScorer<RegressionGuardInput, RegressionGuardOutput>({
  id: 'regression-guard',
  name: 'Regression Guard',
  description:
    'Fails if any test Testpilot skipped is a test that genuinely failed when the real suite was run ' +
    "against the scenario's changed code — the trust metric this whole project exists to protect.",
})
  // `run.input`/`run.output` are typed optional because a scorer can also
  // run in trace-scoring mode with only one side present — not this
  // scorer's usage, which always supplies both. Validated once, here, so
  // every later step works with plain, non-optional values instead of
  // repeating the guard.
  .analyze(({ run }) => {
    if (!run.input || !run.output) {
      throw new Error('regression-guard requires both input and output — check how .run() was called.');
    }
    return {
      scenarioName: run.input.scenarioName,
      actualFailedCount: run.input.actualFailedTestFiles.length,
      missed: findMissedRegressions(run.output.skip, run.input.actualFailedTestFiles),
    };
  })
  .generateScore(({ results }) => (results.analyzeStepResult.missed.length === 0 ? 1 : 0))
  .generateReason(({ results, score }) => {
    const { scenarioName, actualFailedCount, missed } = results.analyzeStepResult;
    if (score === 1) {
      return `No missed regressions in "${scenarioName}": ${actualFailedCount} test(s) actually failed, and none of them were in Testpilot's skip list.`;
    }
    return (
      `MISSED REGRESSION in "${scenarioName}": ` +
      `Testpilot skipped ${missed.length} test(s) that genuinely failed — ${missed.join(', ')}.`
    );
  });
