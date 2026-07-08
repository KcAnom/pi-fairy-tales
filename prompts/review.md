---
description: Review the working diff for real defects
argument-hint: "[focus, e.g. security]"
---

Review the current working diff (staged + unstaged + untracked). Focus: $@

For every issue: verify it is real by reading the surrounding code before reporting it. Report findings ranked by severity with file:line, the concrete failure scenario, and a suggested fix. If the diff is clean, say so and list what you checked. Do not modify files.

For a deeper multi-agent pass, use the deep-review skill instead.
