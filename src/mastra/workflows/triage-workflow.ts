import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { flakyAgent, computeFlakyBudget } from '../agents/flaky-agent.ts';
import { impactAgent, correlateTestsWithImpact, runSelection, selectedTestSchema, type PromptPayload } from '../agents/impact-agent.ts';
import { ASSUMED_MINUTES_PER_TEST, CONFIDENCE_THRESHOLD, FLAKY_ESTIMATE_CONCURRENCY, MAX_IMPACT_DEPTH } from '../config.ts';
import { ciAnnotateInputSchema, flakyBudgetEntrySchema, renderReport } from '../tools/ci-annotate-tool.ts';
import { gitDiffOutputSchema, parseUnifiedDiff, reconstructAddedFileSource } from '../tools/git-diff-tool.ts';
import { buildImportGraph, computeImpactedFiles, importGraphOutputSchema } from '../tools/import-graph-tool.ts';
import { buildTestInventory, testFileSchema } from '../tools/test-inventory-tool.ts';
import { getTestFailureRate, type TestHistoryStats } from '../tools/test-history-tool.ts';
import { computeConfidence, confidenceSignalsSchema } from './confidence.ts';

/**
 * The whole pipeline, assembled: read the diff, map its impact, select
 * tests, score confidence in that selection, and either report it or fall
 * back to running everything. Every earlier phase built one piece of this;
 * this file is where they become one thing a CI job actually calls.
 *
 * A **workflow** is a fixed sequence of **steps** — unlike an agent, which
 * decides what to do next, a workflow's shape is declared up front and
 * every run follows the same path (with `.branch()` picking between two
 * *known* paths, not inventing a new one). This step's `execute` receives a
 * single destructured object, `{ inputData, getInitData, getStepResult, ... }`
 * — a different shape from a tool's `execute(inputData, context?)`, and the
 * single most common way to trip over Mastra's API.
 *
 * `getStepResult(someStep)` and `getInitData()` are how a step reaches
 * outside its own immediate input: `getStepResult` pulls any *earlier*
 * step's output by passing the step object itself (not a string — Mastra
 * types the result against that exact step's `outputSchema`), and
 * `getInitData` returns the workflow's original input, however many steps
 * deep the current one is. Both are used heavily below, because several
 * steps here need data from more than just the step immediately before them.
 */

const workflowInputSchema = z.object({
  diff: z.string().describe('A unified diff, e.g. `git diff <merge-base> HEAD`.'),
  repoRoot: z.string().describe('Absolute path to the repository being analysed.'),
  maxDepth: z.number().int().positive().optional(),
});

type WorkflowInput = z.infer<typeof workflowInputSchema>;

const finalReportSchema = z.object({
  mustRun: z.array(z.string()),
  shouldRun: z.array(z.string()),
  skip: z.array(z.string()),
  confidence: z.number(),
  estimatedMinutesSaved: z.number(),
  fellBackToRunAll: z.boolean(),
  /** testPath -> repeat-run budget, for every new or historically-unstable test that got one. */
  flakyBudget: z.record(z.string(), z.number()),
  report: z.string().describe('The rendered Markdown PR comment.'),
});

export type TriageResult = z.infer<typeof finalReportSchema>;

// --- Step 1: parse the diff -------------------------------------------

const parseDiffStep = createStep({
  id: 'parse-diff',
  inputSchema: workflowInputSchema,
  outputSchema: gitDiffOutputSchema,
  execute: async ({ inputData }) => parseUnifiedDiff(inputData.diff),
});

// --- Step 2: map the impact ------------------------------------------

const buildImpactStep = createStep({
  id: 'build-impact',
  inputSchema: gitDiffOutputSchema,
  outputSchema: importGraphOutputSchema,
  execute: async ({ inputData, getInitData }) => {
    const init = getInitData<WorkflowInput>();
    // `.d.ts` files are declaration-only and excluded from the import graph
    // itself (see import-graph-tool.ts's walkTypeScriptFiles) — asking the
    // graph about one always comes back `found: false`, which reads as
    // "deleted" and wrongly tanks confidence for a file that just isn't
    // graph-tracked. Match the graph's own scope here.
    const changedTsFiles = inputData.files
      .filter((f) => f.isTypeScript && !f.isBinary && !f.path.endsWith('.d.ts'))
      .map((f) => f.path);

    const graph = buildImportGraph(init.repoRoot);
    const impacted =
      changedTsFiles.length > 0 ? computeImpactedFiles(graph, changedTsFiles, init.maxDepth ?? MAX_IMPACT_DEPTH) : [];

    return { impacted, graphStats: { filesScanned: graph.filesScanned, filesParsed: graph.filesParsed } };
  },
});

// --- Step 3: select tests ----------------------------------------------

const selectTestsOutputSchema = z.object({
  selections: z.array(selectedTestSchema),
  testInventory: z.array(testFileSchema),
  /**
   * True when the selection call itself failed — a provider outage, a rate
   * limit, a malformed response. Distinct from "the model answered and we
   * didn't trust the answer": there is no answer at all, so the run is
   * forced down the run-everything branch below.
   */
  selectionFailed: z.boolean(),
  warnings: z.array(z.string()),
  usage: z.object({
    inputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalTokens: z.number().optional(),
  }),
  latencyMs: z.number(),
});

const selectTestsStep = createStep({
  id: 'select-tests',
  inputSchema: importGraphOutputSchema,
  outputSchema: selectTestsOutputSchema,
  execute: async ({ inputData, getInitData, getStepResult }) => {
    const init = getInitData<WorkflowInput>();
    const diffResult = getStepResult(parseDiffStep);
    const inventory = buildTestInventory(init.repoRoot);

    const tests = correlateTestsWithImpact(diffResult.files, inputData.impacted, inventory.tests);
    const payload: PromptPayload = {
      changedFiles: diffResult.files.map((f) => ({
        path: f.path,
        changeType: f.changeType,
        isTypeScript: f.isTypeScript,
        candidateSymbols: f.candidateSymbols,
      })),
      impact: inputData.impacted.map((entry) => ({
        changedFile: entry.file,
        dependents: entry.dependents,
        depthLimitReached: entry.depthLimitReached,
      })),
      tests,
    };

    // A failed selection call must not fail the run. Testpilot's whole
    // safety story is "when we can't trust the reasoning, run everything" —
    // a provider outage or a rate limit is the strongest possible version of
    // not being able to trust it, so it takes the same path a low-confidence
    // result does instead of breaking the user's CI step. The reason is
    // reported rather than swallowed.
    try {
      const result = await runSelection(payload, impactAgent);
      return {
        selections: result.selections,
        testInventory: inventory.tests,
        selectionFailed: false,
        warnings: result.warnings,
        usage: result.usage,
        latencyMs: result.latencyMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        selections: [],
        testInventory: inventory.tests,
        selectionFailed: true,
        warnings: [`Test selection failed, so every test is being run as a safety net. Cause: ${message}`],
        usage: {},
        latencyMs: 0,
      };
    }
  },
});

// --- Step 4: estimate flaky budgets ------------------------------------
//
// Runs before confidence scoring, matching the original pipeline sketch —
// its output has to be available to *either* branch of the confidence gate
// below, since a low-confidence run still benefits from knowing which of
// the tests it's about to run (everything) are new or historically shaky.

const estimateFlakyOutputSchema = z.object({
  flakyBudgets: z.array(flakyBudgetEntrySchema),
});

/**
 * Runs `work` over every item with at most `limit` in flight at once,
 * returning one settled result per item, in input order.
 *
 * `Promise.allSettled` alone gives the per-item error isolation but no
 * back-pressure: it starts everything simultaneously. This keeps both
 * properties — one failure can't sink its neighbours, and the fan-out stays
 * bounded.
 */
async function mapSettledWithConcurrency<T, R>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<Array<PromiseSettledResult<R>>> {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  async function runner(): Promise<void> {
    let index = cursor++;
    while (index < items.length) {
      try {
        results[index] = { status: 'fulfilled', value: await work(items[index]!) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
      index = cursor++;
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runner()));
  return results;
}

const estimateFlakyStep = createStep({
  id: 'estimate-flaky',
  inputSchema: selectTestsOutputSchema,
  outputSchema: estimateFlakyOutputSchema,
  execute: async ({ inputData, getInitData, getStepResult }) => {
    const init = getInitData<WorkflowInput>();
    const diffResult = getStepResult(parseDiffStep);

    const addedTsFilesByPath = new Map(
      diffResult.files.filter((f) => f.changeType === 'added' && f.isTypeScript).map((f) => [f.path, f]),
    );
    const runnablePaths = new Set(inputData.selections.filter((s) => s.bucket !== 'skip').map((s) => s.path));
    const candidates = inputData.testInventory.filter((t) => runnablePaths.has(t.path));

    // Settled and bounded, not `Promise.all`: a flaky-budget estimate is a
    // nice-to-have on top of the actual test-selection decision, never a
    // reason to fail the whole run. A transient failure on one test's
    // flaky-agent call (rate limit, network blip) must not take down every
    // other test's budget — or the workflow itself — with it. Matches
    // cli.ts's own stated principle: Testpilot reports, it does not
    // hard-fail on its own reasoning.
    const settled = await mapSettledWithConcurrency(candidates, FLAKY_ESTIMATE_CONCURRENCY, async (test) => {
      const addedFile = addedTsFilesByPath.get(test.path);
      const isNew = addedFile !== undefined;

      let knownStats: TestHistoryStats | undefined;
      if (!isNew) {
        // Most tests in most diffs are neither new nor unstable — this
        // cheap history check is what keeps a large, healthy test suite
        // from paying for a flaky-agent call on every single test it runs.
        const stats = await getTestFailureRate(init.repoRoot, test.path);
        const isUnstable = stats !== undefined && stats.failCount > 0 && stats.failCount < stats.totalRuns;
        if (!isUnstable) return undefined;
        // Handed to computeFlakyBudget below so it doesn't re-run the query
        // that just produced this.
        knownStats = stats;
      }

      const sourceText = addedFile ? reconstructAddedFileSource(addedFile) : undefined;
      const result = await computeFlakyBudget(init.repoRoot, test.path, sourceText, flakyAgent, knownStats);
      return {
        testPath: result.testPath,
        budget: result.budget,
        priorSource: result.priorSource,
        riskLevel: result.riskLevel,
        structuralFlags: result.structuralFlags,
      };
    });

    const budgets = settled.map((s) => (s.status === 'fulfilled' ? s.value : undefined));
    return { flakyBudgets: budgets.filter((b) => b !== undefined) };
  },
});

// --- Step 5: score confidence -------------------------------------------

const scoreConfidenceOutputSchema = z.object({
  confidence: z.number(),
  signals: confidenceSignalsSchema,
});

const scoreConfidenceStep = createStep({
  id: 'score-confidence',
  inputSchema: estimateFlakyOutputSchema,
  outputSchema: scoreConfidenceOutputSchema,
  execute: async ({ getStepResult }) => {
    const diffResult = getStepResult(parseDiffStep);
    const impactResult = getStepResult(buildImpactStep);
    const selectResult = getStepResult(selectTestsStep);

    const scored = computeConfidence({
      diff: diffResult,
      impacted: impactResult.impacted,
      inventorySize: selectResult.testInventory.length,
      selectionWarningCount: selectResult.warnings.length,
    });

    // No selection at all means no reasoning to score. Zero forces the
    // run-everything branch rather than letting the other signals average
    // out to something that looks like confidence.
    if (selectResult.selectionFailed) {
      return { confidence: 0, signals: { ...scored.signals, selectionCompleteness: 0 } };
    }

    return scored;
  },
});

// --- Branch: low confidence falls back to running everything ---------

const runAllStep = createStep({
  id: 'run-all',
  inputSchema: scoreConfidenceOutputSchema,
  outputSchema: finalReportSchema,
  execute: async ({ inputData, getStepResult }) => {
    const selectResult = getStepResult(selectTestsStep);
    const flakyResult = getStepResult(estimateFlakyStep);
    const allPaths = selectResult.testInventory.map((t) => t.path);
    const flakyBudget = Object.fromEntries(flakyResult.flakyBudgets.map((b) => [b.testPath, b.budget]));

    const report = renderReport({
      confidence: inputData.confidence,
      signals: inputData.signals,
      fellBackToRunAll: true,
      estimatedMinutesSaved: 0,
      selections: [],
      totalTestCount: allPaths.length,
      flakyBudgets: flakyResult.flakyBudgets,
      warnings: selectResult.warnings,
      usage: { ...selectResult.usage, latencyMs: selectResult.latencyMs },
    });

    return {
      mustRun: allPaths,
      shouldRun: [],
      skip: [],
      confidence: inputData.confidence,
      estimatedMinutesSaved: 0,
      fellBackToRunAll: true,
      flakyBudget,
      report,
    };
  },
});

const buildReportStep = createStep({
  id: 'build-report',
  inputSchema: scoreConfidenceOutputSchema,
  outputSchema: finalReportSchema,
  execute: async ({ inputData, getStepResult }) => {
    const selectResult = getStepResult(selectTestsStep);
    const flakyResult = getStepResult(estimateFlakyStep);
    const testTypeByPath = new Map(selectResult.testInventory.map((t) => [t.path, t.testType]));
    const flakyBudget = Object.fromEntries(flakyResult.flakyBudgets.map((b) => [b.testPath, b.budget]));

    const mustRun = selectResult.selections.filter((s) => s.bucket === 'must-run').map((s) => s.path);
    const shouldRun = selectResult.selections.filter((s) => s.bucket === 'should-run').map((s) => s.path);
    const skip = selectResult.selections.filter((s) => s.bucket === 'skip').map((s) => s.path);

    const estimatedMinutesSaved = skip.reduce((total, path) => {
      const testType = testTypeByPath.get(path) ?? 'unit';
      return total + ASSUMED_MINUTES_PER_TEST[testType];
    }, 0);

    const report = renderReport({
      confidence: inputData.confidence,
      signals: inputData.signals,
      fellBackToRunAll: false,
      estimatedMinutesSaved,
      selections: selectResult.selections,
      totalTestCount: selectResult.testInventory.length,
      flakyBudgets: flakyResult.flakyBudgets,
      warnings: selectResult.warnings,
      usage: { ...selectResult.usage, latencyMs: selectResult.latencyMs },
    });

    return {
      mustRun,
      shouldRun,
      skip,
      confidence: inputData.confidence,
      estimatedMinutesSaved,
      fellBackToRunAll: false,
      flakyBudget,
      report,
    };
  },
});

// --- Finalize: `.branch()` only ever runs one arm, keyed by step id ------
//
// `.branch()`'s result isn't the branch step's output directly — it's an
// object keyed by each branch step's `id`, with only the chosen one
// populated (`{ 'run-all'?: ..., 'build-report'?: ... }`), the same shape
// `.parallel()` produces. This step exists purely to collapse that back
// into the workflow's actual declared output.

const finalizeStep = createStep({
  id: 'finalize',
  inputSchema: z.object({
    'run-all': finalReportSchema.optional(),
    'build-report': finalReportSchema.optional(),
  }),
  outputSchema: finalReportSchema,
  execute: async ({ inputData }) => {
    const result = inputData['run-all'] ?? inputData['build-report'];
    if (!result) {
      throw new Error('Neither branch of the confidence gate produced a result — this should be unreachable.');
    }
    return result;
  },
});

export const triageWorkflow = createWorkflow({
  id: 'triage-workflow',
  inputSchema: workflowInputSchema,
  outputSchema: finalReportSchema,
})
  .then(parseDiffStep)
  .then(buildImpactStep)
  .then(selectTestsStep)
  .then(estimateFlakyStep)
  .then(scoreConfidenceStep)
  .branch([
    [async ({ inputData }) => inputData.confidence < CONFIDENCE_THRESHOLD, runAllStep],
    [async ({ inputData }) => inputData.confidence >= CONFIDENCE_THRESHOLD, buildReportStep],
  ])
  .then(finalizeStep)
  .commit();

// Re-exported so ci-annotate-tool's schema and the workflow's report shape
// are visibly the same contract, not two schemas that happen to match.
export type { CiAnnotateInput } from '../tools/ci-annotate-tool.ts';
export { ciAnnotateInputSchema };
