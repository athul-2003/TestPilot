import { Agent } from '@mastra/core/agent';
import { z } from 'zod';

import { DEFAULT_FLAKE_PRIOR, MODEL } from '../config.ts';
import { applyStructuralFloor, computeRepeatBudget } from '../tools/flaky-budget.ts';
import { getRepoFailureRate, getTestFailureRate, type TestHistoryStats } from '../tools/test-history-tool.ts';
import type { StructuredGenerator } from './structured-generator.ts';

/**
 * Reads a test's source and flags **structural** flakiness — patterns known
 * to make a test unreliable by construction, independent of any run
 * history. This is the half of the flaky budget that genuinely needs judgment:
 * "does this test sleep for a fixed delay and hope that's long enough?" is a
 * question about what the code is *doing*, not something a regex over
 * keywords can answer reliably (a test *asserting* that a function throws on
 * a bad timestamp is not the same risk as a test whose own correctness
 * depends on `Date.now()`).
 *
 * What this agent explicitly does **not** do: decide how many times to
 * re-run anything. That's a deliberate rule: an LLM asked "how many times
 * should this run?" produces a confident, ungrounded round number.
 * This agent's output — a risk level and a list of named patterns — only
 * ever sets a *minimum floor* that
 * {@link import('../tools/flaky-budget.ts').applyStructuralFloor} applies on
 * top of the statistically-derived count from `flaky-budget.ts`'s formula.
 */

const flakyPatternSchema = z.enum(['timing', 'network', 'shared-state', 'order-dependence', 'randomness', 'date-time']);

const structuralFlagSchema = z.object({
  pattern: flakyPatternSchema,
  rationale: z.string().describe('One sentence pointing at what in the source triggered this flag.'),
});

export const flakyAssessmentOutputSchema = z.object({
  riskLevel: z
    .enum(['low', 'medium', 'high'])
    .describe('Overall structural risk — a qualitative summary, never a repeat-run count.'),
  flags: z.array(structuralFlagSchema),
});

export type FlakyPattern = z.infer<typeof flakyPatternSchema>;
export type StructuralFlag = z.infer<typeof structuralFlagSchema>;
export type FlakyAssessment = z.infer<typeof flakyAssessmentOutputSchema>;

export const flakyAgent = new Agent({
  id: 'flaky-agent',
  name: 'Flaky Agent',
  description: "Flags flaky-by-construction patterns in a test's source: timing, network, shared state, order dependence, randomness, and date/time coupling.",
  model: MODEL,
  instructions: `You are Testpilot's structural flakiness reviewer. Given the source of one test file, identify patterns known to make tests unreliable independent of the code under test.

Look specifically for:

- **timing** — a fixed-delay wait (\`sleep(500)\`, \`setTimeout\` used to "give it enough time") instead of waiting on a real condition or event. A test that awaits a promise or polls an explicit condition is NOT this pattern; a test that hopes a delay was long enough IS.

- **network** — a real HTTP call, database connection, or other external I/O that isn't mocked or stubbed. Tests that hit a real network resource inherit that resource's availability and latency as their own reliability.

- **shared-state** — a module-level or global mutable variable, a shared file/port/table another test also touches, or any singleton whose state persists across test runs without being reset. This is different from local state scoped to one test.

- **order-dependence** — a test whose correctness assumes it runs after (or before) another specific test, typically because it relies on a side effect a prior test left behind rather than setting up its own state.

- **randomness** — \`Math.random()\`, an unseeded random-data generator, or a UUID used in a way that can change the test's outcome, rather than being covered by a general-purpose assertion (e.g. "is a string") that any value would satisfy.

- **date-time** — \`new Date()\` / \`Date.now()\` used in a way that couples the test's outcome to *when* it happens to run, especially near day/month/year or DST boundaries, without freezing or mocking the clock.

Rules:

1. Every flag needs a rationale naming the specific line or construct that triggered it — not a generic "this test might be flaky."
2. Do not flag a pattern's *name* alone (e.g. seeing "Date" imported) if the code doesn't actually create the coupling — a test that asserts a function rejects an invalid date string is not itself date-coupled.
3. riskLevel is a holistic judgment across every flag found, not a mechanical count: one severe, unmistakable pattern (a real unmocked network call in a unit test) can justify "high" on its own; several minor, defensible uses of \`Date.now()\` purely for logging might stay "low."
4. If you find nothing, return an empty flags array and riskLevel "low" — do not invent a flag to have something to say.
5. You are not deciding how many times to re-run this test. Do not include a number anywhere in your response.`,
});

export interface FlakyAssessmentResult {
  assessment: FlakyAssessment;
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  latencyMs: number;
}

/**
 * Sends a test file's source to the agent and returns its structural
 * assessment. Takes the generator as a parameter — same pattern as
 * `impact-agent.ts`'s `runSelection` — so tests can inject a stub and
 * `npm test` never needs the network.
 */
export async function assessFlakyRisk(
  testPath: string,
  sourceText: string,
  generator: StructuredGenerator<typeof flakyAssessmentOutputSchema> = flakyAgent,
): Promise<FlakyAssessmentResult> {
  const prompt = `Review this test file for structural flakiness. File: ${testPath}

\`\`\`typescript
${sourceText}
\`\`\``;

  const startedAt = Date.now();
  const response = await generator.generate(prompt, { structuredOutput: { schema: flakyAssessmentOutputSchema }, modelSettings: { temperature: 0 } });
  const latencyMs = Date.now() - startedAt;

  return { assessment: response.object, usage: response.usage ?? {}, latencyMs };
}

// --- Combining statistical and structural signals ----------------------

export interface FlakyBudget {
  testPath: string;
  budget: number;
  basePrior: number;
  priorSource: 'test-history' | 'repo-fallback' | 'default';
  structuralFlags: StructuralFlag[];
  riskLevel?: FlakyAssessment['riskLevel'];
}

/**
 * Computes one test's repeat-run budget: a statistical
 * prior from real history (this test's own, falling back to the repo-wide
 * rate, falling back to a documented default for a repo with no history at
 * all) — optionally raised by a structural risk assessment for a genuinely
 * new test, where history can't yet say anything — then handed to
 * {@link computeRepeatBudget}'s arithmetic for the final count.
 *
 * `sourceText` is only used, and the agent only called, when provided —
 * callers pass it for newly-added test files (reconstructable in full from
 * the diff itself) and omit it for tests with existing history, where an
 * extra model call would buy little over the statistical signal already in
 * hand.
 *
 * `knownTestStats` lets a caller that has *already* looked this test's
 * history up hand the result over instead of paying for the same query
 * twice — the triage workflow reads it to decide whether a test is unstable
 * enough to need a budget at all, and would otherwise re-read it here for
 * every single candidate. Omitting it means "look it up", not "this test has
 * no history".
 */
export async function computeFlakyBudget(
  repoRoot: string,
  testPath: string,
  sourceText: string | undefined,
  generator: StructuredGenerator<typeof flakyAssessmentOutputSchema> = flakyAgent,
  knownTestStats?: TestHistoryStats,
): Promise<FlakyBudget> {
  const testStats = knownTestStats ?? (await getTestFailureRate(repoRoot, testPath));

  let basePrior: number;
  let priorSource: FlakyBudget['priorSource'];
  if (testStats) {
    basePrior = testStats.failureRate;
    priorSource = 'test-history';
  } else {
    const repoStats = await getRepoFailureRate(repoRoot);
    if (repoStats) {
      basePrior = repoStats.failureRate;
      priorSource = 'repo-fallback';
    } else {
      basePrior = DEFAULT_FLAKE_PRIOR;
      priorSource = 'default';
    }
  }

  const statisticalBudget = computeRepeatBudget(basePrior);
  let budget = statisticalBudget;
  let structuralFlags: StructuralFlag[] = [];
  let riskLevel: FlakyAssessment['riskLevel'] | undefined;

  if (sourceText !== undefined) {
    const { assessment } = await assessFlakyRisk(testPath, sourceText, generator);
    structuralFlags = assessment.flags;
    riskLevel = assessment.riskLevel;
    budget = applyStructuralFloor(statisticalBudget, riskLevel);
  }

  return { testPath, budget, basePrior, priorSource, structuralFlags, riskLevel };
}
