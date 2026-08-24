# Testpilot

> Launchable-style test selection, but open-source, self-hostable, explainable, and works with zero setup — built on [Mastra](https://mastra.ai).

**Status:** early, but real and verified end-to-end — diff parsing, impact mapping, LLM-reasoned selection, confidence scoring with a run-everything fallback, flaky-repeat budgets, and a ground-truth eval proving **0 missed regressions** across every scenario tested. Ships as a CLI and a GitHub Action. Not yet published to npm — see [Installing](#installing).

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

| Metric | Result |
|---|---|
| **Missed regressions** (the trust metric) | **0 of 6 scenarios** — including one seeding a real, deliberate bug that genuinely broke 3 tests |
| Confidence calibration | 6/6 scenarios matched their expected confident-vs-fallback outcome |
| Cost per run | ~1,600–1,900 tokens, ~2.1–2.5 seconds on Groq — comfortably under a $0.05 / 60s budget |

One of those six scenarios seeds an actual off-by-one bug in a shared utility, breaking three tests transitively — verified by really running the suite, not by asserting what should happen. Testpilot ran all three affected tests; nothing was skipped that shouldn't have been.

**What the eval also found, and didn't hide:** selection efficiency (how many of the safely-skippable tests actually got skipped) was 2 of 20 and 4 of 20 across two separate real runs. The safety property held in both — but Testpilot currently trades away much of its CI-minute-saving upside for extra caution, favoring `should-run` over `skip` more often than a maximally-efficient tool would. That's the honest state of it right now, not something smoothed over for this README. A second finding, about confidence scoring on config-only changes, is recorded under [Known limitations](#known-limitations).

## Requirements

- **Node.js 22.13+** (24 LTS recommended)
- An API key for at least one model provider — **Groq** or **OpenAI** by default, though Mastra's router accepts any provider it supports
- A TypeScript project using **Vitest** — the first ecosystem targeted. Python/pytest is planned as a second adapter.

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

`TESTPILOT_MODEL_CRITICAL` also exists in `src/mastra/config.ts`, reserved for a future dynamic-tiering feature (routing genuinely ambiguous selection calls to a stronger model mid-run) — it's not wired into any agent yet, disclosed here rather than left as a gap between what's documented and what runs.

## Privacy

Be clear-eyed about this: **by default, your diff and source metadata are sent to a third-party model provider.** "Self-hostable" means you *can* point Testpilot at a local model so nothing leaves your infrastructure — it does not mean the default does that. Set `TESTPILOT_MODEL` to a local endpoint and it will.

## Known limitations

Recorded here rather than left for someone to discover the hard way:

- **`should-run` is used far more often than `skip`.** See "Proof, not a pitch" above — the safety property is solid, the efficiency isn't fully there yet.
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
