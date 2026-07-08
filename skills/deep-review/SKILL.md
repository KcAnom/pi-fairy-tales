---
name: deep-review
description: Multi-agent code review. Fans out review and explore subagents over the working diff or a named target, verifies findings before reporting, and merges them into one severity-ranked report. Use when the user asks for a thorough review, audit, or "find bugs" pass.
---

# Deep Review

Review code with parallel subagents and verify findings before reporting.

## Procedure

1. Establish scope. Default: the working diff (`git diff` + `git diff --cached`, plus untracked files from `git status`). If the user named files/dirs, use those instead. If the scope is empty, say so and stop.
2. In ONE message, spawn parallel `agent` calls (role `review`) — one per dimension, each with the concrete file list and diff context:
   - correctness: bugs, broken edge cases, wrong logic
   - safety: security issues, injection, secrets, unsafe file/network ops
   - contracts: API misuse, type mismatches, broken callers elsewhere in the repo
3. For each finding returned, verify it yourself: read the exact code cited and confirm the failure scenario is real. Drop anything you cannot confirm; use an `explore` agent to check callers when needed.
4. Report: confirmed findings ranked most-severe first, each with `file:line`, the failure scenario, and a suggested fix. State explicitly how many raw findings were dropped as unconfirmed. If nothing survives, say the review found no confirmed defects and list what was checked.

Do not modify any files during a review.
