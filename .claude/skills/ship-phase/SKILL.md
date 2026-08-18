---
name: ship-phase
description: Ship any unit of Testpilot work — a phase from worksheet.md, a feature, a fix, or a docs change — end to end and unattended: branch off the latest main, commit, push, open a PR, verify all gates, merge, delete the branch locally and remotely, and leave main up to date. Use whenever work is ready to land, whenever the user says "commit", "push", "ship it", "open a PR", "merge this", or when starting a new phase or task that needs its own branch. Nothing on this project lands on main any other way.
---

# Ship a phase or task

This project's `main` is a public portfolio artefact. Every unit of work — a full phase, a single bugfix, a README tweak — travels the same road, and this skill runs the whole road **without stopping to ask**:

> latest `main` → branch → commit → push → PR → verify → merge → delete branch (remote + local) → `main` up to date

Run all nine steps in one go. Do not pause between them for confirmation, and do not hand the user a command to run themselves. The only reason to stop is a **stop condition** (§ Stop conditions) — a real problem that makes merging unsafe.

There are no direct commits to `main` and no exceptions for "small" changes.

Repo: `https://github.com/athul-2003/TestPilot` · default branch `main` · `gh` CLI is authenticated as `athul-2003`.

---

## Step 1 — Pre-flight

Confirm three things. Any failure is a stop condition.

1. **Know what you're shipping.** One coherent unit of work with a name. If the change spans two unrelated concerns, that's two branches and two PRs — split it and run this skill twice.
2. **The work actually runs.** It has been executed and produced the expected result. Never open a PR on code nobody has run.
3. **No secrets in the change.** `.env`, API keys, tokens, `*.db` files. Check before staging, not after pushing — a pushed secret is a leaked secret even if the next commit removes it.

---

## Step 2 — Start from the latest `main`

Always re-sync first. Branching from a stale `main` is the most common cause of a messy PR.

```bash
git checkout main
git pull --ff-only origin main
git status --short          # must be clean before branching
```

If `git status` is dirty with **changes belonging to this unit of work**, that's fine — `git checkout -b` carries them onto the new branch. If it's dirty with **unrelated** changes, stop; that's a stop condition.

Cut the branch:

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

## Step 3 — Run the quality gates locally

Run every gate that exists **before** committing. A red CI check on a PR is a wasted round trip, and this skill merges on its own — so local verification is the real safety net, not a formality.

```bash
npm run typecheck   # or: npx tsc --noEmit
npm run lint
npm test
npm run build
```

Skip only the scripts that genuinely don't exist yet, and record which ones and why in the PR body. **Never disable a rule, add a blanket `// @ts-ignore`, or mark a test `.skip` to get a gate green.** A gate failing for a real reason is a stop condition.

Phase work has one more gate: **the phase's Exit gate in [worksheet.md](../../../worksheet.md) must actually be met.** Read it and verify it literally. If it isn't met, the phase isn't shippable.

Update the worksheet **now**, on this branch, before committing — tick the phase's checkboxes, move the status board entry, and record any open decision (D1–D7) this work resolved. That way the bookkeeping ships inside the same PR instead of trailing behind it.

---

## Step 4 — Stage and commit

Stage deliberately:

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

On Windows, pass multi-line messages with a heredoc through the Bash tool (PowerShell here-strings don't work there):

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

## Step 5 — Push

```bash
git push -u origin <branch-name>
```

Never bare `--force`. If history on your own un-reviewed branch must be rewritten, use `--force-with-lease`.

---

## Step 6 — Open the PR

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

Fill every section honestly. If a gate was skipped, write "n/a — script doesn't exist yet", not a tick. A PR body that overstates verification is worse than no PR body, because this skill merges on the strength of it.

---

## Step 7 — Verify

```bash
gh pr checks --watch                                          # only if checks are configured
gh pr view <n> --json number,mergeable,mergeStateStatus,statusCheckRollup
```

Merge only when **all** of these hold:

- `mergeable` is `MERGEABLE`
- `mergeStateStatus` is `CLEAN` (or `BLOCKED` solely because no review is present on a solo project)
- every entry in `statusCheckRollup` is a success — an empty rollup means no CI is configured yet, which is acceptable until Phase 0 lands one
- every local gate from Step 3 passed
- the phase's Exit gate is genuinely met

If `mergeStateStatus` is `BEHIND`, update the branch and re-verify:

```bash
git fetch origin main
git rebase origin/main
git push --force-with-lease
```

If a check fails intermittently, re-run it (`gh run rerun <run-id>`) **and investigate the flake** — on a project about flaky tests, waving one through is indefensible. If it fails for a real reason, that's a stop condition.

For anything substantial, run `/code-review` on the branch before merging.

---

## Step 8 — Merge

Squash merge, so `main` reads as one clean commit per unit of work:

```bash
gh pr merge <n> --squash --delete-branch
```

Do this automatically once Step 7 passes — no confirmation prompt, no handing the command to the user. Verification is the gate; the user already authorised the flow.

Check the squash commit message is the PR title plus a useful body, and edit it if `gh` has stuffed it with intermediate commit subjects.

---

## Step 9 — Clean up and leave `main` current

`--delete-branch` removes the remote branch. The local branch and the stale remote-tracking ref need clearing too, and `main` must end the run fully up to date:

```bash
git checkout main
git pull --ff-only origin main
git remote prune origin              # drop the stale origin/<branch> ref
git branch -D <branch-name>          # -D, not -d: the squash merge leaves the branch "unmerged" to git
git log --oneline -3                 # confirm the squash landed
git branch -a                        # confirm only main remains, local and remote
```

`git branch -d` fails after a squash merge because the commits were rewritten — `-D` is correct here, and safe, because the work is already on `main`.

Finish by confirming the state out loud: which PR merged, that the branch is gone from both sides, and that `main` is current.

Then close the loop on anything the PR didn't already carry:

- [ ] Worksheet status board and checkboxes updated (should have ridden in the PR — verify)
- [ ] Any resolved open decision (D1–D7) recorded in the worksheet table
- [ ] Anything durable learned — a Mastra API surprise, a decision with lasting consequences — written to memory

---

## Stop conditions

Stop and tell the user what happened, plainly and with the actual output. **Never work around one of these to get to a merge.**

- A quality gate fails for a real reason.
- The phase's Exit gate is not met.
- A secret, key, token, or database file appears in the diff.
- The working tree holds unrelated changes that can't be cleanly separated.
- The PR has a merge conflict a rebase doesn't resolve.
- A CI check fails, or flakes repeatedly.
- The change spans two unrelated concerns and should be two PRs.
- Anything requires force-pushing over someone else's work.

When you stop, say which step you reached, what blocked it, and what you'd do next. Leave the branch and PR in place — don't tear down work so the tree looks tidy.

---

## Guardrails

- **Never commit or push to `main` directly.** If you find yourself on `main` with changes, branch first — `git checkout -b <branch>` carries them with you.
- **Never commit `.env`, keys, tokens, or `*.db` files.** Check against `.gitignore` and read `git diff --cached` every time.
- **Never `git push --force`** — `--force-with-lease` only.
- **Never merge on failing or pending checks.**
- **Never weaken a gate to make it pass** — no rule disabling, no `@ts-ignore`, no `.skip`.
- **Never use `git rebase -i`, `git add -i`,** or anything that opens an interactive editor — they don't work in this environment.
- **Never skip hooks** (`--no-verify`) unless explicitly asked.
- **Never leave `main` stale or a merged branch lying around.** Step 9 is part of the job, not an optional tidy-up.
- **Report honestly.** If a test fails or a step was skipped, say so with the output. A green summary over a red run is the worst outcome this skill can produce.

---

## Quick reference — the whole flow

```bash
# 2. branch off latest main
git checkout main && git pull --ff-only origin main
git checkout -b phase/2-impact-graph

# 3. gates (+ update worksheet on this branch)
npm run typecheck && npm run lint && npm test && npm run build

# 4. commit
git add <paths> && git diff --cached
git commit -m "$(cat <<'EOF'
feat(impact): <subject>

<why>

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"

# 5-6. push + PR
git push -u origin phase/2-impact-graph
gh pr create --base main --title "..." --body "..."

# 7-8. verify + merge
gh pr checks --watch
gh pr view <n> --json mergeable,mergeStateStatus,statusCheckRollup
gh pr merge <n> --squash --delete-branch

# 9. clean up, main current
git checkout main && git pull --ff-only origin main
git remote prune origin && git branch -D phase/2-impact-graph
git branch -a
```
