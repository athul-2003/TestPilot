/**
 * Shared configuration, read once from the environment.
 *
 * Everything tunable lives here rather than scattered through the code, so
 * there is one place to look when behaviour needs to change — and one place
 * where the defaults are visible and documented.
 */

/**
 * The everyday working model.
 *
 * Mastra's model router takes a plain `"provider/model"` string — no SDK
 * wiring, no provider objects. Groq is the default because development means
 * running the same prompt hundreds of times, and paying per-token for that is
 * how a side project quietly becomes expensive.
 *
 * This also keeps Testpilot honest about its own claim: a tool that says it is
 * self-hostable should not be welded to one vendor. If swapping the provider
 * is a one-line change during development, it stays a one-line change for
 * whoever adopts it.
 *
 * Verify IDs against the live list before changing this:
 *   node .claude/skills/mastra/scripts/provider-registry.mjs --provider groq
 */
export const MODEL = process.env.TESTPILOT_MODEL ?? 'groq/openai/gpt-oss-120b';

/**
 * The model intended for calls that must be right — ambiguous test-selection
 * decisions and calibration runs whose numbers end up published and have to
 * survive scrutiny.
 *
 * **Not currently wired to anything.** Every agent (impact, flaky, smoke)
 * hardcodes {@link MODEL}, and this constant is unread outside its own
 * definition. Dynamic per-call model tiering — routing an ambiguous decision
 * to a stronger model mid-run — is a real feature this project doesn't have
 * yet, not a bug being papered over; recorded here instead of left as a
 * silent gap between what the code claims and what it does.
 */
export const CRITICAL_MODEL =
  process.env.TESTPILOT_MODEL_CRITICAL ?? 'openai/gpt-5.4-mini';

/**
 * Below this confidence, Testpilot stops trusting its own selection and falls
 * back to running the whole suite.
 *
 * 0.7 is a reasoned starting value, not a measured one — the regression-guard eval calibrates it
 * against the fixture repo, and the README publishes whatever the evidence
 * supports. Treat it as provisional until then.
 */
export const CONFIDENCE_THRESHOLD = Number(
  process.env.TESTPILOT_CONFIDENCE_THRESHOLD ?? 0.7,
);

/**
 * Hard ceiling on diff size, in characters.
 *
 * Past this, the diff is truncated per-file and confidence drops, rather than
 * quietly sending the model a partial picture and letting it reason
 * confidently about code it never saw.
 */
export const MAX_DIFF_CHARS = 40_000;

/**
 * How many hops the import graph follows when looking for a changed file's
 * dependents, before giving up and flagging `depthLimitReached`.
 *
 * A real dependency chain rarely runs deeper than this; a depth limit this
 * low mainly protects against pathological graphs (a cycle, or a repo with
 * unusually tangled imports) turning a single changed file into an
 * unbounded walk.
 */
export const MAX_IMPACT_DEPTH = 6;

/**
 * Cache directory name, created inside whichever repo Testpilot is analysing
 * — not this one. Holds the import-graph cache and the flaky-test
 * history database — everything that's per-repo, disposable, and
 * must stay gitignored in every repo Testpilot runs against. This project's
 * own .gitignore already covers it.
 */
export const TESTPILOT_CACHE_DIRNAME = '.testpilot-cache';

/** Filename of the flaky-test history database, inside {@link TESTPILOT_CACHE_DIRNAME}. */
export const TEST_HISTORY_DB_FILENAME = 'test-history.db';

/**
 * The confidence level a repeat-run budget is solved for:
 * how sure we want to be, after seeing nothing but green runs, that we
 * weren't just lucky. Higher means more repeats required to trust a result,
 * for the same observed instability.
 */
export const FLAKY_TARGET_CONFIDENCE = 0.95;

/**
 * Hard ceiling on repeat-run budgets, regardless of how unstable a test's
 * history looks. Bounds the CI cost a single unreliable test can impose —
 * past this many repeats, the answer is "fix the test," not "run it more."
 */
export const FLAKY_REPEAT_CAP = 10;

/**
 * How many flaky-budget estimates the triage workflow runs at once.
 *
 * Each one can make a model call and opens its own short-lived connection to
 * the repo's history database, so an unbounded fan-out over a large diff
 * means dozens of concurrent provider requests (inviting rate limits) and
 * dozens of concurrent SQLite connections to one small file. A modest cap
 * keeps the step comfortably parallel without either pile-up.
 */
export const FLAKY_ESTIMATE_CONCURRENCY = 4;

/**
 * Fallback failure-rate prior for a test with no history of its own, in a
 * repo with no recorded history at all — the "we genuinely know nothing yet"
 * case. A modest, deliberately non-zero starting assumption: treating a
 * total unknown as "0% chance of failure" would hand every brand-new test
 * the minimum possible repeat budget, which is the opposite of cautious.
 */
export const DEFAULT_FLAKE_PRIOR = 0.05;

/**
 * Assumed CI minutes per test, by type, used only to estimate minutes saved
 * by skipping.
 *
 * **These are placeholders, not measurements.** Testpilot has no real
 * per-test timing data until `test-history-tool` starts recording
 * actual run durations. Every place this constant is used must say so
 * explicitly in its output — "estimated minutes saved" is the number people
 * screenshot, and a hidden assumption here is exactly what would make the
 * whole tool read as marketing instead of evidence.
 */
export const ASSUMED_MINUTES_PER_TEST: Record<'unit' | 'integration' | 'e2e', number> = {
  unit: 0.1,
  integration: 0.5,
  e2e: 2,
};
