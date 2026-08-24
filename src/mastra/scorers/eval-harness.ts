import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { MODEL } from '../config.ts';
import { triageWorkflow, type TriageResult } from '../workflows/triage-workflow.ts';
import { regressionGuardScorer } from './regression-guard.ts';
import { SCENARIOS, type ScenarioGroundTruth } from './scenario-ground-truth.ts';

/**
 * Runs every seeded scenario through the real `triageWorkflow`, cross-
 * references each one's skip list against the **real, empirically measured**
 * test outcomes (not a hand-written prediction), and produces the metrics
 * table the regression guard exists to prove.
 *
 * This is the piece that makes the regression-guard rigorous rather than
 * self-graded: `regression-guard.ts`'s scorer only ever sees data this file
 * actually measured — a real Vitest subprocess run against the scenario's
 * changed files, not an assertion about what "should" happen.
 */

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const SAMPLE_REPO_DIR = path.join(PROJECT_ROOT, 'fixtures', 'sample-repo');
const SCENARIOS_DIR = path.join(PROJECT_ROOT, 'fixtures', 'sample-repo-scenarios');
const VITEST_BIN = path.join(PROJECT_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

/**
 * Strips the repo root off an absolute path and normalizes to forward
 * slashes, regardless of OS.
 *
 * Both paths are resolved through `fs.realpathSync` before comparing —
 * a plain `startsWith` on the raw strings silently breaks wherever the OS
 * can hand back two spellings of the same path: `os.tmpdir()` returning a
 * symlink macOS itself resolves (`/var/folders/...` vs `/private/var/folders/...`),
 * or Windows drive-letter casing. A silent break here doesn't crash — it
 * just makes `actualFailedTestFiles` full of paths that never match
 * `triage.skip`'s repo-relative entries, so `regressionGuardScorer` reports
 * zero missed regressions even when one genuinely happened. That's the one
 * failure mode this function exists to prevent, so a path that still
 * doesn't resolve inside `repoRoot` after realpath throws instead of
 * silently returning something that won't match.
 */
function toRepoRelativePosix(repoRoot: string, absPath: string): string {
  const resolvedRoot = fs.realpathSync(repoRoot);
  const resolvedAbs = fs.realpathSync(absPath);
  const rel = path.relative(resolvedRoot, resolvedAbs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Vitest reported a test file outside the scenario's repo root: ${absPath} (root: ${repoRoot})`);
  }
  return rel.split(path.sep).join('/');
}

/**
 * Materializes one scenario on disk: a fresh copy of the baseline fixture,
 * with the scenario's `after/` files overlaid on top at matching relative
 * paths — the same "diff describes a real checkout" state every live
 * verification of this pipeline has relied on.
 */
function applyScenario(scenario: ScenarioGroundTruth): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `testpilot-eval-${scenario.name}-`));
  fs.cpSync(SAMPLE_REPO_DIR, tempDir, { recursive: true });
  if (scenario.afterDir) {
    const afterPath = path.join(SCENARIOS_DIR, scenario.name, scenario.afterDir);
    fs.cpSync(afterPath, tempDir, { recursive: true, force: true });
  }
  return tempDir;
}

interface VitestJsonReport {
  testResults: Array<{ name: string; status: string }>;
}

/**
 * Runs the real Vitest suite against a materialized repo and returns which
 * test files actually failed — the empirical ground truth the regression
 * guard checks against. Invoked as `node <vitest.mjs> run --root <dir>
 * --reporter=json` directly, rather than through `npx`: `execFile('npx', …)`
 * fails outright on Windows (`ENOENT` — it needs shell-based `.cmd`
 * resolution `execFile` doesn't do), confirmed by direct reproduction before
 * settling on this approach. Invoking the local binary's JS entry point via
 * `node` works identically on every platform and needs no shell.
 */
async function runRealVitest(repoRoot: string): Promise<{ failedTestFiles: string[]; passedTestFiles: string[] }> {
  let stdout: string;
  try {
    const result = await execFileAsync(process.execPath, [VITEST_BIN, 'run', '--root', repoRoot, '--reporter=json'], {
      cwd: PROJECT_ROOT,
      maxBuffer: 20 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err) {
    // Vitest exits non-zero when any test fails — expected and informative
    // here (scenario 02's deliberate bug), not an execution failure. The
    // JSON report is still on stdout regardless of exit code.
    const execErr = err as { stdout?: string };
    if (typeof execErr.stdout !== 'string' || execErr.stdout.length === 0) throw err;
    stdout = execErr.stdout;
  }

  const parsed = JSON.parse(stdout) as VitestJsonReport;
  const failedTestFiles: string[] = [];
  const passedTestFiles: string[] = [];
  for (const result of parsed.testResults) {
    const relPath = toRepoRelativePosix(repoRoot, result.name);
    if (result.status === 'failed') failedTestFiles.push(relPath);
    else if (result.status === 'passed') passedTestFiles.push(relPath);
  }
  return { failedTestFiles, passedTestFiles };
}

export interface ScenarioRunResult {
  scenario: ScenarioGroundTruth;
  triage: TriageResult;
  actualFailedTestFiles: string[];
  regressionScore: number;
  regressionReason: string;
  /** How many of the hand-derived "ideal" skip set Testpilot actually skipped — an efficiency measure, distinct from correctness. */
  idealSkipAchieved: number;
  idealSkipTotal: number;
}

/**
 * Runs one scenario end to end: materialize it, run the real workflow, run
 * the real test suite (when there's a valid post-change state to run it
 * against), score it, and clean up.
 */
export async function runScenario(scenario: ScenarioGroundTruth): Promise<ScenarioRunResult> {
  const tempDir = applyScenario(scenario);
  try {
    const diff = fs.readFileSync(path.join(SCENARIOS_DIR, scenario.name, scenario.diffFile), 'utf8');

    const run = await triageWorkflow.createRun();
    const result = await run.start({ inputData: { repoRoot: tempDir, diff } });
    if (result.status !== 'success') {
      throw new Error(`triageWorkflow did not succeed for scenario "${scenario.name}": ${result.status}`);
    }
    const triage = result.result;

    // Scenario 06 references a path that doesn't exist anywhere — there is
    // no valid post-change state to run real tests against, and none is
    // needed: its point is purely to verify the low-confidence fallback.
    const actualFailedTestFiles = scenario.afterDir ? (await runRealVitest(tempDir)).failedTestFiles : [];

    const scoreResult = await regressionGuardScorer.run({
      input: { scenarioName: scenario.name, actualFailedTestFiles },
      output: { skip: triage.skip },
    });

    const idealSkipAchieved = scenario.idealSafeToSkip.filter((p) => triage.skip.includes(p)).length;

    return {
      scenario,
      triage,
      actualFailedTestFiles,
      regressionScore: scoreResult.score,
      regressionReason: scoreResult.reason ?? '',
      idealSkipAchieved,
      idealSkipTotal: scenario.idealSafeToSkip.length,
    };
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Confirmed Windows limitation: @libsql/client's local
      // driver — touched here because every scenario's flaky-budget step
      // opens the scenario's history database — doesn't release its
      // memory-mapped file handle until process exit. Best-effort only.
    }
  }
}

/** Runs every scenario in sequence — deliberately not parallel, to stay gentle on the model provider's rate limits for what is an occasional, not hot-path, eval run. */
export async function runAllScenarios(): Promise<ScenarioRunResult[]> {
  const results: ScenarioRunResult[] = [];
  for (const scenario of SCENARIOS) {
    results.push(await runScenario(scenario));
  }
  return results;
}

function renderScenarioRow(r: ScenarioRunResult): string {
  const missed = r.regressionScore === 0 ? '**YES**' : 'no';
  return (
    `| ${r.scenario.name} | ${r.triage.confidence.toFixed(2)} | ${r.triage.fellBackToRunAll ? 'yes' : 'no'} ` +
    `| ${r.triage.mustRun.length} | ${r.triage.shouldRun.length} | ${r.triage.skip.length} ` +
    `| ${r.idealSkipAchieved}/${r.idealSkipTotal} | ${missed} |`
  );
}

function renderCalibrationLine(r: ScenarioRunResult): string {
  const expectation = r.scenario.expectFallback ? 'expected fallback' : 'expected confident';
  const actual = r.triage.fellBackToRunAll ? 'fell back' : 'stayed confident';
  const match = r.scenario.expectFallback === r.triage.fellBackToRunAll ? '✅' : '❌';
  return `- ${match} **${r.scenario.name}** — confidence ${r.triage.confidence.toFixed(2)}, ${expectation}, actually ${actual}.`;
}

/**
 * Renders the metrics table the worksheet asks for: missed regressions
 * (the headline number), estimated CI-minute reduction, confidence
 * calibration per scenario, and an honest note on what this fixture does
 * and doesn't exercise.
 */
export function renderMetricsReport(results: ScenarioRunResult[]): string {
  const missedCount = results.filter((r) => r.regressionScore === 0).length;
  const totalMinutesSaved = results.reduce((sum, r) => sum + r.triage.estimatedMinutesSaved, 0);
  const idealAchieved = results.reduce((sum, r) => sum + r.idealSkipAchieved, 0);
  const idealTotal = results.reduce((sum, r) => sum + r.idealSkipTotal, 0);

  const lines: string[] = [
    '# Testpilot regression-guard evaluation',
    '',
    // Which model produced these numbers is not a footnote — selection
    // efficiency varies enormously by model tier, so a report that doesn't
    // name its model isn't reproducible and invites the reader to assume
    // the figures hold everywhere.
    `_Model: \`${MODEL}\`_`,
    '',
    `**Missed regressions: ${missedCount} of ${results.length} scenarios.** This is the trust metric — it must read 0.`,
    '',
    `**Estimated CI-minute reduction:** ${totalMinutesSaved.toFixed(1)} minutes across ${results.length} scenarios ` +
      '(placeholder per-test-type assumptions — see the report footnote in each run; not a measurement of real test durations).',
    '',
    `**Selection efficiency:** ${idealAchieved}/${idealTotal} of the hand-derived "safe to skip" tests were actually ` +
      'skipped — the gap between this and 100% is real tests run that a perfectly-informed tool would not have needed to.',
    '',
    '| Scenario | Confidence | Fell back | Must-run | Should-run | Skip | Ideal skip achieved | Missed regression |',
    '|---|---|---|---|---|---|---|---|',
    ...results.map(renderScenarioRow),
    '',
    '## Confidence calibration',
    '',
    ...results.map(renderCalibrationLine),
    '',
    '## Flaky-flag precision',
    '',
    'Not measured by this fixture — none of the six scenarios seeds a new or historically-unstable test ' +
      '(that would duplicate the flaky mechanism\'s own live verification, which already exercised it directly: ' +
      'a real Groq call correctly flagged a genuine `setTimeout`-based flaky pattern with a rationale naming the exact line).',
  ];

  return lines.join('\n');
}
