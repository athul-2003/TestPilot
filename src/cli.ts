#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

import { triageWorkflow } from './mastra/workflows/triage-workflow.ts';

/**
 * The command-line entry point — what `npx testpilot` (once published) or
 * the composite GitHub Action actually invokes. Every earlier phase built
 * and verified the engine directly, through `triageWorkflow.createRun()` in
 * one-off scripts; this is the first place a real `git diff` against a real
 * merge base gets computed for real, rather than a diff
 * string handed in by hand.
 */

const execFileAsync = promisify(execFile);

interface CliOptions {
  repoRoot: string;
  base: string;
  diffFile?: string;
  json: boolean;
  outFile?: string;
}

function printUsage(): void {
  console.log(`Usage: testpilot [options]

Options:
  --repo-root <path>   Repository to analyse (default: current directory)
  --base <ref>         Branch to diff against (default: $GITHUB_BASE_REF in
                        GitHub Actions, otherwise "main")
  --diff-file <path>   Use a diff from this file instead of running git
  --json                Print the full structured result instead of the
                        rendered Markdown report
  --out <path>          Write output to this file instead of stdout
  -h, --help            Show this message
`);
}

export function parseArgs(argv: string[]): CliOptions | 'help' {
  const options: CliOptions = {
    repoRoot: process.cwd(),
    base: process.env.GITHUB_BASE_REF ?? 'main',
    json: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        return 'help';
      case '--repo-root':
        options.repoRoot = path.resolve(requireValue(argv, ++i, arg));
        break;
      case '--base':
        options.base = requireValue(argv, ++i, arg);
        break;
      case '--diff-file':
        options.diffFile = requireValue(argv, ++i, arg);
        break;
      case '--json':
        options.json = true;
        break;
      case '--out':
        options.outFile = requireValue(argv, ++i, arg);
        break;
      default:
        throw new Error(`Unrecognised argument: ${arg}. Run with --help for usage.`);
    }
  }

  return options;
}

/** `String(someObject)` collapses to the useless "[object Object]" — this actually surfaces what went wrong. */
export function formatUnknown(value: unknown): string {
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined) throw new Error(`${flag} requires a value.`);
  return value;
}

/**
 * Computes `git diff <merge-base> HEAD` — the same string
 * shape whether run locally, in Studio, or from the Action.
 *
 * `git merge-base` needs enough history to find the common ancestor. A
 * shallow checkout (GitHub Actions' `actions/checkout` default is depth 1)
 * will make this fail outright rather than silently produce a wrong diff —
 * the error message says so, because a shallow-checkout failure is easy to
 * misread as "Testpilot is broken" instead of "the checkout step needs
 * fetch-depth: 0".
 */
async function getMergeBaseDiff(repoRoot: string, base: string): Promise<string> {
  const baseRef = base.includes('/') ? base : `origin/${base}`;

  let mergeBase: string;
  try {
    const result = await execFileAsync('git', ['merge-base', baseRef, 'HEAD'], { cwd: repoRoot });
    mergeBase = result.stdout.trim();
  } catch (cause) {
    throw new Error(
      `Could not find a merge base against "${baseRef}" in ${repoRoot}. ` +
        'This usually means the checkout is shallow — if running in CI, use ' +
        '"actions/checkout" with "fetch-depth: 0".',
      { cause },
    );
  }

  const { stdout: diff } = await execFileAsync('git', ['diff', mergeBase, 'HEAD'], {
    cwd: repoRoot,
    maxBuffer: 20 * 1024 * 1024,
  });
  return diff;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options === 'help') {
    printUsage();
    return;
  }

  const diff = options.diffFile
    ? readFileSync(options.diffFile, 'utf8')
    : await getMergeBaseDiff(options.repoRoot, options.base);

  const run = await triageWorkflow.createRun();
  const result = await run.start({ inputData: { repoRoot: options.repoRoot, diff } });

  if (result.status !== 'success') {
    const detail = result.status === 'failed' ? formatUnknown(result.error) : result.status;
    throw new Error(`triageWorkflow did not succeed (status: ${result.status}): ${detail}`);
  }

  const output = options.json ? JSON.stringify(result.result, null, 2) : result.result.report;

  if (options.outFile) {
    writeFileSync(options.outFile, output, 'utf8');
  } else {
    console.log(output);
  }

  // Testpilot reports; it does not gate the build. A low-confidence,
  // fell-back-to-run-all result is a successful run that recommends running
  // everything — not a CLI failure. The exit code reflects whether Testpilot
  // itself worked, never what it concluded.
}

// Only run when this file is executed directly (`node src/cli.ts`), never as
// a side effect of importing it — a test file imports `parseArgs` and
// `formatUnknown` for direct testing, and that import must not trigger a
// real git diff and a real model call.
const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMainModule) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
