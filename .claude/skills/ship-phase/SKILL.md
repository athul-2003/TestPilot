---
name: ship-phase
description: Ship any unit of Testpilot work — a phase from worksheet.md, a feature, a fix, or a docs change — through the mandatory branch → commit → push → PR → checks → merge flow. Use this whenever work is ready to land on the repo, whenever the user says "commit", "push", "ship it", "open a PR", "merge this", or when starting a new phase or task that needs its own branch. Nothing on this project lands on main any other way.
---

# Ship a phase or task

This project's `main` is a public portfolio artefact. Every unit of work — a full phase, a single bugfix, a README tweak — travels the same road: **fresh branch off the latest `main` → commit → push → PR → all gates green → merge → clean up**. There are no direct commits to `main` and no exceptions for "small" changes.

Repo: `https://github.com/athul-2003/TestPilot` · default branch `main` · `gh` CLI is authenticated as `athul-2003`.

---

## 0. Before you touch git

Confirm three things, in order. If any fails, stop and fix it before branching.

1. **Know what you're shipping.** One coherent unit of work with a name. If the change spans two unrelated concerns, that's two branches and two PRs — split it.
2. **The work actually runs.** The developer has executed it and reported success. Never open a PR on code nobody has run.
3. **No secrets in the diff.** `.env`, API keys, tokens, `*.db` files. Check before staging, not after pushing — a pushed secret is a leaked secret even if the next commit removes it.

---

## 1. Start from the latest `main`

Always re-sync first. Branching from a stale `main` is the most common cause of a messy PR.

```bash
git checkout main
git pull --ff-only origin main
git status --short          # must be clean before branching
```

If `git status` is dirty, resolve it — stash, commit to the existing branch, or discard — before continuing. Never carry unrelated working-tree changes onto a new branch.

Then cut the branch:

```bash
git checkout -b <branch-name>
```

### Branch naming

| Kind of work | Pattern | Example |
|---|---|---|
| A phase from `worksheet.md` | `phase/<n>-<slug>` | `phase/2-impact-graph` |
| A feature inside a phase | `feat/<slug>` | `feat/barrel-file-resolution` |
| A bugfix | `fix/<slug>` | `fix/rename-hunk-parsing` |
| Docs only | `docs/<slug>` | `docs/readme-quickstart` |
| Tooling, CI, deps | `chore/<slug>` | `chore/vitest-config` |
| Tests only | `test/<slug>` | `test/diff-tool-fixtures` |

Lowercase, hyphen-separated, no issue numbers in the branch name.

---

## 2. Do the work, then run the quality gates locally

Run every gate that exists in the project **before** committing. A red CI check on a PR is a wasted round trip.

```bash
npm run typecheck   # or: npx tsc --noEmit
npm run lint
npm test
npm run build
```

Skip only the scripts that genuinely don't exist yet — say which ones you skipped and why in the PR body. Never disable a rule, add a blanket `// @ts-ignore`, or mark a test `.skip` to get a gate green. If a gate is failing for a real reason, fix the cause or stop and raise it with the developer.

Phase work has one more gate: **the phase's Exit gate in [worksheet.md](../../../worksheet.md) must actually be met.** Read it and verify it literally. If it isn't met, the phase isn't shippable yet.

---

## 3. Stage and commit

Stage deliberately. Review what you're about to commit:

```bash
git status --short
git diff                    # unstaged
git add <specific paths>    # prefer explicit paths over `git add -A`
git diff --cached           # read this before committing
```

Scan `git diff --cached` for anything that shouldn't be public: keys, tokens, absolute local paths, personal data, large binaries, `.env` content, database files.

### Commit message format

Conventional Commits, imperative mood, wrapped body explaining **why**:

```
<type>(<scope>): <subject under 72 chars, no trailing period>

Why this change exists and what it does, in prose. Reference the
worksheet phase when relevant. Note any decision made along the way
and the alternative rejected.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

Types: `feat`, `fix`, `docs`, `test`, `chore`, `refactor`, `perf`, `ci`.
Scopes used on this project: `diff-tool`, `impact`, `selection`, `workflow`, `flaky`, `eval`, `report`, `ci`, `docs`.

On Windows, pass multi-line messages with a heredoc through the Bash tool (PowerShell here-strings are not available in that tool):

```bash
git commit -m "$(cat <<'EOF'
feat(impact): build cached reverse-dependency graph

Phase 2. Parses TS imports with the compiler API and inverts the
forward graph so a changed file yields its dependents directly.
Cache is keyed on file hash and invalidated per file rather than
wholesale, which keeps warm runs under a second on the fixture repo.

Chose the compiler API over a regex scan because path aliases and
barrel re-exports are not tractable with regex.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

Prefer several focused commits over one giant one — but never commit a broken intermediate state.

---

## 4. Push

```bash
git push -u origin <branch-name>
```

Never force-push a branch that has an open PR under review, unless the developer explicitly asks. If you must rewrite history on your own un-reviewed branch, use `--force-with-lease`, never bare `--force`.

---

## 5. Open the pull request

```bash
gh pr create --base main --head <branch-name> --title "<title>" --body "$(cat <<'EOF'
<body>
EOF
)"
```

Title: same convention as the commit subject (`feat(impact): build cached reverse-dependency graph`).

### PR body template

```markdown
## What

One paragraph: what this changes and why it exists.

## Worksheet

Phase N — <name>. <Or: "Not a phase — <reason>.">

## Exit gate

Quote the phase's exit gate from worksheet.md and state how it was verified.

## How it was verified

- [ ] `npm run typecheck` — pass / n/a
- [ ] `npm run lint` — pass / n/a
- [ ] `npm test` — pass / n/a
- [ ] `npm run build` — pass / n/a
- [ ] Ran in Studio / on fixtures — describe what was observed

## Decisions made

Any judgement call taken here, and the alternative that was rejected.

## Risks & follow-ups

What this doesn't cover, and what it might break.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

Fill every section honestly. If a gate was skipped, write "n/a — script doesn't exist yet", not a tick.

If the work closes a worksheet open decision (D1–D7), say which one and what was decided — that decision needs to flow back into `worksheet.md`.

---

## 6. Wait for checks and review

```bash
gh pr checks --watch
gh pr view --json number,title,mergeable,mergeStateStatus,statusCheckRollup
```

- **All checks must be green.** A failing check is a stop, not a note in the PR body.
- **Never merge with a red or pending check.** If a check is flaky, re-run it (`gh run rerun <run-id>`) and investigate the flake — on a project about flaky tests, ignoring one is indefensible.
- If review comments arrive, address them with new commits on the same branch. Don't squash away the review trail before merge.
- If `mergeStateStatus` is `BEHIND`, update the branch:
  ```bash
  git fetch origin main
  git rebase origin/main       # or: gh pr merge --auto  after resolving
  git push --force-with-lease
  ```

Consider running `/code-review` on the branch before merging anything substantial.

---

## 7. Merge

Squash merge, so `main` reads as one clean commit per unit of work:

```bash
gh pr merge <number> --squash --delete-branch
```

Confirm the squash commit message is the PR title plus a useful body — edit it if `gh` has stuffed it with intermediate commit subjects.

**Ask the developer before merging** unless they've already said to merge this PR, or told you to run the whole flow end to end. Merging is the irreversible step.

---

## 8. Clean up and close the loop

```bash
git checkout main
git pull --ff-only origin main
git branch -d <branch-name>     # local; remote was deleted by --delete-branch
git log --oneline -3            # confirm the squash landed
```

Then close the loop on the project's own bookkeeping:

- [ ] Update the **status board** in [worksheet.md](../../../worksheet.md) — mark the phase ✅ Merged.
- [ ] Tick the completed checkboxes in that phase's section.
- [ ] If an open decision (D1–D7) was resolved, record the decision in the table.
- [ ] If something durable was learned — a Mastra API surprise, a decision with lasting consequences — write it to memory.

Worksheet updates are themselves a change to the repo, so they ride the same flow: either include them in the phase's own PR (preferred — update the worksheet as part of the phase branch, before opening the PR) or ship them as a small `docs/` PR afterwards.

---

## Guardrails

- **Never commit or push to `main` directly.** If you find yourself on `main` with changes, branch first: `git checkout -b <branch>` carries the changes with you.
- **Never commit `.env`, keys, tokens, or `*.db` files.** Verify against `.gitignore` and read `git diff --cached` before every commit.
- **Never use `git push --force`** — `--force-with-lease` only, and never on a branch under review.
- **Never merge a PR with failing or pending checks.**
- **Never weaken a gate to make it pass** — no rule disabling, no `@ts-ignore`, no `.skip` on tests.
- **Never use `git rebase -i`, `git add -i`,** or anything that opens an interactive editor — they don't work in this environment.
- **Never skip hooks** (`--no-verify`) unless the developer explicitly asks.
- **Confirm before merging** unless already authorised for this PR.
- **Report honestly.** If a test fails or a step was skipped, say so plainly with the output. A green summary over a red run is the worst outcome this skill can produce.

---

## Quick reference

```bash
# Full flow
git checkout main && git pull --ff-only origin main
git checkout -b phase/2-impact-graph
# ...work...
npm run typecheck && npm run lint && npm test && npm run build
git add <paths> && git diff --cached
git commit -m "$(cat <<'EOF'
feat(impact): <subject>

<why>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git push -u origin phase/2-impact-graph
gh pr create --base main --title "..." --body "..."
gh pr checks --watch
gh pr merge <n> --squash --delete-branch
git checkout main && git pull --ff-only origin main
```
