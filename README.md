# Testpilot

> Launchable-style test selection, but open-source, self-hostable, explainable, and works with zero setup — built on [Mastra](https://mastra.ai).

**Status: early development.** Phase 0 of 8 complete — the scaffold runs and the model is reachable. Nothing selects tests yet. See [worksheet.md](worksheet.md) for the roadmap and [PROJECT_IDEA_TESTPILOT.md](PROJECT_IDEA_TESTPILOT.md) for the full brief.

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

## Requirements

- **Node.js 22.13+** (24 LTS recommended)
- An API key for at least one model provider — **Groq** or **OpenAI** by default, though Mastra's router accepts any provider it supports
- A TypeScript project using **Vitest** — the first ecosystem targeted. Python/pytest is planned as a second adapter.

## Quickstart

```bash
git clone https://github.com/athul-2003/TestPilot.git
cd TestPilot
npm install

cp .env.example .env      # then add your provider key(s)
npm run dev               # Studio at http://localhost:4111
```

`.env` is gitignored and holds your real keys. `.env.example` is committed and documents which variables exist — copy it, don't edit it.

## Models

Testpilot runs on two tiers, both plain `"provider/model"` strings:

| Setting | Default | Used for |
|---|---|---|
| `TESTPILOT_MODEL` | `groq/openai/gpt-oss-120b` | Everyday runs — the bulk of the work |
| `TESTPILOT_MODEL_CRITICAL` | `openai/gpt-5.4-mini` | Ambiguous selection calls and evaluation runs |

Point either at whatever you like — a different provider, or a local model. Swapping is a one-line change, which is what makes "self-hostable" a real claim rather than a slogan.

## Privacy

Be clear-eyed about this: **by default, your diff and source metadata are sent to a third-party model provider.** "Self-hostable" means you *can* point Testpilot at a local model so nothing leaves your infrastructure — it does not mean the default does that. Set `TESTPILOT_MODEL` to a local endpoint and it will.

## Development

| Command | What it does |
|---|---|
| `npm run dev` | Mastra Studio — run agents and workflows, inspect every step |
| `npm run typecheck` | TypeScript, no emit |
| `npm run lint` | ESLint |
| `npm test` | Vitest, single run |
| `npm run build` | Production build |

Contributions follow the flow in [.claude/skills/ship-phase/SKILL.md](.claude/skills/ship-phase/SKILL.md): a branch off the latest `main`, a PR, green checks, squash merge.

## License

[Apache 2.0](LICENSE).
