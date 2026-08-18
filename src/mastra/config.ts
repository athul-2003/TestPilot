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
 * The model reserved for calls that must be right.
 *
 * Ambiguous test-selection decisions and the Phase 6 evaluation runs — the
 * numbers that end up in the README and have to survive scrutiny. Everything
 * else uses {@link MODEL}.
 *
 * Keep this deliberate. Every call to it spends real budget, and a tool whose
 * pitch is saving CI minutes has no business being careless with its own cost.
 */
export const CRITICAL_MODEL =
  process.env.TESTPILOT_MODEL_CRITICAL ?? 'openai/gpt-5.4-mini';

/**
 * Below this confidence, Testpilot stops trusting its own selection and falls
 * back to running the whole suite.
 *
 * 0.7 is a reasoned starting value, not a measured one — Phase 6 calibrates it
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
 * — not this one. Must stay gitignored in every repo Testpilot runs against;
 * this project's own .gitignore already covers it.
 */
export const IMPORT_GRAPH_CACHE_DIRNAME = '.testpilot-cache';
