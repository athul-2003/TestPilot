import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

import { MAX_IMPACT_DEPTH, MODEL } from '../config.ts';
import { parseUnifiedDiff } from '../tools/git-diff-tool.ts';
import { buildImportGraph, computeImpactedFiles, type Dependent } from '../tools/import-graph-tool.ts';
import { buildTestInventory } from '../tools/test-inventory-tool.ts';

/**
 * The first **agent** in this codebase, as opposed to a tool. A tool is a
 * fixed function: same input, same output, every time — `git-diff-tool`
 * always parses a diff the same way. An agent is a model with instructions,
 * asked to *reason* about something with no fixed algorithm: "given this
 * change and this test suite, which tests should run?" has no formula, only
 * judgment — which is exactly the kind of question Testpilot exists to
 * answer with a written-down rationale instead of a black-box guess.
 */

const bucketSchema = z.enum(['must-run', 'should-run', 'skip']);

const selectedTestSchema = z.object({
  path: z.string(),
  bucket: bucketSchema,
  rationale: z
    .string()
    .describe('One sentence a developer would accept on sight as the reason for this bucket.'),
  confidence: z.number().min(0).max(1),
});

/**
 * **Structured output**: instead of asking the model to write prose and
 * hoping to parse a bucket name back out of it, `structuredOutput` hands the
 * model this exact Zod shape, and the response comes back already validated
 * against it — `response.object`, not `response.text`. The rationale isn't a
 * debug log bolted on afterward; it's a required field the model cannot
 * produce a selection without filling in.
 */
export const testSelectionOutputSchema = z.object({
  selections: z.array(selectedTestSchema),
});

export type Bucket = z.infer<typeof bucketSchema>;
export type SelectedTest = z.infer<typeof selectedTestSchema>;
export type TestSelectionResult = z.infer<typeof testSelectionOutputSchema>;

export const impactAgent = new Agent({
  id: 'impact-agent',
  name: 'Impact Agent',
  description: 'Classifies each test in a repo as must-run, should-run, or skip for a given code change, with a rationale for every decision.',
  model: MODEL,
  instructions: `You are Testpilot's test-selection reasoner. Given a code change and a repo's test inventory, decide which tests should run in CI.

Rules you must follow, without exception:

1. Every test in the inventory gets exactly one bucket: "must-run", "should-run", or "skip". Classify every test you're given — never omit one, never invent a path that wasn't in the inventory.

2. "must-run" and "should-run" both EXECUTE in CI. The only difference between them is how certain you are. "skip" is the ONLY bucket that saves CI time, so treat it as a real claim, not a shrug: you are asserting this specific test cannot have been affected by this specific change.

3. Every "skip" needs a rationale a developer would accept on sight, naming what the test actually covers and why this diff can't touch it. If you can't state a specific reason, don't skip it — mark it "should-run" instead.

4. Bias toward inclusion. A wrongly-included test costs a few minutes of CI time. A wrongly-skipped test that would have failed costs trust in this entire tool, and that trade is never close. When genuinely unsure, choose "should-run" over "skip".

5. A test file that was itself directly edited in this diff is always "must-run" — the change and the test of that change are the same event.

6. A test the import graph shows is reachable from a changed file is a real signal — a direct import (depth 1, not through a barrel) is strong evidence for "must-run"; a longer chain or a re-export barrel in the path is real but weaker evidence, appropriate for "should-run" with a correspondingly lower confidence.

7. A test NOT found reachable in the import graph may still be affected by something the graph can't see — a dynamic string-built import, config-driven behavior, a shared fixture, environment coupling. Absence of a graph signal is not proof of safety. If you skip such a test, say plainly in the rationale that it's based on absence of a reachability signal, not on a specific understanding of what the test covers — so a human reviewing the skip knows exactly how much to trust it.

8. e2e and integration tests are expensive to re-run. Let that weigh on the "must-run" vs "should-run" choice for a reachable one, but never let cost be a reason to "skip" a test the graph shows is reachable.`,
});

// --- Orchestration -----------------------------------------------------

interface ReachEntry {
  changedFile: string;
  depth: number;
  throughBarrel: boolean;
}

interface PromptTest {
  path: string;
  testType: string;
  testTitles: string[];
  directlyChanged: boolean;
  reachableFrom: ReachEntry[];
}

interface PromptPayload {
  changedFiles: Array<{ path: string; changeType: string; isTypeScript: boolean; candidateSymbols: string[] }>;
  impact: Array<{ changedFile: string; dependents: Dependent[]; depthLimitReached: boolean }>;
  tests: PromptTest[];
}

/**
 * Combines the outputs of Phases 1 and 2 with this phase's test inventory
 * into one payload the agent can reason over — the "diff summary, reverse-
 * dependency reach, and test inventory" the agent's prompt needs. This is
 * the same correlation Phase 4's workflow will eventually run as a
 * dedicated step; it lives here for now because there's nowhere else for it
 * to live before that workflow exists, and the selection logic belongs
 * beside the agent it feeds regardless of which one calls the other later.
 */
export function buildPromptPayload(repoRoot: string, diff: string, maxDepth: number): PromptPayload {
  const diffResult = parseUnifiedDiff(diff);
  const changedTsFiles = diffResult.files.filter((f) => f.isTypeScript && !f.isBinary).map((f) => f.path);

  const graph = buildImportGraph(repoRoot);
  const impacted = changedTsFiles.length > 0 ? computeImpactedFiles(graph, changedTsFiles, maxDepth) : [];

  const inventory = buildTestInventory(repoRoot);
  const changedPaths = new Set(diffResult.files.map((f) => f.path));

  const tests: PromptTest[] = inventory.tests.map((test) => {
    const reachableFrom: ReachEntry[] = [];
    for (const entry of impacted) {
      const hit = entry.dependents.find((d) => d.file === test.path);
      if (hit) reachableFrom.push({ changedFile: entry.file, depth: hit.depth, throughBarrel: hit.throughBarrel });
    }
    return {
      path: test.path,
      testType: test.testType,
      testTitles: test.testTitles,
      directlyChanged: changedPaths.has(test.path),
      reachableFrom,
    };
  });

  return {
    changedFiles: diffResult.files.map((f) => ({
      path: f.path,
      changeType: f.changeType,
      isTypeScript: f.isTypeScript,
      candidateSymbols: f.candidateSymbols,
    })),
    impact: impacted.map((entry) => ({
      changedFile: entry.file,
      dependents: entry.dependents,
      depthLimitReached: entry.depthLimitReached,
    })),
    tests,
  };
}

/** The minimum shape `selectTests` needs from an agent — narrower than the
 * real `Agent` class so tests can pass a stub that never touches the
 * network, without needing to construct a real Mastra Agent to satisfy it. */
export interface StructuredGenerator {
  generate(
    prompt: string,
    options: { structuredOutput: { schema: typeof testSelectionOutputSchema } },
  ): Promise<{
    object: TestSelectionResult;
    usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  }>;
}

export interface SelectTestsResult {
  selections: SelectedTest[];
  /** Inventory paths the model's response didn't cover, or hallucinated paths not in the inventory. */
  warnings: string[];
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  latencyMs: number;
}

/**
 * Runs the full Phase 3 pipeline: parse the diff, compute impact reach,
 * build the test inventory, and ask the agent to classify every test — the
 * thing "a sample change" exercises for this phase's exit gate.
 */
export async function selectTests(
  input: { repoRoot: string; diff: string; maxDepth?: number },
  generator: StructuredGenerator = impactAgent,
): Promise<SelectTestsResult> {
  const payload = buildPromptPayload(input.repoRoot, input.diff, input.maxDepth ?? MAX_IMPACT_DEPTH);

  const prompt = `Classify every test below for this change. Respond with exactly one entry per test in "tests".

${JSON.stringify(payload, null, 2)}`;

  const startedAt = Date.now();
  const response = await generator.generate(prompt, { structuredOutput: { schema: testSelectionOutputSchema } });
  const latencyMs = Date.now() - startedAt;

  const inventoryPaths = new Set(payload.tests.map((t) => t.path));
  const returnedPaths = new Set(response.object.selections.map((s) => s.path));

  const warnings: string[] = [];
  for (const path of inventoryPaths) {
    if (!returnedPaths.has(path)) warnings.push(`missing from the model's response: ${path}`);
  }
  for (const path of returnedPaths) {
    if (!inventoryPaths.has(path)) warnings.push(`not in the test inventory, ignoring: ${path}`);
  }

  return { selections: response.object.selections, warnings, usage: response.usage ?? {}, latencyMs };
}
