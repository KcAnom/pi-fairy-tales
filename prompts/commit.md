---
description: Inspect changes and write a proper commit
argument-hint: "[optional scope or hint]"
---

Commit the current work. Hint from user (may be empty): $@

1. Run `git status` and `git diff` (and `git diff --cached`) to see what actually changed. Read before writing.
2. Stage the files that belong together as one logical change. Never stage secrets, .env files, or generated artifacts — call them out instead.
3. Write the commit: imperative subject ≤72 chars stating what the change does; body explaining why, if not obvious.
4. Report the commit hash and subject, plus anything left uncommitted and why.
