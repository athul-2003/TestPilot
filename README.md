# Testpilot

> Launchable-style test selection, but open-source, self-hostable, explainable, and working on day one — built on [Mastra](https://mastra.ai).

**Status:** early, but real and verified end-to-end — including against a real repository with a deliberately injected bug — diff parsing, impact mapping, LLM-reasoned selection, confidence scoring with a run-everything fallback, flaky-repeat budgets, and a ground-truth eval proving **0 missed regressions** across every scenario tested. Ships as a CLI and a GitHub Action. Not yet published to npm — see [Installing](#installing).

---

## The problem

Between 50% and 80% of CI test time is spent running tests that a change could not possibly have broken. Existing Test Impact Analysis tools cut that down, but they need a clean dependency graph or a coverage map, they break when that data goes stale, and they hand you a bare list of test names with no reasoning you can check.

The second half of the problem is worse: when a test does fail, nobody knows whether it's real or flaky, so they re-run it and merge anyway.

## What Testpilot does

Runs as a step in CI. On each pull request it:

1. **Reads the diff** — changed files, hunks, added and removed symbols.
2. **Maps the blast radius** — builds a lightweight import graph on the fly and caches it. No pre-existing coverage map required.
3. **Selects the test set** — `must-run` / `should-run` / `skip`, each with a one-line rationale a human can audit.
4. **Budgets for flakiness** — estimates how many repeat runs a new or unstable test needs before a green result means anything.
5. **Keeps a safety net** — emits a confidence score, and falls back to running everything when it drops too low.
6. **Reports** — a PR comment covering what ran, what was skipped and why, flaky risks, and estimated CI minutes saved.

## How it differs from what exists

Launchable, Sealights, and Datadog Test Optimization are real, and they work. Testpilot is not claiming the category is empty — it's claiming there's no *open, explainable, zero-setup* version of it.

| Existing tools | Testpilot |
|---|---|
| ML-model based — output is a bare list | LLM-reasoning based — every selection carries a rationale you can audit |
| Need a large history of past runs before working | Works day one — no training data, no coverage map |
| Closed-source SaaS — your code metadata leaves your infra | Open source and self-hostable |
| No first-class flaky run-budget | Estimates the repeat runs a test needs to be trusted |

## Proof, not a pitch

Every number below comes from [`fixtures/sample-repo-scenarios/metrics-report.md`](fixtures/sample-repo-scenarios/metrics-report.md), produced by `npm run eval` against a small, real Vitest project with a known dependency structure — reproducible by anyone who clones the repo and runs it themselves.

| Metric | `openai/gpt-5.4-mini` | `groq/openai/gpt-oss-120b` |
|---|---|---|
| **Missed regressions** (the trust metric) | **0 of 6** | **0 of 6** |
| Confidence calibration | 6/6 correct | 6/6 correct |
| Selection efficiency (safely-skippable tests actually skipped) | **13–18 of 20** across runs * | 2 of 20 |

\* Selection efficiency varies run to run, because the selection step is a model call and not a deterministic function — 13, 16, and 18 of 20 across separate runs of the identical eval. **Missed regressions read 0 in every one of them.** The number that must not move doesn't; the number that measures thrift does, and publishing a single flattering figure for it would be dishonest.

One of those six scenarios seeds an actual off-by-one bug in a shared utility, breaking three tests transitively — verified by really running the suite, not by asserting what should happen. Testpilot ran all three affected tests; nothing was skipped that shouldn't have been.

**The safety property holds on both models. The savings do not.** This is the single most important thing to know before adopting Testpilot: a weaker model is not less safe, it is just useless — it marks nearly everything `should-run`, and you save nothing. Model choice is the difference between a working tool and an expensive no-op, so pick accordingly and re-run `npm run eval` against your own repo before trusting any number here.

### Verified on a real repository, not just the fixture

The fixture repo has five test files. To check that the numbers survive contact with something real, the same evaluation was run against Testpilot's own repository (29 test files) using its real `git merge-base` path:

- A genuine bug was injected into a source file (`Math.max` → `Math.min` in the flaky-budget floor). Running the suite confirmed it broke **two** test files — one directly, one transitively through the import chain.
- Testpilot flagged **both** — the direct one `must-run`, the transitive one `should-run` at depth 2 with a rationale naming the dependency — while skipping 26 of 29 tests. **0 missed regressions**, on a real repo, with a real bug, ground truth measured by actually running Vitest.

**Cost and latency do not generalize from the fixture.** The prompt carries one entry per test, so both grow with suite size: ~1,600–1,900 tokens and ~2.1–2.5s on the 5-test fixture, but ~16–40s on this repo's 29 tests, and a 46-file diff produced a request large enough to blow past Groq's free-tier per-minute token cap outright. When that happens Testpilot runs everything and says why — it never fails the CI step — but "a couple of seconds" is a small-suite figure, not a promise.

A further finding, about confidence scoring on config-only changes, is under [Known limitations](#known-limitations).

## Requirements

- **Node.js 22.18+** (24 LTS recommended) — Testpilot runs its TypeScript entry point directly, and Node enables that by default from 22.18
- **An API key for one model provider** — Groq or OpenAI by default, or any provider Mastra's router supports. See [Setup](#setup) below.
- A TypeScript project using **Vitest** — the first ecosystem targeted. Python/pytest is planned as a second adapter.

## Setup

Two steps, once per repository.

**1. Get a provider key.** Groq's free tier is enough to try it: [console.groq.com/keys](https://console.groq.com/keys).

**2. Give it to Testpilot.** In CI, that's a repository secret:

```bash
gh secret set GROQ_API_KEY        # paste the key when prompted
```

then pass it to the action (the [example workflow](examples/testpilot-workflow.yml) already does):

```yaml
- uses: athul-2003/TestPilot@v0.1.0
  with:
    groq-api-key: ${{ secrets.GROQ_API_KEY }}
```

Locally, put it in `.env` instead — `cp .env.example .env` and fill in the key.

### Using OpenAI instead

Any provider Mastra's router supports works. **The key alone isn't enough — you also have to point the model at that provider**, or Testpilot keeps using its Groq default and your key goes unused:

```yaml
- uses: athul-2003/TestPilot@v0.1.0
  with:
    openai-api-key: ${{ secrets.OPENAI_API_KEY }}
    model: openai/gpt-5.4-mini      # required, or it still tries Groq
```

Locally, the equivalent is `OPENAI_API_KEY=...` plus `TESTPILOT_MODEL=openai/gpt-5.4-mini` in `.env`.

This is worth doing: as the table in [Proof, not a pitch](#proof-not-a-pitch) shows, a stronger model skipped 13–18 of 20 safely-skippable tests against 2 of 20 for the free-tier default. If you supply one key but leave the model pointing elsewhere, Testpilot notices and says so in the report rather than just failing.

**Why you have to do this yourself.** The key is tied to your own account and billing, so nothing Testpilot installs can create one for you, and a package that wrote credentials during install would be indistinguishable from a supply-chain attack. It's the same one-time step Codecov, Snyk, and Datadog need. If you forget it, Testpilot doesn't break your build: it runs the full suite and prints these instructions in the pull-request comment.

**"Working on day one" means no *data* setup** — no coverage map, no training corpus, no history of past runs, which is what comparable tools require before they do anything useful. It does not mean no API key.

**To use a local or self-hosted model, there's no key at all** — point `TESTPILOT_MODEL` at your endpoint and Testpilot never contacts a third party. See [Privacy](#privacy).

## Installing

**Not yet published to npm.** Until it is, use it directly from this repository:

```bash
git clone https://github.com/athul-2003/TestPilot.git
cd TestPilot
npm install
cp .env.example .env      # add a provider key — see Models below
```

### As a GitHub Action

The primary intended usage. Copy [`examples/testpilot-workflow.yml`](examples/testpilot-workflow.yml) into your repo at `.github/workflows/testpilot.yml`, add a `GROQ_API_KEY` secret (`gh secret set GROQ_API_KEY`), and every PR gets a report comment. The example spells out the two things it needs that are easy to miss: `fetch-depth: 0` on checkout (Testpilot needs real history to find a merge base) and the exact token permissions the comment-posting step requires.

### As a CLI

```bash
node src/cli.ts --repo-root /path/to/your/repo
```

Computes `git diff <merge-base> HEAD` for you, runs the full pipeline, and prints the Markdown report. `--json` for the full structured result, `--out <file>` to write instead of printing, `--diff-file <path>` to supply a diff directly instead of running git. `--help` for the rest.

### Programmatically

```ts
import { triageWorkflow } from 'testpilot';

const run = await triageWorkflow.createRun();
const result = await run.start({ inputData: { repoRoot, diff } });
```

## Studio

```bash
npm run dev
```

Opens Mastra Studio at `http://localhost:4111` — run any tool, agent, or the full workflow, and inspect every intermediate step. The fastest way to see what Testpilot is actually reasoning about on a real diff.

## Models

Testpilot's agents run on one model, a plain `"provider/model"` string:

| Setting | Default | Used for |
|---|---|---|
| `TESTPILOT_MODEL` | `groq/openai/gpt-oss-120b` | Every agent call — test selection and flaky assessment |

Point it at whatever you like — a different provider, or a local model. Swapping is a one-line change, which is what makes "self-hostable" a real claim rather than a slogan.

### Token budget

The selection prompt describes every test in your repo, so it grows with the suite rather than with the change. Left unchecked that eventually exceeds a provider limit and the run fails. Testpilot sizes each request against a budget instead:

| Setting | Default | What it does |
|---|---|---|
| `TESTPILOT_MAX_REQUEST_TOKENS` | `7000` | The provider limit to stay under. Set it to whatever your tier allows. |
| `TESTPILOT_REQUEST_OVERHEAD_TOKENS` | `3200` | Reserved for system instructions, the output schema, and the model's reply. Measured, not guessed. |
| `TESTPILOT_MAX_DEPENDENTS_PER_IMPACT` | `25` | Cap on dependents listed per changed file. |

When a change doesn't fit, Testpilot trims in a fixed order — dependent lists first, then symbol lists, then whole tests, dropping the *least* graph-reachable tests last. **Anything withheld from the prompt is assigned `should-run`, never `skip`**, because nothing reasoned about it. Budget pressure costs you efficiency; it can't cost you a missed regression. Every trim is stated in the report.

The default sits under Groq's free-tier 8,000 tokens/minute. A 47-file diff against this repo — which previously failed outright — now completes in ~5,300 tokens, classifying the 5 most-reachable tests and deferring 25 to `should-run`.

> **This choice decides whether Testpilot saves you anything.** The default is a fast, free-tier-friendly model, which makes it a good way to *try* Testpilot — but as the table in [Proof, not a pitch](#proof-not-a-pitch) shows, it skipped only 2 of 20 safely-skippable tests, against 13–18 of 20 for `openai/gpt-5.4-mini`. Both were equally safe; only one actually saved CI time. **For real use, point `TESTPILOT_MODEL` at a stronger reasoning model** and verify with `npm run eval` on your own repo.

`TESTPILOT_MODEL_CRITICAL` also exists in `src/mastra/config.ts`, reserved for a future dynamic-tiering feature (routing genuinely ambiguous selection calls to a stronger model mid-run) — it's not wired into any agent yet, disclosed here rather than left as a gap between what's documented and what runs.

## Privacy

Be clear-eyed about this: **by default, your diff and source metadata are sent to a third-party model provider.** "Self-hostable" means you *can* point Testpilot at a local model so nothing leaves your infrastructure — it does not mean the default does that. Set `TESTPILOT_MODEL` to a local endpoint and it will.

## Known limitations

Recorded here rather than left for someone to discover the hard way:

- **Selection efficiency depends heavily on the model.** On the default free-tier model, `should-run` swamps `skip` and the savings approach zero; on a stronger model the same eval skips 13–18 of 20. Safety held in every run either way — see "Proof, not a pitch" above.
- **The prompt grows with the size of your test suite**, because every test in the inventory is described to the model. On a large suite, or a large diff, the request can exceed a provider's per-minute token limit — Groq's free tier caps at 8,000. When that happens Testpilot runs the full suite and reports why, rather than failing; but a big repo will want a provider tier sized for it.
- **Test discovery is filename-based (`*.test.ts` / `*.spec.ts`) and does not read your Vitest `include`/`exclude` config.** A file your test runner is configured to ignore can still show up in the inventory and get classified. It costs prompt space and noise, never correctness.
- **A change touching zero TypeScript files (e.g. `package.json`) currently scores maximum confidence**, despite Testpilot having no real insight into what it might do. The confidence formula treats "nothing to search" as full certainty rather than a blind spot. Recorded as a candidate refinement, not yet implemented.
- **`import type` isn't distinguished from a runtime import** when building the dependency graph, so a purely type-level change can still show up as reachable and get over-included. Safe (never causes a missed regression), just less efficient than it could be.
- **No Node package-exports (`"exports"` field) resolution** — a bare specifier that only resolves through that mechanism is treated as external and produces no edge.
- **The diff-size ceiling is ~40k characters.** Past that, files are truncated and confidence drops accordingly, rather than reasoning silently over a partial picture.
- **TypeScript + Vitest only, for now.** Python/pytest is planned as a second adapter, not yet built.
- **Minutes-saved is a placeholder, not a measurement.** It assumes 0.1 min/unit test, 0.5 min/integration test, 2 min/e2e test — stated in every report, not just here — until real per-test timing data exists.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Mastra Studio — run agents and workflows, inspect every step |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm test` | Vitest, single run |
| `npm run build` | Production build |
| `npm run eval` | The ground-truth regression-guard eval — real model calls, real Vitest execution |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full flow, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for community expectations.

## License

[Apache 2.0](LICENSE).
