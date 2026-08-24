import fs from 'node:fs';
import path from 'node:path';

import { createClient, type Client, type Row } from '@libsql/client';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { TEST_HISTORY_DB_FILENAME, TESTPILOT_CACHE_DIRNAME } from '../config.ts';

/**
 * Records and reads per-test pass/fail history — the **statistical** half of
 * the flaky budget, as opposed to `flaky-agent.ts`'s
 * **structural** half. Testpilot doesn't run tests itself; this tool exists
 * for CI to call back into after it does, so that over time Testpilot builds
 * real evidence about which tests are actually unreliable, rather than
 * guessing from source code alone every time.
 *
 * Persisted with `@libsql/client` directly, not through Mastra's
 * `LibSQLStore` — `LibSQLStore`'s domains (memory, workflows, agents, scores,
 * ...) are a fixed schema for Mastra's own internal concerns, with no
 * generic "store your own table" API (its underlying client is a private
 * field). Flaky history is exactly the kind of small custom relational data
 * a plain SQL client is the right tool for.
 *
 * The database lives at `<repoRoot>/.testpilot-cache/test-history.db` — one
 * file per analysed repo, the same convention the import-graph cache
 * already uses, so flaky history for one repo never mixes with another's.
 */

export const testHistoryInputSchema = z.object({
  repoRoot: z.string().describe('Absolute path to the repository being analysed.'),
  testPath: z.string().describe('Repo-relative path of the test file this outcome is for.'),
  outcome: z.enum(['pass', 'fail']).describe("This test's result for one CI run."),
});

export const testHistoryOutputSchema = z.object({
  totalRuns: z.number().describe('Total outcomes recorded for this test, including the one just recorded.'),
  failCount: z.number(),
  failureRate: z.number().min(0).max(1),
});

export type TestHistoryStats = z.infer<typeof testHistoryOutputSchema>;

function dbPathFor(repoRoot: string): string {
  return path.join(repoRoot, TESTPILOT_CACHE_DIRNAME, TEST_HISTORY_DB_FILENAME);
}

async function ensureSchema(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS test_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_path TEXT NOT NULL,
      outcome TEXT NOT NULL CHECK (outcome IN ('pass', 'fail')),
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_test_runs_test_path ON test_runs(test_path)`);
}

/**
 * Database files whose schema this process has already created.
 *
 * `CREATE TABLE IF NOT EXISTS` is cheap but not free, and the triage
 * workflow calls in here once per candidate test — running two DDL
 * statements per call is pure overhead after the first. The memo can go
 * stale only if the cache directory is deleted out from under a long-lived
 * process, which {@link withClient} detects and recovers from rather than
 * failing on.
 */
const schemaReady = new Set<string>();

function isMissingTableError(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}

/**
 * Runs one unit of work against the repo's history database, handling the
 * whole connection lifecycle: create the directory and file on first use,
 * ensure the schema exists, and always close the connection afterwards.
 *
 * Every exported function below goes through here rather than repeating
 * that sequence itself — three near-identical copies of open/ensure/close
 * is three places for a leaked connection or a missing `close()` to hide.
 *
 * A connection is opened and closed per call rather than held open and
 * shared: that's what makes "kill the process and re-run" behave
 * identically to two calls in one process, which is a property this
 * module's own tests assert directly.
 *
 * libsql's `file:` URLs want forward slashes even on Windows — an absolute
 * Windows path's backslashes are normalized here rather than left for the
 * driver to potentially misparse.
 */
async function withClient<T>(repoRoot: string, work: (client: Client) => Promise<T>): Promise<T> {
  const dbPath = dbPathFor(repoRoot);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const client = createClient({ url: `file:${dbPath.split(path.sep).join('/')}` });

  try {
    if (!schemaReady.has(dbPath)) {
      await ensureSchema(client);
      schemaReady.add(dbPath);
    }

    try {
      return await work(client);
    } catch (error) {
      if (!isMissingTableError(error)) throw error;
      // The memo said this database was already set up, but the table is
      // gone — the cache directory was deleted while this process kept
      // running. Recreate and retry once instead of failing on something
      // this function can fix itself.
      schemaReady.delete(dbPath);
      await ensureSchema(client);
      schemaReady.add(dbPath);
      return await work(client);
    }
  } finally {
    client.close();
  }
}

function statsFromCounts(totalRuns: number, failCount: number): TestHistoryStats {
  return { totalRuns, failCount, failureRate: totalRuns > 0 ? failCount / totalRuns : 0 };
}

/** Turns a `COUNT(*)`/`SUM(...)` row into stats, or `undefined` when nothing has been recorded yet. */
function statsFromRow(row: Row | undefined): TestHistoryStats | undefined {
  const total = Number(row?.total ?? 0);
  if (total === 0) return undefined;
  return statsFromCounts(total, Number(row?.fails ?? 0));
}

/** Appends one outcome to a test's history. Never deletes or overwrites — the whole point is an accumulating record. */
export async function recordTestRun(repoRoot: string, testPath: string, outcome: 'pass' | 'fail'): Promise<void> {
  await withClient(repoRoot, async (client) => {
    await client.execute({
      sql: 'INSERT INTO test_runs (test_path, outcome) VALUES (?, ?)',
      args: [testPath, outcome],
    });
  });
}

/** A specific test's recorded history, or `undefined` if it has never been recorded. */
export async function getTestFailureRate(repoRoot: string, testPath: string): Promise<TestHistoryStats | undefined> {
  return withClient(repoRoot, async (client) => {
    const result = await client.execute({
      sql: `SELECT COUNT(*) AS total, SUM(CASE WHEN outcome = 'fail' THEN 1 ELSE 0 END) AS fails
            FROM test_runs WHERE test_path = ?`,
      args: [testPath],
    });
    return statsFromRow(result.rows[0]);
  });
}

/**
 * The repo-wide failure rate across every recorded test — the fallback
 * prior D4 uses for a brand-new test with no history of its own yet.
 * Returns `undefined` for a repo with no recorded history at all, so a
 * caller can fall back further (e.g. to an even more conservative default)
 * rather than silently treating "no data" as "0% failure rate."
 */
export async function getRepoFailureRate(repoRoot: string): Promise<TestHistoryStats | undefined> {
  return withClient(repoRoot, async (client) => {
    const result = await client.execute(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN outcome = 'fail' THEN 1 ELSE 0 END) AS fails FROM test_runs`,
    );
    return statsFromRow(result.rows[0]);
  });
}

export const testHistoryTool = createTool({
  id: 'test-history-tool',
  description:
    "Records a test's pass/fail outcome for this CI run and returns its updated historical failure rate " +
    '— the statistical evidence used to size a flaky-test repeat-run budget.',
  inputSchema: testHistoryInputSchema,
  outputSchema: testHistoryOutputSchema,
  execute: async (inputData) => {
    await recordTestRun(inputData.repoRoot, inputData.testPath, inputData.outcome);
    const stats = await getTestFailureRate(inputData.repoRoot, inputData.testPath);
    // Always defined immediately after recording — the insert above guarantees at least one row exists.
    return stats!;
  },
});
