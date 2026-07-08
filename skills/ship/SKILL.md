---
name: ship
description: Verify, commit, and summarize finished work. Runs the project's tests, stages only intentional changes, writes a clean commit, and reports honestly. Use when the user says ship it, commit this, or finish up.
---

# Ship

Land the current work properly.

## Procedure

1. Verify first. Run the project's test command (`.pi/test-command` if present, else infer from the repo: package.json scripts, pytest, etc.). If tests fail, STOP and report the failures — do not commit broken work unless the user explicitly says to.
2. Review `git status` and `git diff`. Stage only files that belong to this change. Never stage secrets, `.env` files, build artifacts, or unrelated edits — name anything suspicious instead of committing it.
3. Commit with an imperative subject line (≤72 chars) describing what the change does; add a body explaining why when it isn't obvious.
4. Report: test output summary (pass/fail counts), what was committed (hash + subject), and anything deliberately left uncommitted with the reason.
