import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getRepoFailureRate, getTestFailureRate, recordTestRun } from './test-history-tool.ts';

// A fresh repo root per test — the history database lives inside it, at
// <repoRoot>/.testpilot-cache/test-history.db — so tests never share state.
let repoRoot: string;

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'testpilot-history-'));
});

afterEach(() => {
  // @libsql/client's local (file:) Node driver memory-maps the database file
  // and, confirmed by direct reproduction, does not release that mapping on
  // close() within the same process — even after several seconds of
  // waiting. It only releases on process exit. This is a real, upstream
  // driver/platform limitation on Windows, not something this module's own
  // close() handling can fix (every function here does call close()
  // correctly). Best-effort cleanup, not a hard requirement: the OS temp
  // directory is cleaned by the system regardless, and failing the suite
  // over a known, external limitation would be the wrong trade.
  try {
    rmSync(repoRoot, { recursive: true, force: true });
  } catch {
    // Expected on Windows — see above.
  }
});

describe('recordTestRun + getTestFailureRate', () => {
  it('returns undefined for a test that has never been recorded', async () => {
    expect(await getTestFailureRate(repoRoot, 'src/never-run.test.ts')).toBeUndefined();
  });

  it('accumulates outcomes rather than overwriting them', async () => {
    await recordTestRun(repoRoot, 'src/flaky.test.ts', 'pass');
    await recordTestRun(repoRoot, 'src/flaky.test.ts', 'fail');
    await recordTestRun(repoRoot, 'src/flaky.test.ts', 'pass');
    await recordTestRun(repoRoot, 'src/flaky.test.ts', 'pass');

    const stats = await getTestFailureRate(repoRoot, 'src/flaky.test.ts');
    expect(stats).toEqual({ totalRuns: 4, failCount: 1, failureRate: 0.25 });
  });

  it('keeps different tests independent', async () => {
    await recordTestRun(repoRoot, 'src/a.test.ts', 'fail');
    await recordTestRun(repoRoot, 'src/b.test.ts', 'pass');

    expect(await getTestFailureRate(repoRoot, 'src/a.test.ts')).toEqual({ totalRuns: 1, failCount: 1, failureRate: 1 });
    expect(await getTestFailureRate(repoRoot, 'src/b.test.ts')).toEqual({ totalRuns: 1, failCount: 0, failureRate: 0 });
  });

  it('survives across separate connections to the same repo — the exit gate, directly', async () => {
    // Every exported function opens and closes its own connection already;
    // this test's real point is that nothing in-memory is doing the work —
    // two calls with no shared state between them still see the same data,
    // exactly as "kill the process, re-run" requires.
    await recordTestRun(repoRoot, 'src/persisted.test.ts', 'fail');
    const afterFirstConnection = await getTestFailureRate(repoRoot, 'src/persisted.test.ts');

    await recordTestRun(repoRoot, 'src/persisted.test.ts', 'pass');
    const afterSecondConnection = await getTestFailureRate(repoRoot, 'src/persisted.test.ts');

    expect(afterFirstConnection).toEqual({ totalRuns: 1, failCount: 1, failureRate: 1 });
    expect(afterSecondConnection).toEqual({ totalRuns: 2, failCount: 1, failureRate: 0.5 });
  });
});

describe('getRepoFailureRate', () => {
  it('returns undefined for a repo with no recorded history at all', async () => {
    expect(await getRepoFailureRate(repoRoot)).toBeUndefined();
  });

  it('aggregates across every test in the repo', async () => {
    await recordTestRun(repoRoot, 'src/a.test.ts', 'pass');
    await recordTestRun(repoRoot, 'src/a.test.ts', 'fail');
    await recordTestRun(repoRoot, 'src/b.test.ts', 'pass');
    await recordTestRun(repoRoot, 'src/b.test.ts', 'pass');

    expect(await getRepoFailureRate(repoRoot)).toEqual({ totalRuns: 4, failCount: 1, failureRate: 0.25 });
  });
});
