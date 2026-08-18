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
| 0 | Hello Mastra — environment proof | `phase/0-hello-mastra` | ⬜ Not started |
| 1 | Read a diff | `phase/1-git-diff-tool` | ⬜ Not started |
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
5. **Cheap model by default.** `"openai/gpt-5-mini"` during development. Only escalate to a stronger model for genuinely ambiguous selection cases, and only in Phase 3+.
6. **Never commit secrets.** `OPENAI_API_KEY` lives in `.env`, which is gitignored. A committed `.env.example` documents the shape.
7. **When a wizard prompts something not covered here, paste the exact prompt** rather than guessing an answer.

---

## Phase 0 — Hello Mastra (environment proof)

**Goal:** prove the machine runs a Mastra project and the OpenAI key works. No Testpilot logic yet.

**Concepts to introduce:** what a Mastra project is (agents + tools + workflows registered on one `Mastra` instance), what Studio is, why `"type": "module"` matters.

**Steps**
- [ ] Confirm `node --version` is 20+ (22+ preferred).
- [ ] Scaffold with `npm create mastra@latest` — choose **Agents + Tools + Workflows**, provider **OpenAI**, install deps **yes**.
- [ ] Reconcile the scaffold with this repo (the generated project must live at the repo root, not a nested `testpilot/` folder).
- [ ] Create `.env` with `OPENAI_API_KEY=...`; create and commit `.env.example` with the key name and no value.
- [ ] Confirm `package.json` has `"type": "module"`.
- [ ] `npm run dev`, open Studio (typically `http://localhost:4111`), send the sample agent a message.
- [ ] Add repo hygiene: `LICENSE` (Apache 2.0), a stub `README.md`, `tsconfig.json` reviewed.

**Deliverables:** runnable Mastra scaffold, `.env.example`, Apache 2.0 `LICENSE`, stub README.

**Exit gate:** Studio starts and the sample agent replies with a real model response. `git status` shows no `.env` and no `node_modules`.

**Watch out for:** the scaffold wizard's folder layout — if it creates a subfolder, move contents up before the first commit, not after.

---

## Phase 1 — Read a diff

**Goal:** `src/mastra/tools/git-diff-tool.ts` — takes a unified-diff string, returns changed files plus changed function/symbol names.

**Concepts to introduce:** `createTool()`, Zod input/output schemas, why the tool's `execute` receives `(validatedInput, executionContext)`.

**Steps**
- [ ] Define the Zod `inputSchema` (unified diff text) and `outputSchema` (files with path, change type, added/removed line ranges, touched symbol names).
- [ ] Implement unified-diff parsing: file headers, hunk headers, added/removed lines.
- [ ] Handle the awkward cases explicitly: renames, deletions, binary files, new files, and diffs with no TS content.
- [ ] **Decide and document the diff-acquisition contract** (see Open decisions D1) — even if CI wiring comes later, the tool's input shape depends on it.
- [ ] Add a truncation strategy with a documented ceiling for very large diffs.
- [ ] Test in Studio by pasting a small sample diff; save 3–4 sample diffs under `fixtures/diffs/` for reuse.
- [ ] Unit tests (Vitest) over the saved fixture diffs.

**Deliverables:** `git-diff-tool.ts`, `fixtures/diffs/*`, passing unit tests.

**Exit gate:** feeding each fixture diff in Studio returns the correct changed-file list and symbol names; unit tests green.

**Watch out for:** symbol extraction from raw diff text is unreliable for anything non-trivial. Extract *candidate* names here; authoritative symbols come from the AST in Phase 2.

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
- [ ] **Define what `should-run` operationally means** (see Open decisions D2) before writing the prompt — the bucket is meaningless until this is settled.
- [ ] Write `impact-agent.ts` with a prompt that receives the diff summary, the reverse-dependency reach, and the test inventory — and must justify every `skip`.
- [ ] Use `structuredOutput` so the result is typed, not parsed from prose.
- [ ] Log token usage and latency per run (needed for the cost budget, D5).
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
- [ ] **Define the confidence formula** (see Open decisions D3) — not an LLM-invented number. Base it on observable signals: graph reach certainty, share of files parsed successfully, diff size, unmatched symbols, test-inventory coverage.
- [ ] Make the threshold configurable (`TESTPILOT_CONFIDENCE_THRESHOLD`, default 0.7) and document why the default is what it is.
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
- [ ] **Define the run-budget formula** (see Open decisions D4) — derive repeat-runs from observed flake rate and a target confidence level, and let the agent supply the *prior* for brand-new tests only.
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
- [ ] Decide and implement the distribution form (see Open decisions D6): npm package, composite GitHub Action, or both.
- [ ] Document the **privacy posture** honestly — what is sent to OpenAI, and how to self-host a model so nothing leaves your infra.
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

## Open decisions (close these before the phase that needs them)

| # | Decision | Needed by | Default if undecided |
|---|---|---|---|
| **D1** | Where the diff comes from: `git diff` against the merge base, or the GitHub API? Token ceiling for large diffs? | Phase 1 | `git diff merge-base` locally; GitHub API in the Action |
| **D2** | What `should-run` operationally *means* — does CI run it or not? | Phase 3 | Runs by default; `skip` is the only bucket that saves minutes |
| **D3** | The confidence formula, and justification for the 0.7 threshold | Phase 4 | Weighted signal formula, threshold configurable, 0.7 default calibrated in Phase 6 |
| **D4** | The flaky run-budget formula | Phase 5 | Repeats needed for 95% confidence given observed flake rate, capped at 10 |
| **D5** | Cost & latency budget per PR run | Phase 3 (measure), Phase 6 (report) | Measure from Phase 3; publish alongside minutes-saved |
| **D6** | Distribution: npm package, GitHub Action, or both | Phase 7 | Both — npm for the engine, a composite Action wrapping it |
| **D7** | Whether the missing `MASTRA_KNOWLEDGE.md` / `TYPESCRIPT_FOR_MASTRA.md` companions get written | Any time | Skip them; use live Mastra docs and explain concepts inline |

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
