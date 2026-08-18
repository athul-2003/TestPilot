# Testpilot — Execution Worksheet

> **What this is:** the working checklist that turns [PROJECT_IDEA_TESTPILOT.md](PROJECT_IDEA_TESTPILOT.md) into ordered, gated phases. The brief says *what and why*; this worksheet says *what to do next, and how we know it's done*.
>
> **How to use it:** work one phase at a time, top to bottom. Every phase gets its own branch, its own PR, and must pass its **Exit gate** before the next phase starts. Tick the boxes as you go — this file is the single source of truth for project status.
>
> Mastra API facts below were verified against the live docs on **2026-08-18**. Re-verify at the start of each phase; the framework moves fast.

---

## Status board

| Phase | Name | Branch prefix | Status |
|---|---|---|---|
| 0 | Hello Mastra — environment proof | `phase/0-hello-mastra` | ✅ Merged |
| 1 | Read a diff | `phase/1-git-diff-tool` | ✅ Merged |
| 2 | Map the impact | `phase/2-impact-graph` | ✅ Merged |
| 3 | Select tests | `phase/3-test-selection` | ✅ Merged |
| 4 | Report, confidence & fallback | `phase/4-report-confidence` | ✅ Merged |
| 5 | Flaky budget | `phase/5-flaky-budget` | ✅ Merged |
| 6 | Fixture repo & regression-guard eval | `phase/6-eval-harness` | ⬜ Not started |
| 7 | Ship — README, Action, demo | `phase/7-ship` | ⬜ Not started |
| 8 | Launch — community & templates | `phase/8-launch` | ⬜ Not started |

Legend: ⬜ Not started · 🟡 In progress · ✅ Merged to `main`

---

## Ground rules (apply to every phase)

1. **One phase, one branch, one PR.** Cut from the latest `main`, push, open a PR, pass checks, merge. Use the `ship-phase` skill — don't improvise the git flow.
2. **Always leave the developer with something that runs.** No phase ends on a half-wired module.
3. **Explain each new concept in 1–2 plain sentences the first time it appears** (Zod schema, async/await, workflow step, structured output). The developer is learning, not pasting.
4. **The developer decides, the assistant designs.** Propose structure with a *why*; wait for approval or redirection.
5. **Cheap model by default.** `groq/openai/gpt-oss-120b` for everyday work, `openai/gpt-5.4-mini` reserved for ambiguous selection calls and evaluation runs (see D8). Verify model IDs against the live registry rather than trusting any doc, including this one: `node .claude/skills/mastra/scripts/provider-registry.mjs --provider groq`.
6. **Never commit secrets.** `OPENAI_API_KEY` lives in `.env`, which is gitignored. A committed `.env.example` documents the shape.
7. **When a wizard prompts something not covered here, paste the exact prompt** rather than guessing an answer.

---

## Phase 0 — Hello Mastra (environment proof)

**Goal:** prove the machine runs a Mastra project and the OpenAI key works. No Testpilot logic yet.

**Concepts to introduce:** what a Mastra project is (agents + tools + workflows registered on one `Mastra` instance), what Studio is, why `"type": "module"` matters.

**Steps**
- [x] Confirm Node. **The brief is out of date here:** `create-mastra` now requires **≥22.13.0** and crashes outright on 20. Installed 24.19.0 LTS.
- [x] Scaffold with `npm create mastra@latest --empty`. **The default template has changed** — it now produces an "Agent Harness" (shell tools, task tracking, web access, schedules), far more than Testpilot needs. `--empty` gives a clean `@mastra/core` base to build up from.
- [x] Reconcile the scaffold into the repo root, not a nested folder.
- [x] Create `.env` locally; commit `.env.example` documenting every variable with no values.
- [x] Confirm `package.json` has `"type": "module"`.
- [x] Write a minimal smoke agent (`--empty` ships no sample), register it, and confirm it replies through Studio.
- [x] Add repo hygiene: Apache 2.0 `LICENSE`, `README.md`, reviewed `tsconfig.json`.
- [x] Add the `typecheck` / `lint` / `test` / `build` scripts the `ship-phase` gates depend on — without them the automated merge flow has nothing to check.

**Deliverables:** runnable Mastra project, smoke agent, `.env.example`, Apache 2.0 `LICENSE`, README, four working quality gates, and the `.claude/skills/mastra/` reference pack the scaffolder ships.

**Exit gate:** ✅ Studio starts on `http://localhost:4111` and the agent returns a real model response (232 tokens via `groq/openai/gpt-oss-120b`). `git status` shows no `.env` and no `node_modules`.

**What actually bit:** three things, none of them the folder layout the brief warned about. Node 20 was hard-blocked. `@eslint/js` defaults to v10 and conflicts with ESLint 9 — pin it. And `tsc` rejects the `.ts` import extensions the runtime requires until `allowImportingTsExtensions` is set.

**Worth knowing:** asked which model it was, the agent confidently answered "GPT-4o" while running on Groq. Models do not know their own identity. Read `provider` and `modelId` from `mastra api agent list` instead — the same mistrust applies to anything an agent asserts about itself later.

---

## Phase 1 — Read a diff

**Goal:** `src/mastra/tools/git-diff-tool.ts` — takes a unified-diff string, returns changed files plus changed function/symbol names.

**Concepts to introduce:** `createTool()`, Zod input/output schemas, why the tool's `execute` receives `(validatedInput, executionContext)`.

**Steps**
- [x] Define the Zod `inputSchema` (unified diff text) and `outputSchema` (files with path, change type, hunks, candidate symbol names, per-file `truncated` flag).
- [x] Implement unified-diff parsing by hand: file headers, rename/new/deleted markers, hunk headers, added/removed lines.
- [x] Handle the awkward cases explicitly: renames (`oldPath` + `path`), deletions, binary files (`Binary files ... differ`, no hunks), new files (`oldStart`/`oldLines` at 0), and non-TS files (`isTypeScript: false`, parsed like any other text file).
- [x] Enforce the **~40k character** ceiling from D1 — truncate per-file past the budget, with the file that *crosses* the ceiling still parsed in full so one large file can't starve every file after it. Signalled via a per-file `truncated` flag and a top-level `truncated` flag.
- [x] Save 5 fixture diffs under `fixtures/diffs/`, one per distinct case, and feed each through the live server with `mastra api tool execute git-diff-tool`.
- [x] Unit tests (Vitest) over the fixtures, plus synthetic tests for the empty-diff and truncation-ceiling cases that don't need a committed fixture.

**Note:** D1's diff-acquisition contract (`git diff` against the merge base) is **not yet wired to a live git repo** — that lands when the tool has something to call it *from* (a workflow step in Phase 4, or the Action in Phase 7). This phase builds the parser and proves it on hand-written fixtures; Phase 4 is where `git merge-base origin/main HEAD` actually runs.

**Deliverables:** `git-diff-tool.ts` (parser + `createTool()` wrapper, registered on the Mastra instance), `fixtures/diffs/*` (5 files), `git-diff-tool.test.ts` (12 tests).

**Exit gate:** ✅ Met. All four quality gates pass (typecheck, lint, 12/12 tests, build). Each of the 5 fixtures was fed through the running dev server via `mastra api tool execute git-diff-tool` and returned the correct file list, change type, hunk line numbers, and candidate symbols — verified against the live API, not just the unit tests.

**Watch out for:** confirmed in practice — `candidateSymbols` only sees lines that were actually added or removed. In the modify fixture, changing a `return` statement inside an untouched `export function subtract(...)` correctly produces *no* symbol, because the declaration line itself never appears in the diff. A first implementation of the test assumed the enclosing function name would show up; it doesn't, and shouldn't — that's exactly the "candidate, not authoritative" limitation Phase 2's AST parse exists to fix.

---

## Phase 2 — Map the impact

**Goal:** `ast-parse-tool.ts` + `import-graph-tool.ts` — given changed files, find which other files depend on them.

**Concepts to introduce:** what an AST is (code as a tree you can query), why a reverse-dependency map answers "who breaks if this changes", why caching matters.

**Steps**
- [x] Chose the **raw TypeScript compiler API** (`ts.createSourceFile`, syntactic-only, no type checker) over `ts-morph` and over a regex pass. `typescript` is already a devDependency, so this adds zero new packages; `ts-morph` is a friendlier wrapper but ~5MB of extra surface for functionality this tool only needs a syntactic parse from. Regex was rejected in the brief itself — path aliases and barrel re-exports aren't tractable with it, which the barrel-file handling below proves out concretely.
- [x] `ast-parse-tool.ts`: extracts every static import shape (default/named/namespace/side-effect/type-only), dynamic `import()` calls found anywhere in the file (not just top-level — they're expressions, not statements), every export shape (`export const`, `export default`, `export { a as b }`, `export * from`, `export { x } from`, `export * as ns from`), and every top-level declaration (function/class/interface/type/enum/variable), each tagged `isExported`.
- [x] `import-graph-tool.ts`: builds the forward graph (imports + re-export sources, treated identically — see barrel note below), inverts it to "who imports whom" on demand, caches to `<repoRoot>/.testpilot-cache/import-graph.json` (gitignored in every repo Testpilot analyses, confirmed already covered by this project's own `.gitignore`).
- [x] Path aliases: reads `tsconfig.json` via `ts.readConfigFile` (tolerates comments/trailing commas, unlike raw `JSON.parse`), resolves wildcard `paths` entries against `baseUrl`. Barrel files: see below. Dynamic `import()`: resolved through the same specifier-resolution path as static imports, when the argument is a string literal.
- [x] Cache invalidation: **mtime first, content hash second** — matching mtime trusts the cache without reading the file; a changed mtime with an unchanged hash (a fresh checkout touching files without changing them) still reuses the cached parse; only a real content change triggers a re-parse. Verified live: a second `buildImportGraph` call against a warm cache reused every entry (`filesParsed: 0`).
- [x] Transitive reach: BFS over the reverse graph, capped at `MAX_IMPACT_DEPTH` (6, in `config.ts`). Hitting the cap sets `depthLimitReached: true` so the result is honest about being possibly incomplete, rather than silently truncating.
- [x] Unit tests (36 total across the two tools) against a hand-built fixture tree at `fixtures/import-graph/` with a known shape: a plain dependency chain, a barrel, a path alias, an external package import, and a dynamic import — each asserted against the exact dependents a human would compute by reading the tree.

**Deliverables:** `ast-parse-tool.ts`, `import-graph-tool.ts`, on-disk graph cache with mtime/hash invalidation, `fixtures/import-graph/*` (11 source files + tsconfig), 36 tests.

**Exit gate:** ✅ Met — literally, not just via unit tests. `src/leaf.ts` is fixture "file A": querying it through the *running server* returned its three direct importers plus `entry.ts` at depth 2 through `mid.ts`, matching the tree's known shape exactly. `ast-parse-tool` was also run against this project's own `config.ts` and correctly extracted all six real exports.

**Watch out for — handled, not dodged:** the worksheet's warning was that a barrel's fan-out could make the blast radius look like the whole repo. The fix: **a re-export edge is recorded as a normal one-hop dependency** (`index.ts` depends on `a.ts`), never collapsed into "anyone importing the barrel directly imports everything it re-exports." Verified against the fixture: changing `barrel/a.ts` correctly reaches `barrel/index.ts` at depth 1 and `src/barrel-consumer.ts` at depth 2 — not both at depth 1 — with **both entries flagged `throughBarrel: true`** so Phase 3/4 can discount the relationship's strength without losing it entirely.

**Bug found and fixed while building this, in Phase 1's file:** every Phase 1 fixture test started failing at the start of this phase — not from anything touched here, but because `core.autocrlf=true` (the common Git-for-Windows default, active on this machine) had rewritten the fixture files to CRLF on checkout. `parseUnifiedDiff` only split on `\n`, so a header regex anchored with `$` silently stopped matching against a trailing `\r`, and every fixture returned zero files. Real `git diff` output on any `core.autocrlf=true` checkout has the same shape — this wasn't a test-only problem. Fixed in `git-diff-tool.ts` by stripping a trailing `\r` at the single point diffs get split into lines, so every downstream comparison stays CRLF-agnostic.

---

## Phase 3 — Select tests

**Goal:** `test-inventory-tool.ts` + `agents/impact-agent.ts` — classify tests into `must-run` / `should-run` / `skip`, each with a one-line human-auditable rationale.

**Concepts to introduce:** what an agent is versus a tool, structured output (`structuredOutput: { schema }` → `response.object`), why the rationale is a product feature and not a debug log.

**Steps**
- [x] `test-inventory-tool.ts`: discovers `*.test.ts` / `*.spec.ts` (reusing Phase 2's `walkTypeScriptFiles`), classifies by **filename/path marker first** (`checkout.e2e.test.ts`, `src/e2e/...`), **falling back to known testing-library imports** (`@playwright/test` → e2e, `supertest` → integration) only when the path gives no signal, **defaulting to `unit`**. Also extracts every `describe`/`it`/`test` title, including wrapped forms (`it.only`, `describe.each(...)`), by unwrapping the call chain back to its root identifier.
- [x] Selection output schema: `{ path, bucket: 'must-run'|'should-run'|'skip', rationale, confidence }`, enforced via `structuredOutput` — the model cannot return a selection without a rationale field, because the schema doesn't have an optional one.
- [x] D2 encoded directly into the agent's system instructions as a numbered rule: `must-run`/`should-run` both execute, `skip` is a real claim requiring a specific, nameable reason, and "when genuinely unsure, choose should-run over skip."
- [x] `impact-agent.ts` + a `buildPromptPayload` correlation step that combines Phase 1's `parseUnifiedDiff`, Phase 2's `computeImpactedFiles`, and this phase's `buildTestInventory` into one payload: every test in the inventory, tagged with whether it was *directly changed*, and every changed-file it's *reachable from* with hop depth and barrel status.
- [x] `structuredOutput: { schema: testSelectionOutputSchema }` → `response.object`, exactly as documented.
- [x] Every real run returns `usage` (input/output/total/reasoning tokens) and `latencyMs`, captured in `selectTests`'s return value.
- [x] Ran against real fixture diffs with the **real Groq model**, not a mock — see verification below.

**Deliverables:** `test-inventory-tool.ts`, `impact-agent.ts`, `fixtures/test-inventory/*` (6 test files + 1 plain source file), `fixtures/impact-agent/*` (a small real dependency chain + 2 diffs), 50 tests total across the phase.

**Exit gate:** ✅ Met, verified with **two real Groq calls**, not just unit tests with a fake generator:
- Changing `calc.ts`: `calc.test.ts` → **must-run** (0.9, direct import), `calc-user.test.ts` → **should-run** (0.7, depth-2 reach), `unrelated.test.ts` → **should-run** (0.4, *"without a reachable link we cannot guarantee it is unaffected, so we run it"*) — the model chose **not** to skip on weak evidence, which is rule 7 and rule 4 working exactly as instructed, not a gap in the demo.
- Changing `calc.test.ts` itself: that file → **must-run** (0.99, *"the test file itself was directly modified"*) — rule 5 confirmed with a real call.
- **D5 budget**: ~1,600–1,900 tokens and ~2.1–2.5s per run on Groq — far under the $0.05/60s ceiling even before accounting for Groq's cost being negligible versus the OpenAI `CRITICAL_MODEL` tier.

Zero skips occurred in either real run — read that as the exit gate being satisfied *vacuously but correctly*, not evaded: an agent instructed to bias toward inclusion, given a small fixture with only one genuinely ambiguous case, is expected to hedge rather than manufacture a confident skip it can't back up. The unit test suite (`impact-agent.test.ts`) separately verifies the *warning* mechanics (missing/hallucinated paths) and the correlation logic against a fake generator that *does* return skips, so the skip-handling code path itself is exercised even where the real model declined to use it.

**Watch out for — the instructions bake this in explicitly:** rule 4 ("bias toward inclusion... a false must-run costs minutes, a false skip costs trust") and rule 7 ("absence of a graph signal is not proof of safety... say so plainly") are both literal, numbered lines in `impact-agent`'s system prompt, not implicit hopes. The real Groq output above is the first evidence they're actually followed, not just written down.

---

## Phase 4 — Report, confidence & fallback

**Goal:** the workflow assembled end to end, with `scoreConfidenceStep`, `ci-annotate-tool.ts`, and the `.branch()` run-everything fallback.

**Concepts to introduce:** workflows as staged pipelines, that step `execute` takes a single destructured object `{ inputData, state, ... }` (different from tool `execute`), `.branch()` tuple form, checking `result.status`.

**Steps**
- [x] `workflows/triage-workflow.ts`: `parseDiff → buildImpact → selectTests → scoreConfidence → branch → finalize`. **One step beyond the brief's sketch:** reading `.branch()`'s actual return type in the installed package (not the brief's simplified pseudocode) showed it produces an object keyed by branch step id (`{ 'run-all'?: ..., 'build-report'?: ... }`), the same shape `.parallel()` uses — not a unified merge. Added a `finalizeStep` after `.branch()` to collapse whichever key is populated into the workflow's one real output shape. Caught by reading `node_modules/@mastra/core/dist/workflows/workflow.d.ts` before writing the workflow, not by hitting a runtime error after.
- [x] **D3 confidence formula**, in `workflows/confidence.ts`: four weighted signals — `diffCompleteness` (drops sharply, not proportionally, on truncation — a known gap is worse than a merely large diff), `graphCoverage` (share of changed files the import graph actually found), `graphCertainty` (penalizes hitting the depth limit more than a barrel-heavy-but-complete search — different kinds of doubt), `selectionCompleteness` (from Phase 3's own warnings mechanism). The brief's "share of symbols resolved" is deliberately folded into `graphCertainty` rather than built as a fifth metric — documented in the module's own comment as a simplification, not an oversight.
- [x] `CONFIDENCE_THRESHOLD` (config.ts, default 0.7) is read directly in the branch condition — labeled in `confidence.ts`'s own docstring as a starting value pending Phase 6 calibration.
- [x] `.branch([[confidence < threshold → runAllStep], [else → buildReportStep]])`, both sharing the same `finalReportSchema` output, `.then(finalizeStep)` to normalize.
- [x] `ci-annotate-tool.ts`: renders Markdown — bucket counts, per-test rationale, confidence with its threshold stated inline, minutes saved with its assumptions in the *same sentence* as the number, and an explicit "below threshold, falling back" state with zero minutes saved when that branch runs.
- [x] Minutes-saved: `ASSUMED_MINUTES_PER_TEST` (config.ts) — placeholder per-type constants (0.1 min/unit, 0.5/integration, 2/e2e), documented in the constant's own comment as **not measurements**, pending Phase 5's real historical timing data. The report's footnote repeats this every single time the number appears.
- [x] Registered `triageWorkflow` and `ciAnnotateTool` on the Mastra instance.
- [x] `result.status` checked before reading `result.result` in every live verification run.

**Deliverables:** `workflows/triage-workflow.ts`, `workflows/confidence.ts`, `tools/ci-annotate-tool.ts`, two real rendered reports committed at `fixtures/impact-agent/reports/*.md`, 64 tests total across the project (14 new this phase).

**Exit gate:** ✅ Met, with **two full, real `triageWorkflow.createRun()` runs against live Groq** — not a mock, not a fake generator:
- **Normal case** (`change-calc.diff`): confidence **1.00**, reasoning trusted. `must-run: [calc.test.ts]` (1.00, direct import), `should-run: [calc-user.test.ts]` (0.80, depth-2), and — this run — a genuine **skip**: `unrelated.test.ts` (1.00, *"No import path from the changed file; test is unrelated based on lack of reachability"*). 0.1 minutes estimated saved.
- **Low-confidence case** (`change-phantom.diff`, a diff for a file that doesn't exist in the target repo): `graphCoverage` and `graphCertainty` both hit **0.00**, overall confidence **0.40** — correctly below the 0.7 threshold. `fellBackToRunAll: true`, all 3 inventory tests forced into `mustRun`, report states *"Falling back to running the full suite as a safety net; nothing was skipped this run"* and **0 minutes saved**, exactly as the safety net is supposed to behave.

Both rendered reports are committed as evidence, not just described: `fixtures/impact-agent/reports/change-calc-report.md` and `change-phantom-report.md`.

**Worth flagging on the skip itself:** the *same* fixture, run a second time, produced a `should-run` hedge instead of a skip for `unrelated.test.ts` in an earlier verification pass (Phase 3's own real-call evidence). Model sampling means the exact bucket for a genuinely ambiguous test can vary run to run — what does **not** vary is that a rationale is always present, because `structuredOutput` makes it a required schema field, not a suggestion.

**Watch out for — addressed directly:** every number in the rendered report states its own assumption in the same sentence it appears in, per the footnote template: minutes-saved assumptions, the fact confidence is a formula not a model guess, and that the 0.7 threshold is unvalidated pending Phase 6. Nothing here is a number without its caveat attached.

---

## Phase 5 — Flaky budget

**Goal:** `agents/flaky-agent.ts` + `tools/test-history-tool.ts` + Mastra storage — persist per-repo history and estimate repeat-runs for new/unstable tests.

**Concepts to introduce:** persistence (`LibSQLStore` — and it needs an `id`), why storage is required before Memory works, the difference between statistical flakiness and structural flakiness.

**Steps**
- [x] `new LibSQLStore({ id: 'testpilot-storage', url: 'file:./testpilot-storage.db' })` registered on the Mastra instance — satisfies the concept, but is **not** where flaky history actually lives. `LibSQLStore`'s domains (memory, workflows, scores, ...) are a fixed schema for Mastra's own internal concerns — its underlying client is a `private` field with no generic "store your own table" API. Verified this by reading `node_modules/@mastra/libsql/dist/storage/index.d.ts` before designing around it, not by assuming.
- [x] `test-history-tool.ts` uses `@libsql/client` **directly** against its own per-repo database at `<repoRoot>/.testpilot-cache/test-history.db` — same per-repo convention Phase 2's import-graph cache already established. `recordTestRun` / `getTestFailureRate` / `getRepoFailureRate`, each opening and closing its own connection (SQLite-local, cheap).
- [x] **D4, corrected.** The worksheet's originally-recorded formula, `n = ceil(log(1-c)/log(p))`, is mathematically wrong for `p` = observed failure rate — derived from first principles in `flaky-budget.ts`'s own docstring, the correct denominator is `log(1-p)`, not `log(p)`. At `p = 0.02` (a rare flake) the original formula gives `n ≈ 1`; the corrected one gives `n = 10` (the cap) — the right shape, since a *rarely*-flaky test is exactly the case needing the *most* repeats to rule out luck. New tests seed `p` from the repo's overall flake rate, falling further back to a documented default (`DEFAULT_FLAKE_PRIOR = 0.05`) when the repo has no history at all.
- [x] `flaky-agent.ts`: a real structured-output agent, flagging `timing` / `network` / `shared-state` / `order-dependence` / `randomness` / `date-time` patterns with a rationale naming the specific construct — verified live to name the exact line (`await new Promise((resolve) => setTimeout(resolve, 500))`), not a generic "might be flaky."
- [x] Statistical + structural merge, **also corrected mid-phase**: structural risk does **not** raise the probability fed into the formula (a second bug — since the formula is strictly *decreasing* in `p`, raising `p` toward "more likely to fail" paradoxically *lowers* the computed budget). Fixed with `applyStructuralFloor(statisticalBudget, riskLevel)` — a `{low: 0, medium: 4, high: 8}` floor applied *after* the arithmetic, which can only ever raise the count, never lower it. Caught by the test suite, not by code review: `flaky-budget.test.ts`'s own monotonicity assertion was written backwards until a failing test forced the derivation to be redone properly.
- [x] Flaky risk surfaced in `ci-annotate-tool.ts`'s report: a `🎲 Flaky risk` section listing budget, prior source, risk level, and every structural flag with its rationale — present in both the confident and fell-back-to-run-all reports, since `estimateFlakyStep` runs before the `.branch()` gate.

**Deliverables:** `test-history-tool.ts`, `flaky-budget.ts`, `flaky-agent.ts`, `LibSQLStore` registered, `estimateFlakyStep` wired into `triage-workflow.ts` between select-tests and score-confidence, flaky section in the rendered report, `fixtures/flaky-budget-workflow/*` (isolated fixture + diff), 89 tests total across the project (25 new this phase).

**Exit gate:** ✅ Met, verified with **real Groq calls and two genuinely separate OS process invocations** — not just unit tests:
- **Repeat budget + structural flags:** a diff adding `src/cache.test.ts` (a brand-new test with a fixed `setTimeout(resolve, 500)` wait) ran through the full `triageWorkflow`. Result: `must-run` (rule 5, directly added), **budget 10** (default prior already saturates the formula's cap for a test with zero history), risk **high**, flag **timing** with a rationale naming the exact construct. Rendered report committed nowhere permanent (this was a live, disposable check) but the mechanism is exercised by `flaky-agent.test.ts` and `confidence`-adjacent workflow tests.
- **Persistence, literally "kill the process, re-run":** `node --env-file=.env` script one wrote two outcomes (`fail`, `pass`) to `fixtures/flaky-budget-workflow`'s history DB and exited. A **second, separate `node` invocation** — no shared memory, no shared variables, a different OS process entirely — read `{ totalRuns: 2, failCount: 1, failureRate: 0.5 }` back correctly.

**Two real mistakes found and fixed while building this, both worth naming plainly:**
1. **The originally-recorded D4 formula was wrong.** `log(p)` should have been `log(1-p)`. Derived correctly from first principles this time, with the derivation kept in the code as a permanent comment so it doesn't silently regress.
2. **The first fix for combining statistical and structural signals was *also* wrong** — raising the prior probability to reflect "this looks risky" actually *lowers* the required repeat count once the formula's strictly-decreasing shape is taken into account. Fixed by moving structural risk to a post-hoc floor instead of a prior adjustment. This is exactly the kind of trap the worksheet's own warning describes — an intuitive-sounding number that turns out backwards under real arithmetic — except it happened to *this project's own code*, not just to a hypothetical LLM guess, which is precisely why the derivation is now written down rather than trusted from memory.

A third, environment-level issue, not a code bug: `@libsql/client`'s local Node driver does not release its memory-mapped file handle on `close()` within the same process on Windows — confirmed by direct reproduction (a 2-second wait after `close()` still failed to delete the file; the OS only released it once the process fully exited). Test cleanup now does best-effort deletion and doesn't fail the suite over it, with the reproduction documented in the code comment rather than asserted from memory.

**Watch out for — this is now a permanent code comment, not just a worksheet note:** an LLM asked "how many times should I run this?" produces a confident, ungrounded round number. `flaky-agent.ts`'s own instructions explicitly forbid including a number anywhere in its response; the count only ever comes from `flaky-budget.ts`'s arithmetic.

---

## Phase 6 — Fixture repo & regression-guard eval

**Goal:** prove the trust metric — Testpilot never skips a test that would have failed.

**Concepts to introduce:** Mastra Scorers (`@mastra/evals`), ground-truth evaluation, why this is the headline credibility number.

**Steps**
- [ ] Build `fixtures/sample-repo/` — a small TypeScript project with ~10 Vitest tests where the correct selection for each seeded change is known by hand.
- [ ] Seed a set of changes covering: pure-logic change, shared-util change, type-only change, test-only change, config change, and a change that *should* trip the fallback.
- [ ] `scorers/regression-guard.ts`: run the selected set **and** the full suite; assert no skipped test would have failed.
- [ ] Record the metrics table: CI-minute reduction, missed regressions, flaky-flag precision, confidence calibration.
- [ ] Wire the eval into CI so every PR reports it.

**Deliverables:** fixture repo, regression-guard scorer, a metrics table committed to the repo and reproducible by anyone.

**Exit gate:** across all seeded changes, **missed regressions = 0**, and the measured CI-minute reduction is a real number you'd publish.

**Watch out for:** a fixture repo tuned until the agent passes is worthless. Write the expected answers *before* running the agent, and don't edit them afterwards.

---

## Phase 7 — Ship

**Goal:** anyone can drop Testpilot into their repo in under ten minutes.

**Steps**
- [ ] `README.md`: the positioning line verbatim, the problem, a quickstart, the metrics table from Phase 6, a demo GIF, and an honest limitations section.
- [ ] `.github/workflows/testpilot-example.yml`: a copy-pasteable GitHub Actions job, with the minimum `GITHUB_TOKEN` permissions spelled out.
- [ ] Ship both distribution forms per **D6**: an npm package holding the engine, and a thin composite GitHub Action that wraps it with no logic of its own.
- [ ] Document the **privacy posture** honestly — what is sent to OpenAI by default, and how to self-host a model so nothing leaves your infra. Do not let the positioning line imply the default is local.
- [ ] Publish the **D5** cost and latency numbers next to the minutes-saved claim.
- [ ] `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, issue and PR templates.
- [ ] Record a 60–90s demo: Studio handling a real PR and explaining its selection.
- [ ] Tag `v0.1.0`.

**Exit gate:** a clean clone, following only the README, gets a working run on a test repo.

---

## Phase 8 — Launch

Ordered easiest → highest impact, all using the same positioning line.

- [ ] Mastra Discord + "built with Mastra" showcase.
- [ ] Submit as a **Mastra Template** (templates live in the Mastra monorepo and auto-sync to standalone repos).
- [ ] `dev.to` write-up: "I built X with Mastra" — demo GIF plus the build log.
- [ ] Show HN, and reply in the [original Ask HN thread](https://news.ycombinator.com/item?id=46345827) — "I built the thing someone asked for here."
- [ ] Publish the demo video.

**Exit gate:** the positioning line, the metrics, and the demo are consistent across every channel.

---

## Decisions (settled 2026-08-18)

These were the gaps the brief left open. All are now decided, so no phase is blocked waiting on an answer. Revisit one only with a stated reason — and update this table when you do.

| # | Question | Decision | Implemented in |
|---|---|---|---|
| **D1** | Where does the diff come from? | `git diff` against the **merge base** (`git merge-base origin/main HEAD`) — it works locally, in Studio, and in any CI provider, with no API dependency. The GitHub Action passes the same string in. Hard ceiling of **~40k diff characters**; beyond that, truncate per-file with a notice in the report and drop confidence, rather than silently sending a partial picture. | Phase 1 |
| **D2** | What does `should-run` operationally *mean*? | **It runs.** CI has only two behaviours — execute or don't — so `must-run` and `should-run` both execute and `skip` is the only bucket that saves minutes. `should-run` is a *confidence label* surfaced in the PR comment ("ran this because it plausibly touches X"), not a third behaviour. Rejected: making it not run (that is `skip` with softer wording, and every entry becomes a chance to miss a regression), and making it conditional on a time budget (needs run history to calibrate — revisit as a v2 feature). | Phase 3 |
| **D3** | The confidence formula, and why 0.7? | **Implemented in `workflows/confidence.ts`.** Four weighted signals, each `[0,1]`: `diffCompleteness` (0.25 — truncation drops this to 0.3 outright, not a proportional scale), `graphCoverage` (0.30 — share of changed files the import graph found), `graphCertainty` (0.30 — depth-limit and barrel-fan-out penalties), `selectionCompleteness` (0.15 — from Phase 3's warnings on the model's response). "Share of symbols resolved" was folded into `graphCertainty` rather than built as a fifth signal — documented as a deliberate simplification. Threshold via `TESTPILOT_CONFIDENCE_THRESHOLD`, defaulting to **0.7 as a starting value only** — verified live: a clean change scored 1.00 (reasoning trusted), a diff for a nonexistent file scored 0.40 (correctly triggered run-all). Phase 6 calibrates the threshold itself against the fixture repo. | Phase 4, calibrated Phase 6 |
| **D4** | The flaky run-budget formula | **Implemented in `tools/flaky-budget.ts` — with a correction made mid-Phase-5.** The formula as originally recorded here, `n = ceil(log(1-c)/log(p))`, was mathematically wrong for `p` = observed failure rate; derived properly from first principles, the correct denominator is `log(1-p)`. `c = 0.95`, `n` capped at **10**. New tests with no history seed `p` from the repo's overall flake rate, falling back further to a documented default (0.05) for a repo with no history at all. **Statistics decide the count; the LLM only detects patterns** — but the *mechanism* for combining them changed too: structural risk from `flaky-agent` is applied as a **post-hoc floor** (`{low:0, medium:4, high:8}`) on the statistically-computed count, not as a bump to the prior probability, because the formula is strictly decreasing in `p` and a prior-bump could silently *lower* the budget for a "riskier" test — the opposite of the intent. Verified live: a brand-new test with a real `setTimeout` flaky pattern got budget 10, risk high, with a rationale naming the exact line. | Phase 5 |
| **D5** | Cost & latency budget per PR run | **Measured from Phase 3, published in Phase 6, enforced from Phase 7.** Log tokens in/out and wall-clock per workflow run. Target: **under $0.05 and under 60s per PR** on a typical diff. Report it next to minutes-saved — a tool that sells CI savings must show its own cost, or the savings claim is unverifiable. | Phase 3 → 6 → 7 |
| **D6** | Distribution: npm, GitHub Action, or both? | **Both.** An npm package carries the engine and stays usable locally, in Studio, and in any CI provider; a thin composite GitHub Action wraps it for drop-in use. The Action is a wrapper only — no logic lives there, so the two can never drift. | Phase 7 |
| **D7** | Write the missing `MASTRA_KNOWLEDGE.md` / `TYPESCRIPT_FOR_MASTRA.md` companions? | **No.** The brief references both but neither exists. Rather than write docs that go stale as Mastra evolves, verify against the live docs at the start of each phase and explain TypeScript concepts inline as they first appear. Phase 0 improved on this: `create-mastra` ships a `.claude/skills/mastra/` reference pack (core concepts, API, common errors, model selection, migration guide) that the tool keeps current — better than anything hand-written, because it does not rot. | Ongoing |
| **D8** | Which provider, given a limited budget? | **Two tiers.** `TESTPILOT_MODEL` defaults to `groq/openai/gpt-oss-120b` for everyday work — development means running the same prompt hundreds of times, and metering that is how a side project quietly becomes expensive. `TESTPILOT_MODEL_CRITICAL` defaults to `openai/gpt-5.4-mini`, spent only on ambiguous selection calls and the Phase 6 evaluation runs whose numbers reach the README. This also proves the model-agnosticism the "self-hostable" claim rests on: if swapping providers is a one-line change for us, it is a one-line change for adopters. | Phase 0, exercised Phase 3+ |

### Consequences worth remembering

- **Privacy must be stated honestly.** Diffs and source metadata go to OpenAI by default. "Nothing leaves your infra" is true *only* with a self-hosted model. The README says so plainly and documents how to self-host — the positioning line stays credible precisely because it doesn't overclaim.
- **D2 makes `skip` the whole product.** Every CI minute saved comes from that one bucket, so every `skip` rationale is load-bearing and the regression-guard eval in Phase 6 is the only thing standing between the tool and lost trust.

---

## Success metrics (report these, with numbers)

| Metric | Target | Measured in |
|---|---|---|
| CI-minute reduction vs full-suite baseline | 50–80% | Phase 6 |
| **Missed regressions** (skipped tests that would have failed) | **≈ 0 — the trust gate** | Phase 6 |
| Flaky-flag precision | Reported honestly, no target gaming | Phase 6 |
| Confidence calibration | Low-confidence runs correlate with wrong selections | Phase 6 |
| Testpilot's own cost & latency per PR | Documented and bounded | Phase 3 → 6 |

---

## Explicitly out of scope for v1

- Python / pytest support — a second adapter in a later version, to prove language-agnosticism.
- Non-GitHub CI providers (GitLab, Jenkins, CircleCI).
- Coverage-map ingestion — the whole point is working without one.
- A hosted SaaS offering.
- The backup ideas in §10 of the brief (repo cartographer, infra blast-radius reviewer, work planner, guardrail layer) — recorded there as pivots, not as scope.

---

## Mastra API quick reference (verified 2026-08-18 — re-verify each phase)

- Models are plain strings: `"openai/gpt-5-mini"`. Never `provider:model`, never a provider object.
- Tools: `createTool({ id, description, inputSchema, outputSchema, execute })`; `execute(validatedInput, executionContext?)`. Attach as `new Agent({ id, tools: { toolA } })` — **the object key becomes the tool name in stream responses**, not the tool's `id`.
- Steps: `createStep({ id, inputSchema, outputSchema, stateSchema?, execute })`; `execute({ inputData, state, setState, mastra, writer, requestContext })` — a single destructured object, unlike tools.
- Workflows: `createWorkflow({ id, inputSchema, outputSchema }).then(step)…commit()`. Branching is `.branch([[async ({ inputData }) => cond, step], …])`; first true tuple wins.
- Running: `const run = await workflow.createRun(); const result = await run.start({ inputData })`. **Check `result.status`** (`success` | `failed` | `suspended` | `tripwire` | `paused`) before reading `result.result` / `result.error` / `result.suspendPayload`.
- Structured output: `agent.generate(prompt, { structuredOutput: { schema } })` → `response.object`.
- Storage: `new LibSQLStore({ id: 'testpilot-storage', url: ':memory:' })` — the `id` is required. Memory needs a storage provider on the Mastra instance. **`LibSQLStore` has no generic "store your own table" API** — its domains (`memory`, `workflows`, `scores`, ...) are a fixed schema for Mastra's own internal concerns, and its underlying client is a `private` field. For custom application data (Phase 5's flaky-test history), use `@libsql/client`'s `createClient({ url })` directly — same underlying technology, a genuinely separate database/schema. Verify this kind of thing by reading the installed `.d.ts`, not by assuming a storage class is more generic than it is.
- Scorers live in `@mastra/evals`; prebuilt factories at `@mastra/evals/scorers/prebuilt`; attach via a `scorers` config with `sampling.rate`.
- `package.json` needs `"type": "module"`. Include file extensions on local imports (`./x.ts`) on Node 22.18+.
- Prefer `mastra.getWorkflow()` / `mastra.getAgentById()` over direct imports.
