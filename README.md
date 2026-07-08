# pi-fairy-tales

A Fairy-Tales-class harness for the [pi coding agent](https://github.com/earendil-works/pi-mono): subagent orchestration, persistent memory, plan mode, guard-rail hooks, todo tracking, smart compaction, a live status line, and web fetch — as one local pi package.

## Install

```bash
pi install ~/pi-fairy-tales
```

Local packages load in place: edit any file here and `/reload` inside pi picks it up. Remove with `pi remove ~/pi-fairy-tales`.

## What you get

| Piece | What it does |
|---|---|
| `agent` tool | Delegate to role-specialized subagents: **explore** (read-only scout), **plan** (architect), **build** (implements + verifies), **review** (defect finder), **general**. Multiple `agent` calls in one assistant message run in parallel. `background: true` runs detached and delivers the result when done. Turn/cost/concurrency caps enforced. |
| `agent_control` tool + `/agents` | List, fetch results, or abort runs. Live widget above the editor while agents run. |
| `/agent-model` | Switch subagent model strategy on the fly: **tiered** (per-role models from config) or **single** (one model for every role — follow your session model, or pick any model loaded in pi). Persists in `~/.pi/agent/fairy-tales.json`; roles keep their tier's thinking level in single mode. |
| Memory | `~/.pi/agent/memory/MEMORY.md` index injected each session; `remember` tool saves facts (optionally into `topics/*.md`); `/memory` edits the index. |
| Plan mode | `/plan`, `--plan` flag, or `ctrl+alt+p`. Read-only until the agent presents its plan via `exit_plan` and you approve; approved plans are saved to `~/.pi/agent/plans/`. Survives restarts. |
| Hooks | Config-driven guard rails: bash regex rules and path glob rules (`block` / `confirm`, confirm fail-safes to block headless). Post-edit hook runs `<project>/.pi/test-command` after file edits and steers failures back to the agent to self-fix. Active inside subagents too. |
| `todo` tool | Checklist for multi-step tasks, widget above the editor, state survives restart/fork (rebuilt from the session branch). |
| Smart compaction | `/compact` and auto-compaction produce a structured handoff summary (Request & Intent / Key Decisions / Files & State / Done / Pending). Falls back to pi's default on any error. |
| Status line | `model · ctx N% · $cost · ⚡running agents` in the footer. |
| `fetch` tool | URL → readable text (HTML stripped), 20s timeout, 50KB cap. |
| Skills | `deep-review` (parallel multi-agent review with verification), `handoff` (session handoff doc), `ship` (verify → commit → report). |
| Prompts | `/commit`, `/review`, `/plan-task`, `/standup` — see `prompts/`. |
| `/grimoire` | Browse installed skills, prompts, extensions, and themes in a book overlay. Pairs with pi's `quietStartup: true` setting (enabled) so startup is clean instead of listing everything. Works in plain pi and ftales. |

## Configuration

Defaults ship in [`fairy-tales.config.json`](fairy-tales.config.json). Override globally in `~/.pi/agent/fairy-tales.json` or per project in `<project>/.pi/fairy-tales.json` (deep-merged, project wins). Key sections:

- `tiers` — model per tier (`provider/model-id` + thinkingLevel). Default: scout=deepseek-v4-flash (low), worker=gpt-5.4-mini (medium), brain=deepseek-v4-pro (high).
- `agents` — `maxConcurrent`, `maxTurnsPerRun`, `maxCostPerRunUsd`, `modelMode` (`"tiered"` | `"single"`), `singleModel` (`"session"` or a `provider/model-id`), and the role definitions (tier, tool allowlist, description, `promptAppend`). Prefer `/agent-model` over hand-editing the mode.
- `hooks.bash` / `hooks.paths` — your guard-rail rules (regex / glob, `block` or `confirm`).
- `hooks.postEdit` — post-edit test runner (reads `<project>/.pi/test-command`).
- `memory.dir`, `plans.dir`, `web.*`.

## Design notes

- Subagents run in-process via pi's SDK (`createAgentSession`) with an **empty agentDir + in-memory settings** — installed packages (including pi-fairy-tales itself) never load inside subagents, so recursion is structurally impossible. Guard-rail hooks and `fetch` are re-injected explicitly.
- Cross-extension state flows only over `pi.events` (`src/bus.ts`).
- All file writes go through `withFileMutationQueue` (parallel-tool safe).
- Every UI call is behind `ctx.hasUI` — everything works in `-p`, JSON, and RPC modes; confirm-gated rules fail safe to block.
- Background runs do not survive `/reload` or session switches (documented pi limitation); they are aborted on `session_shutdown`.

## `ftales` — the branded launcher

`ftales` (a tiny wrapper at `~/bin/ftales` — outside Node's version folders, so it survives Node upgrades) launches the same pi with the **Fairy Tales experience** turned on:

- the `fairy-tales` theme (twilight purple / fairy-dust gold, ships in `themes/`)
- a "✧ F A I R Y  T A L E S ✧ — once upon a terminal" startup header
- terminal title `✦ Fairy Tales — <project>`
- a drifting-sparkle working indicator
- **day/night enchantment**: parchment `fairy-tales-dawn` theme 07:00-18:59, twilight `fairy-tales` at night
- **the Enchanted Footer**: `✦ model · ⚘ realm (git branch) · ✒ ink N% (context left) · 🜚 gold (session cost) · ✧ sprites at work`
- **the Fae Council**: subagents appear as 🕯 Will-o'-Wisp (explore), ✶ the Sage (plan), ⚒ the Smith (build), 🪶 the Raven (review), 🜍 the Wanderer (general); finishing every todo triggers "✦ Quest complete ✦"
- **`/tale`**: the session retold as a true storybook chapter ("Once upon a terminal…") in a book overlay — a narrative recap
- **a sparkle title screen** on launch, and sessions auto-named like chapters ("The Tale of …")

Plain `pi` stays completely unbranded. pi persists theme switches to settings.json, so the brand extension records your previous theme in `~/.pi/agent/fairy-tales.json` when `ftales` starts, and the next plain `pi` session automatically switches back. All other harness features (subagents, memory, hooks…) are identical in both.

The launcher is just `FTALES=1 exec pi "$@"`. It lives in `~/bin` (already on PATH), so Node/nvm upgrades never remove it. Recreate if ever needed with:
```bash
printf '#!/bin/sh\nexport FTALES=1\nexec pi "$@"\n' > ~/bin/ftales && chmod +x ~/bin/ftales
```
