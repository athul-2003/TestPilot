import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { impactAgent, correlateTestsWithImpact, runSelection, selectedTestSchema, type PromptPayload } from '../agents/impact-agent.ts';
import { ASSUMED_MINUTES_PER_TEST, CONFIDENCE_THRESHOLD, MAX_IMPACT_DEPTH } from '../config.ts';
import { ciAnnotateInputSchema, renderReport } from '../tools/ci-annotate-tool.ts';
import { gitDiffOutputSchema, parseUnifiedDiff } from '../tools/git-diff-tool.ts';
import { buildImportGraph, computeImpactedFiles, importGraphOutputSchema } from '../tools/import-graph-tool.ts';
import { buildTestInventory, testFileSchema } from '../tools/test-inventory-tool.ts';
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
    const changedTsFiles = inputData.files.filter((f) => f.isTypeScript && !f.isBinary).map((f) => f.path);

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

    const result = await runSelection(payload, impactAgent);
    return {
      selections: result.selections,
      testInventory: inventory.tests,
      warnings: result.warnings,
      usage: result.usage,
      latencyMs: result.latencyMs,
    };
  },
});

// --- Step 4: score confidence (D3) --------------------------------------

const scoreConfidenceOutputSchema = z.object({
  confidence: z.number(),
  signals: confidenceSignalsSchema,
});

const scoreConfidenceStep = createStep({
  id: 'score-confidence',
  inputSchema: selectTestsOutputSchema,
  outputSchema: scoreConfidenceOutputSchema,
  execute: async ({ inputData, getStepResult }) => {
    const diffResult = getStepResult(parseDiffStep);
    const impactResult = getStepResult(buildImpactStep);

    return computeConfidence({
      diff: diffResult,
      impacted: impactResult.impacted,
      inventorySize: inputData.testInventory.length,
      selectionWarningCount: inputData.warnings.length,
    });
  },
});

// --- Branch: low confidence falls back to running everything ---------

const runAllStep = createStep({
  id: 'run-all',
  inputSchema: scoreConfidenceOutputSchema,
  outputSchema: finalReportSchema,
  execute: async ({ inputData, getStepResult }) => {
    const selectResult = getStepResult(selectTestsStep);
    const allPaths = selectResult.testInventory.map((t) => t.path);

    const report = renderReport({
      confidence: inputData.confidence,
      signals: inputData.signals,
      fellBackToRunAll: true,
      estimatedMinutesSaved: 0,
      selections: [],
      totalTestCount: allPaths.length,
    });

    return {
      mustRun: allPaths,
      shouldRun: [],
      skip: [],
      confidence: inputData.confidence,
      estimatedMinutesSaved: 0,
      fellBackToRunAll: true,
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
    const testTypeByPath = new Map(selectResult.testInventory.map((t) => [t.path, t.testType]));

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
    });

    return { mustRun, shouldRun, skip, confidence: inputData.confidence, estimatedMinutesSaved, fellBackToRunAll: false, report };
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
