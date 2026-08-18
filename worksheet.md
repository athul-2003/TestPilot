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
| 2 | Map the impact | `phase/2-impact-graph` | ⬜ Not started |
| 3 | Select tests | `phase/3-test-selection` | ⬜ Not started |
| 4 | Report, confidence & fallback | `phase/4-report-confidence` | ⬜ Not started |
| 5 | Flaky budget | `phase/5-flaky-budget` | ⬜ Not started |
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
- [ ] Choose the TS parsing approach (TypeScript compiler API vs `ts-morph` vs a lightweight import regex) and record the trade-off in the PR description.
- [ ] `ast-parse-tool.ts`: extract imports, exports and top-level declarations from a TS file.
- [ ] `import-graph-tool.ts`: build a forward graph, invert it to "who imports whom", and cache it on disk (cache dir must be gitignored).
- [ ] Handle path aliases (`tsconfig` `paths`), barrel files (`index.ts` re-exports), and dynamic `import()`.
- [ ] Add cache invalidation keyed on file mtime/hash.
- [ ] Support transitive reach with a documented depth limit.
- [ ] Unit tests on a small sample source tree with a known dependency shape.

**Deliverables:** both tools, an on-disk graph cache, tests.

**Exit gate:** changing file A correctly lists the files that depend on A, directly and transitively, on a tree where the answer is known by hand.

**Watch out for:** barrel files make almost everything look connected. If `index.ts` re-exports the world, the blast radius becomes the whole repo — decide how to handle this before it silently destroys selection quality.

---

## Phase 3 — Select tests

**Goal:** `test-inventory-tool.ts` + `agents/impact-agent.ts` — classify tests into `must-run` / `should-run` / `skip`, each with a one-line human-auditable rationale.

**Concepts to introduce:** what an agent is versus a tool, structured output (`structuredOutput: { schema }` → `response.object`), why the rationale is a product feature and not a debug log.

**Steps**
- [ ] `test-inventory-tool.ts`: discover `*.test.ts` / `*.spec.ts`, tag each as unit / integration / e2e (heuristics documented).
- [ ] Define the selection output schema in Zod: per-test `{ path, bucket, rationale, confidence }`.
- [ ] Encode **D2** in the prompt and the report: `must-run` and `should-run` both execute, `skip` is the only bucket that saves minutes. `should-run` is a confidence label, so its rationale must read as "ran this because it plausibly touches X".
- [ ] Write `impact-agent.ts` with a prompt that receives the diff summary, the reverse-dependency reach, and the test inventory — and must justify every `skip`.
- [ ] Use `structuredOutput` so the result is typed, not parsed from prose.
- [ ] Log tokens in/out and wall-clock per run, against the **D5** budget of under $0.05 and under 60s per PR.
- [ ] Run against the Phase 1 fixture diffs; eyeball the rationales for sanity.

**Deliverables:** test inventory tool, impact agent, typed selection output, recorded token/latency numbers.

**Exit gate:** on a sample change the agent returns a sensible selection where **every `skip` has a rationale a human would accept**.

**Watch out for:** an agent that skips confidently and wrongly is worse than no tool. Bias the prompt toward inclusion; a false `must-run` costs minutes, a false `skip` costs trust.

---

## Phase 4 — Report, confidence & fallback

**Goal:** the workflow assembled end to end, with `scoreConfidenceStep`, `ci-annotate-tool.ts`, and the `.branch()` run-everything fallback.

**Concepts to introduce:** workflows as staged pipelines, that step `execute` takes a single destructured object `{ inputData, state, ... }` (different from tool `execute`), `.branch()` tuple form, checking `result.status`.

**Steps**
- [ ] `workflows/triage-workflow.ts`: `parseDiff → buildImpact → selectTests → scoreConfidence → branch`.
- [ ] Implement the **D3** confidence formula — a weighted score over observable signals (share of changed files AST-parsed, share of symbols resolved in the graph, graph reach certainty, diff size vs the truncation ceiling, test-inventory completeness). Never a number the LLM invents.
- [ ] Make the threshold configurable via `TESTPILOT_CONFIDENCE_THRESHOLD`, default `0.7` — and label it in the code as a starting value pending Phase 6 calibration.
- [ ] `.branch([[low confidence → runAllStep], [else → reportStep]])`.
- [ ] `ci-annotate-tool.ts`: render a clear Markdown PR comment — what's running, what's skipped and why, estimated minutes saved, confidence, and an explicit "fell back to run-all" state.
- [ ] Define the estimated-minutes-saved calculation and state its assumptions in the comment itself.
- [ ] Register workflow and agents on the Mastra instance; access via `mastra.getWorkflow()` / `getAgentById()`.
- [ ] Always check `result.status` before reading `result.result`.

**Deliverables:** complete `triage-workflow.ts`, confidence step with a documented formula, `ci-annotate-tool.ts`, sample rendered report committed to `fixtures/`.

**Exit gate:** a full workflow run produces a clean report plus a confidence number, and an artificially low-confidence input demonstrably triggers run-all.

**Watch out for:** "estimated minutes saved" is the number people screenshot. If its assumptions are hidden, the whole tool reads as marketing.

---

## Phase 5 — Flaky budget

**Goal:** `agents/flaky-agent.ts` + `tools/test-history-tool.ts` + Mastra storage — persist per-repo history and estimate repeat-runs for new/unstable tests.

**Concepts to introduce:** persistence (`LibSQLStore` — and it needs an `id`), why storage is required before Memory works, the difference between statistical flakiness and structural flakiness.

**Steps**
- [ ] Configure `LibSQLStore({ id: 'testpilot-storage', url: ... })` on the Mastra instance; add the DB file to `.gitignore`.
- [ ] `test-history-tool.ts`: record and read per-test pass/fail/flake outcomes across runs.
- [ ] Implement the **D4** budget formula: `n = ceil(log(1 - c) / log(p))` at `c = 0.95`, capped at 10 repeats. New tests seed `p` from the repo's overall flake rate; structural flags raise the prior but never set the count directly.
- [ ] `flaky-agent.ts`: flag flaky-by-construction patterns from source — timing/sleep, network calls, shared mutable state, order dependence, randomness, date/time.
- [ ] Merge statistical and structural signals into one budget per test, with a cap.
- [ ] Surface flaky risks in the Phase 4 PR comment.

**Deliverables:** history tool, flaky agent, persisted storage, budgets visible in the report.

**Exit gate:** newly added tests receive a repeat-run budget and structural flags, and the history survives across separate runs (kill the process, re-run, history is still there).

**Watch out for:** an LLM asked "how many times should I run this?" will produce a confident round number with no basis. The number must come from the formula; the LLM supplies the pattern detection.

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
| **D3** | The confidence formula, and why 0.7? | A **weighted score over observable signals**, never a number the LLM invents: share of changed files successfully AST-parsed, share of changed symbols resolved in the import graph, graph reach certainty (unresolved dynamic imports and barrel-file fan-out reduce it), diff size against the truncation ceiling, and test-inventory completeness. Threshold is configurable via `TESTPILOT_CONFIDENCE_THRESHOLD`, defaulting to **0.7 as a starting value only** — Phase 6 calibrates it against the fixture repo and the README publishes the calibrated number with its evidence. | Phase 4, calibrated Phase 6 |
| **D4** | The flaky run-budget formula | **Statistics decide the count; the LLM only detects patterns.** Given an observed per-run failure probability `p` for a flaky test, the repeats needed for a green result to mean something at confidence `c` is `n = ceil(log(1 - c) / log(p))`, with `c = 0.95` and `n` capped at **10** to bound CI cost. New tests with no history get a prior seeded from the repo's overall flake rate, tightened as runs accumulate. The `flaky-agent` contributes *structural* flags (timing, network, shared state, ordering, randomness, date/time), which raise the prior — they never produce the number directly. | Phase 5 |
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
- Storage: `new LibSQLStore({ id: 'testpilot-storage', url: ':memory:' })` — the `id` is required. Memory needs a storage provider on the Mastra instance.
- Scorers live in `@mastra/evals`; prebuilt factories at `@mastra/evals/scorers/prebuilt`; attach via a `scorers` config with `sampling.rate`.
- `package.json` needs `"type": "module"`. Include file extensions on local imports (`./x.ts`) on Node 22.18+.
- Prefer `mastra.getWorkflow()` / `mastra.getAgentById()` over direct imports.
