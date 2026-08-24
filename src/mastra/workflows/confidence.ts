import { z } from 'zod';

import type { GitDiffResult } from '../tools/git-diff-tool.ts';
import type { ImpactedEntry } from '../tools/import-graph-tool.ts';
import { MAX_DIFF_CHARS } from '../config.ts';

/**
 * The confidence score — how much Testpilot should trust
 * its own selection this run. This is a **weighted formula over observable
 * signals**, computed here, in code, from data every earlier step already
 * produced. It is never a number the LLM is asked to invent: an agent asked
 * "how confident are you?" will produce a plausible-sounding number with no
 * real basis, and the entire point of a confidence-gated safety net is that
 * it has to be trustworthy precisely when the reasoning it's checking might
 * not be.
 *
 * Four signals, each independently meaningful and each in `[0, 1]`:
 *
 * - **diffCompleteness** — did Testpilot see the whole diff? A diff that was
 *   truncated (the ~40k character ceiling) means the model reasoned
 *   over a partial picture, which is a severe, known blind spot.
 * - **graphCoverage** — of the changed TypeScript files, how many did the
 *   import graph actually find and analyse? A changed file the graph
 *   couldn't locate contributes zero reachability information.
 * - **graphCertainty** — of the files the graph *did* find, how trustworthy
 *   is their reachability data? Hitting the depth limit, or a dependency
 *   chain running through a barrel file (the `throughBarrel` flag),
 *   both weaken the signal without invalidating it outright.
 * - **selectionCompleteness** — did the model's response actually cover
 *   every test in the inventory? `selectTests`'s warnings already
 *   catch this directly: a missing or hallucinated path is a concrete,
 *   measured defect in that specific run's output.
 *
 * "Share of symbols resolved" is another candidate signal. It's
 * deliberately folded into `graphCertainty` here rather than built as a
 * separate metric: the diff tool's candidate symbols are regex-derived from
 * diff text and were never cross-referenced against the AST-derived
 * declarations at the individual-symbol level, so a dedicated signal would
 * need new plumbing the pipeline doesn't otherwise require. Worth revisiting
 * if calibration shows the score needs a sharper signal here.
 */

const WEIGHTS = {
  diffCompleteness: 0.25,
  graphCoverage: 0.3,
  graphCertainty: 0.3,
  selectionCompleteness: 0.15,
} as const;

export const confidenceSignalsSchema = z.object({
  diffCompleteness: z.number().min(0).max(1),
  graphCoverage: z.number().min(0).max(1),
  graphCertainty: z.number().min(0).max(1),
  selectionCompleteness: z.number().min(0).max(1),
});

export type ConfidenceSignals = z.infer<typeof confidenceSignalsSchema>;

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * A diff that was truncated is a known, certain gap — dropped sharply rather
 * than scaled, because "we know we didn't see part of this" is qualitatively
 * different from "this diff happens to be large." A diff sitting right at
 * the ceiling without tripping it still costs some confidence: size alone
 * correlates with the kind of sprawling change that's harder to reason
 * about correctly, truncated or not.
 */
function diffCompleteness(diff: GitDiffResult): number {
  if (diff.truncated) return 0.3;
  const sizeRatio = diff.totalChars / MAX_DIFF_CHARS;
  return clamp01(1 - sizeRatio * 0.5);
}

/** The fraction of changed TypeScript files the import graph actually found. */
function graphCoverage(impacted: ImpactedEntry[]): number {
  if (impacted.length === 0) return 1; // nothing to have missed
  const foundCount = impacted.filter((e) => e.found).length;
  return foundCount / impacted.length;
}

/**
 * Averages a per-file certainty score across every changed file the graph
 * found. A file that exhausted the depth limit loses more than one whose
 * reach runs entirely through barrel files, because a depth-limited search
 * is *known* to be incomplete, while a barrel-heavy one is complete but
 * weaker evidence — the two are different kinds of doubt.
 */
function graphCertainty(impacted: ImpactedEntry[]): number {
  const found = impacted.filter((e) => e.found);
  if (found.length === 0) return impacted.length === 0 ? 1 : 0;

  const perFile = found.map((entry) => {
    let score = 1;
    if (entry.depthLimitReached) score -= 0.4;
    if (entry.dependents.length > 0) {
      const barrelFraction = entry.dependents.filter((d) => d.throughBarrel).length / entry.dependents.length;
      score -= barrelFraction * 0.3;
    }
    return clamp01(score);
  });

  return perFile.reduce((sum, s) => sum + s, 0) / perFile.length;
}

/** How much of the test inventory the model's response actually covered — one point off per warning, scaled by inventory size. */
function selectionCompleteness(inventorySize: number, warningCount: number): number {
  if (inventorySize === 0) return 1;
  return clamp01(1 - warningCount / inventorySize);
}

export interface ConfidenceInput {
  diff: GitDiffResult;
  impacted: ImpactedEntry[];
  inventorySize: number;
  selectionWarningCount: number;
}

export interface ConfidenceResult {
  confidence: number;
  signals: ConfidenceSignals;
}

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const signals: ConfidenceSignals = {
    diffCompleteness: diffCompleteness(input.diff),
    graphCoverage: graphCoverage(input.impacted),
    graphCertainty: graphCertainty(input.impacted),
    selectionCompleteness: selectionCompleteness(input.inventorySize, input.selectionWarningCount),
  };

  const confidence =
    signals.diffCompleteness * WEIGHTS.diffCompleteness +
    signals.graphCoverage * WEIGHTS.graphCoverage +
    signals.graphCertainty * WEIGHTS.graphCertainty +
    signals.selectionCompleteness * WEIGHTS.selectionCompleteness;

  return { confidence: clamp01(confidence), signals };
}
