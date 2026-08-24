import { MAX_DEPENDENTS_PER_IMPACT, MAX_PROMPT_TOKENS } from '../config.ts';
// Type-only import: erased at runtime, so this does not create an import
// cycle with impact-agent.ts, which imports this module's functions.
import type { PromptPayload, PromptTest } from './impact-agent.ts';

/**
 * Keeps the selection prompt inside a token budget.
 *
 * The prompt describes every test in the repo, so its size grows with the
 * suite rather than with the change. That is fine on a small project and
 * fatal on a large one: a 46-file diff against this repo produced a 13,465
 * token request against a provider limit of 8,000, and the whole run failed.
 *
 * Failing is not the worst outcome, though — falling back to "run
 * everything" on every single run is, because the tool then costs money and
 * saves nothing while still looking like it works. So instead of sending
 * everything and hoping, this module decides *what to leave out*, and does
 * it in the one direction that can never cost a missed regression: anything
 * dropped from the prompt is never sent to the model at all, and its caller
 * assigns it `should-run`. Budget pressure can make Testpilot less
 * efficient. It must never make it less safe.
 *
 * What gets dropped first is driven by the import graph, which is the one
 * signal available *before* the model is consulted. A test the diff
 * physically edited matters most; a test one hop from a changed file
 * matters more than one six hops away; a test with no path from the change
 * at all is the cheapest thing to defer.
 */

/**
 * Rough token count for a string.
 *
 * Deliberately a heuristic and not a real tokenizer: pulling in a
 * tokenizer would tie this to one provider's vocabulary, and the number is
 * only used to decide what to leave out. Four characters per token is the
 * usual approximation for English prose and runs slightly conservative on
 * dense JSON punctuation, which is the safe direction to be wrong in — an
 * overestimate trims a little too much, an underestimate exceeds the limit
 * and fails the request.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function estimateJsonTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value, null, 2));
}

/**
 * How strongly the import graph implies this test is worth asking about.
 * Lower sorts first and is therefore likelier to survive the budget.
 *
 * 0 = the diff edited this test file itself, 1..n = its shortest path from
 * any changed file, Infinity = the graph found no path at all.
 */
export function testPriority(test: PromptTest): number {
  if (test.directlyChanged) return 0;
  if (test.reachableFrom.length === 0) return Number.POSITIVE_INFINITY;
  return Math.min(...test.reachableFrom.map((r) => r.depth));
}

/**
 * Orders tests by how much the graph suggests this change could reach them,
 * breaking ties on path so the same repo and diff always produce the same
 * prompt — a budget that reorders itself between runs would make failures
 * impossible to reproduce.
 */
export function rankTestsByPriority(tests: PromptTest[]): PromptTest[] {
  return [...tests].sort((a, b) => {
    const priorityA = testPriority(a);
    const priorityB = testPriority(b);
    // Compared, not subtracted: two unreachable tests are both Infinity, and
    // Infinity - Infinity is NaN, which silently corrupts the whole sort and
    // takes the tie-break below with it.
    if (priorityA !== priorityB) return priorityA < priorityB ? -1 : 1;
    return a.path.localeCompare(b.path);
  });
}

/**
 * Caps the dependent list on each impact entry, keeping the shallowest
 * (strongest) relationships.
 *
 * A single widely-imported file can have hundreds of dependents, most of
 * them not tests. The per-test `reachableFrom` field already tells the
 * model what it needs about each test specifically, so this section is
 * largely corroborating detail and is the right thing to shrink before
 * dropping whole tests.
 */
function capDependents(
  impact: PromptPayload['impact'],
  maxPerEntry: number,
): { impact: PromptPayload['impact']; dropped: number } {
  let dropped = 0;

  const capped = impact.map((entry) => {
    if (entry.dependents.length <= maxPerEntry) return entry;
    const byDepth = [...entry.dependents].sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file));
    dropped += entry.dependents.length - maxPerEntry;
    return { ...entry, dependents: byDepth.slice(0, maxPerEntry) };
  });

  return { impact: capped, dropped };
}

/**
 * Fraction of the budget the context sections (changed files and the impact
 * summary) may occupy before they start getting trimmed.
 *
 * The tests are the *question* — the model cannot classify a test it never
 * saw — while changed files and impact are supporting detail. So context
 * yields first, and keeps yielding until it fits its share. Without this,
 * a sprawling diff crowds out the very thing the prompt exists to ask
 * about: an early version of this module reserved nothing, and a 47-file
 * diff left room for exactly one test while still blowing the budget.
 */
const CONTEXT_BUDGET_SHARE = 0.4;

/** Progressively looser caps, tried in order until the impact section fits. */
const DEPENDENT_CAP_LADDER = [25, 15, 10, 5, 3, 1, 0];

/**
 * Shrinks the impact summary until it fits `maxTokens`, first by capping
 * each entry's dependents ever more tightly, and — if even a dependent-free
 * summary is too big, which means the diff itself is enormous — by keeping
 * only the entries the model is most likely to need.
 */
function fitImpact(
  impact: PromptPayload['impact'],
  maxTokens: number,
): { impact: PromptPayload['impact']; droppedDependents: number; droppedEntries: number } {
  for (const cap of DEPENDENT_CAP_LADDER) {
    const { impact: capped, dropped } = capDependents(impact, cap);
    if (estimateJsonTokens(capped) <= maxTokens) {
      return { impact: capped, droppedDependents: dropped, droppedEntries: 0 };
    }
  }

  // Even with no dependents at all this is too large: the diff touches more
  // files than the budget can describe. Keep a prefix rather than nothing,
  // so the model still sees what kind of change this is.
  const { impact: stripped, dropped } = capDependents(impact, 0);
  let kept = stripped;
  while (kept.length > 1 && estimateJsonTokens(kept) > maxTokens) {
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
  }

  return { impact: kept, droppedDependents: dropped, droppedEntries: impact.length - kept.length };
}

/**
 * Shrinks the changed-file list the same way: symbol lists first, then
 * whole entries. `candidateSymbols` is a regex-derived guess in the first
 * place, so it is cheap information to lose relative to knowing which files
 * changed at all.
 */
function fitChangedFiles(
  changedFiles: PromptPayload['changedFiles'],
  maxTokens: number,
): { changedFiles: PromptPayload['changedFiles']; droppedFiles: number } {
  if (estimateJsonTokens(changedFiles) <= maxTokens) return { changedFiles, droppedFiles: 0 };

  for (const symbolCap of [10, 5, 0]) {
    const capped = changedFiles.map((f) =>
      f.candidateSymbols.length <= symbolCap ? f : { ...f, candidateSymbols: f.candidateSymbols.slice(0, symbolCap) },
    );
    if (estimateJsonTokens(capped) <= maxTokens) return { changedFiles: capped, droppedFiles: 0 };
  }

  let kept = changedFiles.map((f) => ({ ...f, candidateSymbols: [] }));
  while (kept.length > 1 && estimateJsonTokens(kept) > maxTokens) {
    kept = kept.slice(0, Math.max(1, Math.floor(kept.length / 2)));
  }

  return { changedFiles: kept, droppedFiles: changedFiles.length - kept.length };
}

export interface BudgetedPayload {
  /** The payload actually safe to send. */
  payload: PromptPayload;
  /**
   * Tests deliberately withheld from the prompt. The caller must account
   * for every one of these — they were never classified, so they cannot be
   * skipped.
   */
  deferredTests: string[];
  /** Estimated token count of {@link payload}, by the heuristic above. */
  estimatedTokens: number;
  /** Dependent entries dropped while shrinking the impact section. */
  droppedDependents: number;
  /** Impact entries dropped entirely, when even a dependent-free summary was too large. */
  droppedImpactEntries: number;
  /** Changed-file entries dropped entirely, for the same reason. */
  droppedChangedFiles: number;
}

/**
 * Trims a payload until it fits `maxTokens`, cheapest information first:
 * oversized dependent lists, then the least-reachable tests.
 *
 * At least one test is always kept when any exist. A prompt with no tests
 * asks the model nothing, wastes a call, and returns nothing usable — if
 * the budget is genuinely too small for even one test, the honest outcome
 * is one slightly-over-budget request that the provider may still accept,
 * and a failure that now degrades to run-everything rather than crashing.
 */
export function applyPromptBudget(
  payload: PromptPayload,
  maxTokens: number = MAX_PROMPT_TOKENS,
  maxDependentsPerImpact: number = MAX_DEPENDENTS_PER_IMPACT,
): BudgetedPayload {
  // Fast path: if the whole thing already fits, change nothing. Trimming a
  // payload that didn't need trimming would throw away real signal.
  const capped = capDependents(payload.impact, maxDependentsPerImpact);
  const wholeIfCapped: PromptPayload = { ...payload, impact: capped.impact };

  if (estimateJsonTokens(wholeIfCapped) <= maxTokens) {
    return {
      payload: wholeIfCapped,
      deferredTests: [],
      estimatedTokens: estimateJsonTokens(wholeIfCapped),
      droppedDependents: capped.dropped,
      droppedImpactEntries: 0,
      droppedChangedFiles: 0,
    };
  }

  // Over budget. Context yields before the tests do — see
  // CONTEXT_BUDGET_SHARE for why the tests are the part worth protecting.
  const contextBudget = Math.floor(maxTokens * CONTEXT_BUDGET_SHARE);
  const impactFit = fitImpact(payload.impact, Math.floor(contextBudget / 2));
  const changedFit = fitChangedFiles(payload.changedFiles, Math.ceil(contextBudget / 2));

  const base: PromptPayload = { changedFiles: changedFit.changedFiles, impact: impactFit.impact, tests: [] };
  const baseTokens = estimateJsonTokens(base);

  const ranked = rankTestsByPriority(payload.tests);
  const kept: PromptTest[] = [];
  let runningTokens = baseTokens;

  for (const test of ranked) {
    // Each entry costs its own JSON plus the separator; the exact figure
    // doesn't need to be precise, only stable and slightly pessimistic.
    const cost = estimateJsonTokens(test) + 2;
    // Always keep one, even if it overshoots: a prompt with no tests asks
    // the model nothing and wastes the call outright.
    if (kept.length > 0 && runningTokens + cost > maxTokens) continue;

    kept.push(test);
    runningTokens += cost;
  }

  // The greedy fill above sums each test's cost measured on its own, but a
  // test serialized inside a nested array carries deeper indentation than
  // it does standalone, so the running total drifts under the truth. Rather
  // than try to model that, measure the assembled payload and drop the
  // lowest-ranked tests until it genuinely fits — the estimate that matters
  // is the one taken on the thing actually being sent.
  const buildPayload = (keptTests: PromptTest[]): PromptPayload => {
    const paths = new Set(keptTests.map((t) => t.path));
    return {
      changedFiles: changedFit.changedFiles,
      impact: impactFit.impact,
      // Preserve the caller's original test ordering; ranking decided
      // *membership*, and reordering the prompt too would make two
      // near-identical runs look gratuitously different in a diff.
      tests: payload.tests.filter((t) => paths.has(t.path)),
    };
  };

  const survivors = [...kept];
  let finalPayload = buildPayload(survivors);
  while (survivors.length > 1 && estimateJsonTokens(finalPayload) > maxTokens) {
    survivors.pop(); // lowest-ranked, since `kept` is in priority order
    finalPayload = buildPayload(survivors);
  }

  const keptPaths = new Set(survivors.map((t) => t.path));
  const deferredTests = payload.tests.filter((t) => !keptPaths.has(t.path)).map((t) => t.path);

  return {
    payload: finalPayload,
    deferredTests,
    estimatedTokens: estimateJsonTokens(finalPayload),
    droppedDependents: impactFit.droppedDependents,
    droppedImpactEntries: impactFit.droppedEntries,
    droppedChangedFiles: changedFit.droppedFiles,
  };
}
