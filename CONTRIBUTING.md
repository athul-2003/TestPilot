# Contributing to Testpilot

Thanks for considering it. This project is young — the README is the most
current picture of what's built, and its "Known limitations" section covers
what's been deliberately left for later.

## Before you start

- Read the [README](README.md) for what Testpilot does and, just as
  importantly, what it doesn't do yet.
- For anything beyond a small fix, open an issue first. It's a much shorter
  loop than writing a PR that turns out to conflict with a design decision
  already made — several of the non-obvious ones are summarised in the
  README's "Known limitations".
- Testpilot's one non-negotiable property is **missed regressions ≈ 0** — a
  skipped test that would have failed. Any change touching test selection,
  confidence scoring, or the flaky budget should explain how it was verified
  against that property, not just that it typechecks.

## Development setup

```bash
git clone https://github.com/athul-2003/TestPilot.git
cd TestPilot
npm install
cp .env.example .env      # add a provider key — see the README's Models section
npm run dev                # Studio at http://localhost:4111
```

Requires Node.js 22.18+ (24 LTS recommended) — the CLI is a .ts file Node runs directly, which needs the type stripping enabled by default from 22.18.

## Quality gates

Every change needs to pass all four before it's shippable:

```bash
npm run typecheck
npm run lint
npm test
npm run build
```

For anything touching test selection, also run the ground-truth eval and
check `missed regressions` stayed at 0:

```bash
npm run eval
```

## The flow

1. Branch off the latest `main`.
2. Make the change, with tests. This project's own tests are the model to
   follow: a pure function exported alongside its Mastra tool/agent wrapper,
   fixtures under `fixtures/` for anything needing real files on disk, and a
   fake generator (see `impact-agent.test.ts`) rather than a real model call
   for anything that would otherwise hit the network in CI.
3. Open a PR against `main`. CI (`.github/workflows/ci.yml`) runs the four
   gates automatically; the regression-guard eval runs too if the repo has a
   `GROQ_API_KEY` secret configured.
4. Once checks are green, a maintainer reviews and merges (squash merge, so
   `main` reads as one commit per change).

There's no separate CLA or DCO requirement — a PR is taken as your agreement
that the contribution is licensed under this project's
[Apache 2.0 license](LICENSE).

## Verifying against real APIs, not memory

If you're touching anything Mastra-specific (`createTool`, `createStep`,
`createScorer`, storage), check the actual installed types before relying on
a remembered signature:

```bash
grep -rn "the-thing-youre-about-to-use" node_modules/@mastra/core/dist/**/*.d.ts
```

This project has caught several real API surprises this way — including a
`.branch()` output shape that didn't match the documented pseudocode, and a
`createScorer` that turned out to live in `@mastra/core/evals`, not the
`@mastra/evals` package its name suggests. Docs and memory go stale; the
installed `.d.ts` doesn't.

## Reporting a bug

Open an issue with: what you expected, what happened, and — if it's about a
specific test-selection decision — the diff and repo structure that produced
it. "Testpilot skipped a test it shouldn't have" is the single most valuable
kind of bug report this project can receive.

## Code of Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).
