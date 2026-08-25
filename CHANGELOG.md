# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Token budgeting for the selection prompt.** The prompt describes every test in the repo, so it grew with the suite rather than with the change and could exceed a provider's limit outright. Requests are now sized against `TESTPILOT_MAX_REQUEST_TOKENS` (default 7000, under Groq's free-tier 8000/min). When a change doesn't fit, Testpilot trims dependent lists, then symbol lists, then the least graph-reachable tests. **Anything withheld from the prompt is assigned `should-run`, never `skip`** — budget pressure costs efficiency, never safety. A 47-file diff that previously failed outright now completes in ~5,300 tokens.
- **Token and latency cost reported in every PR comment**, so the spend is visible in the same place the time saving is claimed.
- **A warnings section in the report.** Omitted or invented test paths, deferred tests, and trimmed context were all previously computed and then silently dropped.
- **Testpilot now runs on its own pull requests** (`.github/workflows/testpilot.yml`), using `./` rather than a released tag, so every PR exercises the Action as it stands on that branch. The composite Action had never actually executed before this; it failed on its first real run, which is how the empty-environment-variable bug below was found.
- `SECURITY.md` and this changelog.

### Fixed

- **The published package was entirely non-functional.** It shipped raw TypeScript, and Node refuses to strip types from files under `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so both `npx testpilot` and `import from 'testpilot'` failed outright on a real install. The package now ships compiled JavaScript with type declarations, built via `tsconfig.build.json` and `prepack`. Running TypeScript directly still works from a git checkout, which is how the GitHub Action operates.
- **`typescript` was a devDependency but is imported at runtime** by the AST and import-graph tools. Every consumer would have hit `Cannot find package 'typescript'`. Moved to `dependencies`.
- **`@mastra/libsql` resolved to an incompatible version on a fresh install.** The caret range allowed 1.21.x, which needs a newer `@mastra/core` than the exact 1.59.0 pin provides; the repo only worked because its lockfile happened to hold 1.20.0. Pinned to the tested pair.
- **The documented programmatic API did not exist.** The README showed `import { triageWorkflow } from 'testpilot'`, but only `mastra` was exported. `triageWorkflow` is now exported.
- The package shipped its own test files and the fixture-dependent evaluation harness — 37 files, including modules that would throw on import. Now 21 files of runnable code.

- **An empty environment variable is no longer treated as a value.** A GitHub composite action passes unsupplied inputs as empty strings, so `TESTPILOT_MODEL=""` reached the agent — and `??` only guards `null`/`undefined`, so the empty string won and the Action died with "LanguageModel is required". Every adopter following the example workflow would have hit this. The numeric settings shared the bug with a worse failure mode, since `Number('')` is `0`: an empty `TESTPILOT_CONFIDENCE_THRESHOLD` meant a threshold of 0, which every score clears — silently removing the run-everything safety net.
- **The documented Node minimum was wrong.** The CLI entry point is a `.ts` file Node runs directly, which needs the type stripping enabled by default from **22.18** — but `engines`, the README, CONTRIBUTING, and the example workflow all said 22.13 or pinned `'22'`.
- **A failed selection call no longer fails the run.** A provider outage or rate limit propagated out of the workflow and exited non-zero with no report, contradicting the CLI's own principle that Testpilot reports rather than gating the build. It now falls back to running the full suite and names the cause, exactly as a low-confidence result does.
- **A test omitted from the model's response was dropped from every bucket** — never run, never skipped, invisible in the report. It now defaults to `must-run`.
- **A hallucinated test path was warned about but returned unfiltered**, so a nonexistent file could reach CI. It is now dropped.
- **The import-graph cache stored resolved paths**, freezing a failed resolution permanently: a file importing something not yet created never picked it up once it existed. It now caches raw specifiers and re-resolves each run.
- **The evaluation harness matched paths with a case-sensitive prefix**, which could make the regression-guard scorer report zero misses when one genuinely occurred. It now resolves through `realpath` and fails loudly instead of silently.
- Changed `.d.ts` files read as "deleted" from the import graph, wrongly lowering confidence.
- `Infinity - Infinity` in the test-ranking comparator produced `NaN`, silently corrupting the sort order.

### Changed

- **Documented that model choice, not design, drives selection efficiency.** The same evaluation skips 2 of 20 safely-skippable tests on the default free-tier model and 13–18 of 20 on `openai/gpt-5.4-mini`. Safety held on both; savings did not. This was previously published as a design limitation.
- Cost and latency figures are now labelled as fixture-scale and explained, rather than presented as general. Real suites are substantially slower.
- The metrics report records which model produced it.
- Flaky-budget estimates run with bounded concurrency and per-item error isolation; one failure no longer sinks the rest.
- Removed the leftover Phase 0 smoke agent from the live Mastra instance.

## [0.1.0]

Initial working engine: diff parsing, import-graph impact mapping, LLM-reasoned test selection with per-test rationales, confidence scoring with a run-everything fallback, flaky repeat-run budgets, a ground-truth regression-guard evaluation, a CLI, and a composite GitHub Action.
