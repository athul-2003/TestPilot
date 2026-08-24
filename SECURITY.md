# Security Policy

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.

Use GitHub's [private vulnerability reporting](https://github.com/athul-2003/TestPilot/security/advisories/new) for this repository. If that isn't available to you, open an issue asking for a private contact channel — without including any details of the vulnerability itself.

Expect an acknowledgement within a week. This is a small project maintained in spare time; there is no paid support and no bounty programme, and saying so plainly is fairer than implying a response time nobody is on call to meet.

## What this project handles

Testpilot is worth thinking about carefully because of what passes through it:

- **Your source code and diffs are sent to a third-party model provider by default.** This is the single most important thing to understand before adopting it — see [Privacy](README.md#privacy) in the README. Point `TESTPILOT_MODEL` at a local or self-hosted model and nothing leaves your infrastructure.
- **Provider API keys** are read from the environment (`GROQ_API_KEY`, `OPENAI_API_KEY`). They are never logged, and never written to the report or any cache.
- **It executes `git` as a subprocess** to compute the diff, via `execFile` with an argument array — never a shell string, so a branch name cannot be used for command injection.
- **It writes a cache** into `.testpilot-cache/` inside the repository being analysed. That directory holds parsed import data and test-run history. It should stay gitignored; Testpilot's own `.gitignore` already covers it.
- **It never executes code from the repository it analyses.** Source files are parsed with the TypeScript compiler API, not imported or evaluated. The one place a subprocess runs test code is the evaluation harness, and only against this project's own fixtures.

## Things that are deliberately not guarantees

- The rendered report is Markdown intended for a pull-request comment. It embeds file paths and model-written rationales. If you pipe it somewhere that renders HTML, treat it as untrusted text and escape it.
- Testpilot's selection is advice, not an access-control decision. It reports; it does not gate the build. Do not build a security control on top of "Testpilot said this test could be skipped."
