---
name: handoff
description: Write a session handoff document capturing state, decisions, and next steps so a future session (or another person) can continue seamlessly. Also saves durable facts to memory. Use when the user says handoff, wrap up, save progress, or is about to end a long session.
---

# Handoff

Produce a handoff document for the current session's work.

## Procedure

1. Reconstruct what happened this session: the original request, decisions made (and rejected alternatives), files created/modified (check `git status` and `git log` for ground truth — do not rely on memory alone), verification results, and unfinished work.
2. Write `HANDOFF.md` in the project root (or the path the user names) with sections:
   - **Goal** — what the user wants, in their words
   - **State** — what is done and verified vs in progress vs not started
   - **Key decisions** — with the why
   - **Files** — paths that matter and what changed in them
   - **Next steps** — ordered, concrete, starting with the single most important one
   - **Gotchas** — anything surprising the next session must know
3. Use the `remember` tool for facts that outlive this project session (user preferences, environment quirks, standing constraints) — not for session-local detail.
4. Report the handoff path and the one-line "resume here" instruction.
