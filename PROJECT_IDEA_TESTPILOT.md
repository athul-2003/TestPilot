# Testpilot — Build Brief & Execution Plan

> **What this document is:** A complete, self-contained brief for building **Testpilot**, an open-source AI CI test-triage agent built on the Mastra TypeScript framework. It is written so an AI coding assistant (e.g. Claude) can execute it **phase by phase** with a beginner developer, with no other context required.
>
> **Who's building it:** A developer with **basic TypeScript** knowledge, using **VS Code**, an **OpenAI** API key, and **Node.js 20+** installed. The developer will rely on the AI assistant to design architecture and write code; the developer runs commands and reports results.
>
> **Companion files in this folder:** `MASTRA_KNOWLEDGE.md` (how Mastra works) and `TYPESCRIPT_FOR_MASTRA.md` (the TS basics needed). An executing assistant should read both before starting.
>
> Research date: Aug 2026.

---

## 0. HOW TO EXECUTE THIS BRIEF (read first)

**Instructions for the AI assistant building this:**

1. **Work in small, testable slices (phases).** Never generate the whole project at once. Complete one phase, have the developer run it, confirm it works, then proceed. The developer must always have something that runs.
2. **The loop is:** you write code → the developer pastes it in and runs the command you give → the developer reports the output (including errors) → you respond. You cannot run code or access their machine or GitHub; the developer is your hands.
3. **Explain every new concept in 1–2 plain sentences as it first appears** (a Zod schema, an async function, a workflow step). The developer is learning, not just pasting.
4. **The developer decides; you design.** Propose structure and explain *why*, but let them approve or redirect.
5. **Keep OpenAI costs near zero during development** by using a small/cheap model (e.g. an `openai/gpt-5-mini`-class or `openai/gpt-5-nano`-class string — confirm the exact current ID via VS Code autocomplete after typing `"openai/"`, since Mastra fetches the live model list).
6. **When a wizard/tool prompts something not covered here, tell the developer to paste the exact prompt rather than guess.**
7. **Favor quality and clarity over feature count.** The developer's goal is a mix of: a portfolio piece, a genuinely usable tool, AND community/Mastra visibility. A small tool that works flawlessly and is well-documented serves all three better than a sprawling half-working one.

---

## 1. THE PROBLEM (validated, not hypothetical)

The 2026 software-delivery bottleneck has shifted from *writing* code to *verifying* it. Two concrete, recurring complaints:

**A. "Which tests should this change actually run?"**
Direct problem statement from Hacker News *"Ask HN: What developer tool do you wish existed in 2026?"* (user *kubanczyk*):
> *"An LLM tool that can sit on a CI pipeline to propose what tests should be blocking. Instead of brute-force selecting test suites by path, have the LLM analyze changes and propose the set of test suites relevant to the change. If new complex tests are added, estimate how many times to run them to ensure they're not flaky (hundreds? thousands?)."*

Echoed across the CI/testing industry:
- Microsoft, Google, and Datadog report **50–80% of CI test time is wasted** running tests unaffected by a change.
- Existing **Test Impact Analysis (TIA)** tools rely on static dependency graphs or line-level coverage maps. They need clean test architecture, **break on stale/incomplete coverage data**, are mostly **backend-only**, and **can't reason about E2E/integration tests**.

**B. "Is this test failure real, or just flaky?"**
- Flaky tests are called *"the single most corrosive problem in a modern test suite"* — they destroy trust, so engineers re-run and merge anyway.
- ML classifiers exist (FlakeFlagger, Flakify, NeuroFlake) but need training data; a 2026 study (*"Chatting About Flaky Tests with Standard LLMs"*, PROFES 2025) found **raw LLM prompting unreliable** for flakiness. The gap is a *structured, evidence-gathering* approach, not a naive prompt.

---

## 2. HONEST PRIOR-ART ANALYSIS (important — read before pitching)

**"AI picks which tests to run" is NOT a new category.** There is real prior art, mostly commercial:

- **Launchable** (acquired by CloudBees) — Predictive Test Selection via ML trained on your CI history. Also TestBrain, Sealights, Datadog Test Optimization, and Microsoft/Google internal systems.

**However, every one of those shares the same limitations, which define Testpilot's genuine niche:**

| Existing tools do this | Testpilot does this instead |
|---|---|
| **ML-model based** — output is a bare list, no explanation | **LLM-reasoning based** — every selection has a plain-English rationale a human can audit |
| **Require a large history of past runs** before working (cold-start problem) | **Works day one** — no training data, no pre-built coverage map |
| **Closed-source SaaS** — your code metadata leaves your infra | **Open-source & self-hostable** — nothing leaves your machine |
| No first-class **flaky run-budget** feature | Estimates how many repeat-runs a new/unstable test needs to be trusted |

**Checked and confirmed empty:** The Mastra ecosystem (official templates + community projects) has a PR *code-review* agent, RAG/browser/DB-chat/PDF/Slack/docs agents, and a portfolio generator — **nothing touching CI test selection or flakiness.** No open-source LLM-reasoning test-selection agent with rationales + zero-setup + flaky-budget was found.

**THE POSITIONING (use this exact framing everywhere):**
> *"Launchable-style test selection, but open-source, self-hostable, explainable, and works with zero setup — built on Mastra."*

This is an honest, defensible claim. Do **not** claim "nothing like this exists"; claim "no *open, explainable, zero-setup* version exists," which is true and stronger.

---

## 3. WHY MASTRA IS THE RIGHT FRAMEWORK

- The problem is a **staged pipeline** (read diff → find impact → pick tests → report) — exactly what Mastra **Workflows** are built for; the framework handles retries, state, branching, and observability so the developer doesn't hand-code them.
- **Studio** (Mastra's visual UI) lets a beginner *watch* each step run and inspect inputs/outputs — a big advantage over debugging blind.
- The **model router** means models are plain strings (`"openai/gpt-5-mini"`), no SDK wiring, with VS Code autocomplete.
- Alternatives rejected: LangGraph/CrewAI are Python (new language for this developer); no-framework means hand-building all orchestration (too hard for a beginner). Mastra is the gentlest on-ramp.

**Caveat to keep in mind:** Mastra leans on async/await, Zod schemas, and typed objects — slightly beyond "basic" TS. Mitigate by explaining concepts inline and leaning on `TYPESCRIPT_FOR_MASTRA.md`.

---

## 4. CONFIRMED TECH DECISIONS

- **Framework:** Mastra (`@mastra/core`), TypeScript, ES modules (`"type": "module"`).
- **Test ecosystem targeted first:** **TypeScript + Vitest.** Rationale: one language for the whole project (the agent AND the code it analyzes are TS — no context-switching); Vitest is the modern default with clean, easy-to-parse output. (Python/pytest becomes a *second adapter* in a later version to prove language-agnosticism — not part of the initial build.)
- **Model provider:** OpenAI. Small/cheap model during development; selection logic can use a cheap model and ambiguous cases a stronger one later.
- **Editor:** VS Code. **Runtime:** Node.js 20+ (22+ preferred).
- **License:** Apache 2.0 (matches Mastra core and the open-source positioning).

---

## 5. WHAT TESTPILOT DOES (product shape)

Runs as a step in CI (GitHub Actions first). On each PR/commit it:

1. **Reads the diff** — changed files, hunks, added/removed symbols.
2. **Maps the blast radius** — reasons about which modules/behaviors the change affects, using the repo's import graph + test inventory. Builds a lightweight graph on the fly and caches it (no pre-existing coverage map required).
3. **Selects the test set** — `must-run` / `should-run` / `skip`, each with a one-line human-auditable rationale.
4. **Flaky budgeting** — for new or historically unstable tests, estimates repeat-runs needed to trust a green result; flags flaky-by-construction patterns (timing, network, shared state, ordering).
5. **Safety net** — emits a **confidence score**; below threshold it falls back to "run everything." Keeps the nightly full run as ground truth and **logs any misprediction** (a skipped test that would have failed) to learn from.
6. **Reports** — a clear PR comment: what's running, what's skipped and why, flaky risks, estimated CI-minutes saved.

---

## 6. TARGET ARCHITECTURE (Mastra)

```
testpilot/
  .env                          # OPENAI_API_KEY (never commit)
  package.json                  # "type": "module"
  tsconfig.json
  src/mastra/
    index.ts                    # register workflow + agents + storage
    tools/
      git-diff-tool.ts          # parse diff -> changed files, hunks, symbols
      ast-parse-tool.ts         # extract functions/exports/imports from changed TS files
      import-graph-tool.ts      # build & cache lightweight dependency graph
      test-inventory-tool.ts    # discover *.test.ts / *.spec.ts, tag unit/integration/e2e
      test-history-tool.ts      # read historical pass/fail/flake data from storage
      ci-annotate-tool.ts       # produce the PR-comment / CI-annotation report
    agents/
      impact-agent.ts           # reasons about blast radius of the diff
      flaky-agent.ts            # estimates flaky risk + run budget per test
    workflows/
      triage-workflow.ts        # parseDiff -> impact -> select -> flakyBudget -> confidence -> report
    scorers/
      regression-guard.ts       # eval vs full run: did we wrongly skip a failing test?
```

**Workflow control-flow sketch (with the safety-net fallback):**
```typescript
export const triageWorkflow = createWorkflow({
  id: 'triage-workflow',
  inputSchema: z.object({ diff: z.string(), repoPath: z.string() }),
  outputSchema: z.object({
    mustRun: z.array(z.string()),
    shouldRun: z.array(z.string()),
    skip: z.array(z.string()),
    flakyBudget: z.record(z.string(), z.number()),
    confidence: z.number(),
    estimatedMinutesSaved: z.number(),
  }),
})
  .then(parseDiffStep)
  .then(buildImpactStep)
  .then(selectTestsStep)
  .then(estimateFlakyStep)
  .then(scoreConfidenceStep)
  .branch([
    [async ({ inputData }) => inputData.confidence < 0.7, runAllStep],   // low confidence -> run everything
    [async ({ inputData }) => inputData.confidence >= 0.7, reportStep],  // else -> run selected set
  ])
  .commit()
```
*(Exact API details live in `MASTRA_KNOWLEDGE.md`. Verify current signatures against Mastra docs at build time, since the framework evolves.)*

---

## 7. PHASED BUILD PLAN (the execution roadmap)

Each phase ends with something the developer can run and see. Do not start a phase until the previous one runs cleanly.

### Phase 0 — Hello Mastra (environment proof)
**Goal:** confirm the machine runs a Mastra project and the OpenAI key works. No Testpilot code yet.
- `node --version` (must be 20+; ideally 22+).
- `mkdir testpilot && cd testpilot`, then `npm create mastra@latest` (wizard: pick Agents + Tools + Workflows; provider OpenAI; installing deps yes).
- Add `OPENAI_API_KEY=...` to `.env`.
- `npm run dev`, open Studio (typically `http://localhost:4111`), send the sample agent a message, confirm it replies.
- **Done when:** Studio runs and the sample agent responds.

### Phase 1 — Read a diff
**Goal:** one tool, `git-diff-tool.ts`, that takes a diff string and returns changed files + changed function/symbol names.
- Define input/output with Zod. Start with unified-diff text as input.
- Test in Studio by pasting a small sample diff.
- **Done when:** feeding a sample diff prints the correct changed-file list.

### Phase 2 — Map the impact
**Goal:** `ast-parse-tool.ts` + `import-graph-tool.ts` that, given changed files, find which other files import/depend on them.
- Parse TS files for imports; build a simple "who imports whom" map; cache it.
- **Done when:** changing file A correctly lists the files that depend on A.

### Phase 3 — Select tests
**Goal:** `test-inventory-tool.ts` + `impact-agent.ts` that classify tests into `must-run` / `should-run` / `skip`, each with a plain-English reason. Structured (typed) output.
- **Done when:** on a sample change, the agent returns a sensible, explained selection.

### Phase 4 — Report + confidence + fallback
**Goal:** `scoreConfidenceStep` + `ci-annotate-tool.ts` + the `.branch()` fallback. Produce a readable summary, a confidence score, estimated minutes saved, and "run everything" when unsure.
- **Done when:** a full workflow run yields a clean report and a confidence number, and low confidence triggers run-all.

### Phase 5 — Flaky budget
**Goal:** `flaky-agent.ts` + `test-history-tool.ts` + Mastra Memory/Storage to persist per-repo flaky history and estimate repeat-runs for new/unstable tests.
- **Done when:** newly added tests get a repeat-run budget and flaky-by-construction flags, persisted across runs.

### Phase 6 — Polish & ship
- Build a **sample fixture repo** (~10 Vitest tests) where the correct answer is known.
- Add the **regression-guard eval** (agent's selected tests vs full suite; must never skip a test that would have failed).
- Write the **README** (positioning line from §2, quickstart, GIF).
- Record a **60–90s demo** of Studio handling a PR.
- Wire a **GitHub Actions** example workflow so others can drop it in.

---

## 8. HOW TO TEST IT (three levels, easy → rigorous)

1. **Studio (visual, immediate):** run `npm run dev`, feed the workflow a sample diff, watch each step's output. Day-to-day "did it work?" check; no test-writing needed.
2. **Sample fixture repo:** a small repo (~10 tests) the developer controls, so the correct selection is known in advance. Confirms accuracy.
3. **Ground-truth eval (the real proof):** run the agent's *selected* tests AND the *full* suite; verify the agent never skipped a test that would have failed. Use Mastra's **Evals** system. This is also the headline credibility metric for the launch.

**Key success metrics to report:**
- CI-minute reduction vs full-suite baseline (target the industry's 50–80%).
- **Missed regressions ≈ 0** (skipped tests that would have failed, caught by the nightly full run) — the trust metric.
- Flaky-flag precision.
- Confidence calibration (low-confidence runs correlate with cases selection would have gotten wrong).

---

## 9. HOW TO PRESENT IT TO THE WORLD (go-to-market)

Ordered easiest → highest-impact:

1. **Mastra Discord + "built with Mastra" showcase** — warmest, lowest-effort first audience; Mastra's docs invite sharing projects there.
2. **Submit as a Mastra Template** — templates live in the Mastra monorepo and auto-sync to standalone repos; contributions are explicitly invited. A featured template = visibility directly from Mastra.
3. **A `dev.to` "I built X with Mastra" write-up** — a proven, beginner-friendly format; include a demo GIF and a build log.
4. **Show HN / reply in the original Ask HN thread** — authentic angle: "I built the thing someone asked for in this thread." (Original thread: https://news.ycombinator.com/item?id=46345827)
5. **A short demo video** — 60–90s of Studio handling a PR and explaining its selection; this is what makes people share.

Consistent narrative for all channels: the §2 positioning line.

---

## 10. BACKUP IDEAS (if direction changes; lower prior-art competition)

Testpilot was chosen deliberately, but these have thinner competition and remain strong Mastra fits:
1. **Repo onboarding "cartographer"** — turns an unfamiliar codebase into an interactive call/impact map to build a "system mindset." (From HN *markus_zhang*; aligns with the 2026 "domain knowledge is the real agent bottleneck" theme. Great fit for Mastra memory.)
2. **Infra blast-radius reviewer** — given a Terraform/K8s diff, explains what real resources change and what could break downstream. (From HN DevOps complaints.)
3. **Micro-decision "work Jarvis" planner** — ingests tickets/calendar/PRs and surfaces the single next action. (HN *taurath*.)
4. **Agent runtime-guardrail layer** — traces, replay, and a hard "no" before an unsafe action runs. (HN *IntelliAvatar*.)

---

## 11. SOURCES / PROBLEM PROVENANCE

- Ask HN — "What developer tool do you wish existed in 2026?" (core problem statement + DevOps/CI complaints): https://news.ycombinator.com/item?id=46345827
- Reddit AI-agent conversation summary ("one bounded agent, one clear job"; orchestration/session-burn costs): https://dev.to/liv_melendez_4be3c47ea998/what-the-ai-agent-crowd-on-reddit-is-arguing-about-in-early-may-2026-4j7e
- Belitsoft 2026 AI-agent trends ("half the agents work alone"; orchestration is the gap): https://www.barchart.com/story/news/1163379/belitsoft-report-2026-ai-agent-trends-enterprises-run-12-ai-agents-on-average-but-half-work-alone
- "Solving Agent Amnesia" (context rot / memory as the 2026 differentiator): https://mlearning.substack.com/p/solving-agent-amnesia-28-principles-for-building-stateful-ai
- Stack Overflow empirical study of AI-agent developer challenges (orchestration, evaluation reliability): https://arxiv.org/html/2510.25423v1
- Test Impact Analysis guides (50–80% CI savings; limits of static/coverage TIA): https://www.drizz.dev/post/test-impact-analysis , https://www.minware.com/guide/best-practices/test-impact-analysis
- Flaky-test state of the art + LLM limits: https://qaskills.sh/blog/ai-flaky-test-detection-guide , "Chatting About Flaky Tests with Standard LLMs" (PROFES 2025): https://link.springer.com/chapter/10.1007/978-3-032-12092-2_28
- Prior art (commercial): Launchable Predictive Test Selection: https://docs.launchableinc.com/actions/predictive-test-selection/faq ; CloudBees acquisition: https://www.cloudbees.com/blog/cloudbees-acquires-launchable-to-enable-development-teams-to-iterate-faster
- Mastra (framework + templates confirming the gap): https://mastra.ai/docs , https://mastra.ai/templates , https://mastra.ai/templates/github-pr-code-review-agent , https://mastra.ai/models , model router: https://mastra.ai/blog/model-router

---

## 12. QUICK-REFERENCE: MASTRA RULES THE BUILDER MUST NOT FORGET

(Full detail in `MASTRA_KNOWLEDGE.md`.)
1. `package.json` needs `"type": "module"`.
2. `model` is a string `"provider/model"` (e.g. `"openai/gpt-5-mini"`) — never `provider:model`, never a provider object.
3. Tools MUST use `createTool()` — plain object tool definitions silently fail.
4. Tool `execute()` = `(validatedInput, executionContext)`; workflow step `execute` uses `({ inputData, state, ... })`.
5. Include file extensions on local imports (`./x.ts`) when running TS directly on Node 22.18+.
6. Prefer `mastra.getAgentById()` / `mastra.getWorkflow()` (registration key) over direct imports — shared services + type inference.
7. Memory requires a storage provider; add `id` to `LibSQLStore`.
8. Always check workflow `result.status` before reading status-specific fields.
9. Set `OPENAI_API_KEY` in `.env`; never hard-code keys in `.ts` files.
10. Verify current Mastra API signatures and model IDs against the live docs at build time — the framework evolves.
