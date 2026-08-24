import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { CONFIDENCE_THRESHOLD } from '../config.ts';
import { confidenceSignalsSchema } from '../workflows/confidence.ts';

/**
 * Renders the workflow's result into the Markdown a human actually reads —
 * the PR comment. Every other tool in this codebase produces structured
 * data; this is the one whose entire job is turning structured data back
 * into prose, because a JSON blob of buckets and confidence scores is not
 * something a developer skims in thirty seconds on a pull request.
 *
 * One rule governs the whole design here: "estimated minutes
 * saved" is the number people screenshot, so every number in this
 * report states the assumption behind it in the same sentence, not in a
 * separate document nobody reads before sharing the screenshot.
 */

const bucketSchema = z.enum(['must-run', 'should-run', 'skip']);

const reportedSelectionSchema = z.object({
  path: z.string(),
  bucket: bucketSchema,
  rationale: z.string(),
  confidence: z.number(),
});

// Declared locally rather than imported from flaky-agent.ts, the same
// convention `reportedSelectionSchema` above already follows for
// impact-agent's shape — this tool renders whatever compatible structure
// it's given without depending on the agents layer.
const flakyPatternSchema = z.enum(['timing', 'network', 'shared-state', 'order-dependence', 'randomness', 'date-time']);

export const flakyBudgetEntrySchema = z.object({
  testPath: z.string(),
  budget: z.number(),
  priorSource: z.enum(['test-history', 'repo-fallback', 'default']),
  riskLevel: z.enum(['low', 'medium', 'high']).optional(),
  structuralFlags: z.array(z.object({ pattern: flakyPatternSchema, rationale: z.string() })),
});

export const ciAnnotateInputSchema = z.object({
  confidence: z.number().min(0).max(1),
  signals: confidenceSignalsSchema,
  fellBackToRunAll: z.boolean(),
  estimatedMinutesSaved: z.number(),
  /** Empty when `fellBackToRunAll` is true — there's no per-test rationale for "we ran everything". */
  selections: z.array(reportedSelectionSchema),
  totalTestCount: z.number(),
  /** New or historically-unstable tests that received a repeat-run budget. Empty when there are none. */
  flakyBudgets: z.array(flakyBudgetEntrySchema),
  /**
   * Anything that went wrong or looked off during this run — a model
   * response that omitted a test, a path it invented, or the selection call
   * failing outright. Surfaced in the report rather than swallowed: a
   * silently-degraded run that looks identical to a clean one is exactly how
   * a tool like this loses trust.
   */
  warnings: z.array(z.string()).optional(),
  /**
   * What this run actually cost. Reported because a tool that spends tokens
   * on every pull request should say how many, in the same place it claims
   * to have saved you time — otherwise the saving is the only half of the
   * trade anyone ever sees.
   */
  usage: z
    .object({
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      totalTokens: z.number().optional(),
      latencyMs: z.number().optional(),
    })
    .optional(),
});

export const ciAnnotateOutputSchema = z.object({
  markdown: z.string(),
});

export type CiAnnotateInput = z.infer<typeof ciAnnotateInputSchema>;
export type ReportedSelection = z.infer<typeof reportedSelectionSchema>;
export type ReportedFlakyBudget = z.infer<typeof flakyBudgetEntrySchema>;

function formatMinutes(minutes: number): string {
  return minutes === 1 ? '1 minute' : `${minutes % 1 === 0 ? minutes : minutes.toFixed(1)} minutes`;
}

function bySection(selections: ReportedSelection[], bucket: ReportedSelection['bucket']): ReportedSelection[] {
  return selections.filter((s) => s.bucket === bucket);
}

/**
 * Returns '' for an empty bucket, so an absent section costs nothing in the
 * final report rather than an empty heading. No trailing newline — sections
 * are joined with a blank line between them by the caller, so one here would
 * double up.
 */
function renderSection(title: string, icon: string, entries: ReportedSelection[]): string {
  if (entries.length === 0) return '';
  const lines = entries.map((e) => `- \`${e.path}\` — ${e.rationale} (confidence ${e.confidence.toFixed(2)})`);
  return `### ${icon} ${title}\n\n${lines.join('\n')}`;
}

/** Returns '' when there's nothing to report — most runs touch no new or historically-unstable tests. */
function renderFlakySection(budgets: ReportedFlakyBudget[]): string {
  if (budgets.length === 0) return '';

  const lines = budgets.map((b) => {
    const risk = b.riskLevel ? `, risk ${b.riskLevel}` : '';
    const runWord = b.budget === 1 ? 'run' : 'runs';
    const header = `- \`${b.testPath}\` — **${b.budget} repeat ${runWord}** (prior: ${b.priorSource}${risk})`;
    if (b.structuralFlags.length === 0) return header;
    const flagLines = b.structuralFlags.map((f) => `  - *${f.pattern}*: ${f.rationale}`);
    return [header, ...flagLines].join('\n');
  });

  return `### 🎲 Flaky risk\n\n${lines.join('\n')}`;
}

/** Returns '' when no usage was recorded — e.g. a run that never reached the model. */
function renderUsageLine(usage: CiAnnotateInput['usage']): string {
  if (!usage) return '';
  const parts: string[] = [];
  if (usage.totalTokens !== undefined) parts.push(`${usage.totalTokens.toLocaleString()} tokens`);
  else if (usage.inputTokens !== undefined) parts.push(`${usage.inputTokens.toLocaleString()} input tokens`);
  if (usage.latencyMs !== undefined) parts.push(`${(usage.latencyMs / 1000).toFixed(1)}s`);
  if (parts.length === 0) return '';
  return `*This run cost ${parts.join(' · ')}.*`;
}

/** Returns '' on a clean run, which is most of them. */
function renderWarningsSection(warnings: string[]): string {
  if (warnings.length === 0) return '';
  return `### ⚠️ Warnings\n\n${warnings.map((w) => `- ${w}`).join('\n')}`;
}

function renderSignalsTable(signals: CiAnnotateInput['signals']): string {
  return [
    '<details>',
    '<summary>Confidence signals</summary>',
    '',
    '| Signal | Value |',
    '|---|---|',
    `| Diff completeness | ${signals.diffCompleteness.toFixed(2)} |`,
    `| Graph coverage | ${signals.graphCoverage.toFixed(2)} |`,
    `| Graph certainty | ${signals.graphCertainty.toFixed(2)} |`,
    `| Selection completeness | ${signals.selectionCompleteness.toFixed(2)} |`,
    '',
    '</details>',
  ].join('\n');
}

const FOOTNOTE =
  '*Estimated minutes saved assumes 0.1 min/unit test, 0.5 min/integration test, 2 min/e2e test — ' +
  'placeholders until real historical run-time data is tracked, not measurements. ' +
  'Confidence is a weighted score over observable signals — never invented by the model — ' +
  "and this run's threshold is a starting value pending further calibration. Flaky repeat-run budgets " +
  'come from a formula over observed failure rate, not from a model guess — structural flags only ever ' +
  'raise the prior that formula runs on.*';

/**
 * Renders the final Markdown report. Pure formatting — every number it
 * prints was computed elsewhere (`confidence.ts` for the score,
 * `impact-agent.ts` for the selections, the workflow for the estimate); this
 * function's only job is presenting them honestly.
 */
export function renderReport(input: CiAnnotateInput): string {
  const sections: string[] = ['## Testpilot test selection'];

  if (input.fellBackToRunAll) {
    sections.push(
      `**Confidence: ${input.confidence.toFixed(2)}** (threshold ${CONFIDENCE_THRESHOLD}) — below threshold. ` +
        'Falling back to running the full suite as a safety net; nothing was skipped this run.\n\n' +
        `- ▶️ **${input.totalTestCount} test${input.totalTestCount === 1 ? '' : 's'} run** (all of them)\n` +
        '- ⏭️ **0 skipped** — **0 minutes** saved this run',
    );
  } else {
    const mustRun = bySection(input.selections, 'must-run');
    const shouldRun = bySection(input.selections, 'should-run');
    const skip = bySection(input.selections, 'skip');

    sections.push(
      `**Confidence: ${input.confidence.toFixed(2)}** (threshold ${CONFIDENCE_THRESHOLD}) — reasoning trusted, running the selected set.\n\n` +
        `- ✅ **${mustRun.length} must-run**\n` +
        `- 🟡 **${shouldRun.length} should-run**\n` +
        `- ⏭️ **${skip.length} skipped** — estimated **${formatMinutes(input.estimatedMinutesSaved)}** saved`,
    );

    for (const section of [renderSection('Must run', '✅', mustRun), renderSection('Should run', '🟡', shouldRun), renderSection('Skipped', '⏭️', skip)]) {
      if (section) sections.push(section);
    }
  }

  const flakySection = renderFlakySection(input.flakyBudgets);
  if (flakySection) sections.push(flakySection);

  const warningsSection = renderWarningsSection(input.warnings ?? []);
  if (warningsSection) sections.push(warningsSection);

  sections.push(renderSignalsTable(input.signals));

  const usageLine = renderUsageLine(input.usage);
  if (usageLine) sections.push(usageLine);

  sections.push(FOOTNOTE);

  return sections.join('\n\n');
}

export const ciAnnotateTool = createTool({
  id: 'ci-annotate-tool',
  description:
    'Renders a test-selection result into a Markdown PR comment: what runs, what was skipped and why, ' +
    'the confidence score and its threshold, estimated minutes saved with its assumptions stated plainly, ' +
    'and an explicit fell-back-to-run-all state when confidence was too low to trust.',
  inputSchema: ciAnnotateInputSchema,
  outputSchema: ciAnnotateOutputSchema,
  execute: async (inputData) => ({ markdown: renderReport(inputData) }),
});
