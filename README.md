# pi-fairy-tales

A Fairy-Tales-class harness for the [pi coding agent](https://github.com/earendil-works/pi-mono): subagent orchestration, persistent memory, plan mode, guard-rail hooks, todo tracking, smart compaction, a live status line, and web fetch — as one pi package.

**Docs:** [Setup Guide](docs/SETUP.md) (step-by-step, agent-executable) · [Configuration Reference](docs/CONFIGURATION.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Changelog](CHANGELOG.md) · [AGENTS.md](AGENTS.md) (for coding agents working on this repo)

## Install

On a fresh machine (yours or anyone's):

```bash
npm i -g @earendil-works/pi-coding-agent        # 1. pi itself
pi install git:github.com/KcAnom/pi-fairy-tales  # 2. this package
```

Then create the `ftales` launcher (or clone the repo and run `./install.sh`, which does both steps):

```bash
mkdir -p ~/bin && printf '#!/bin/sh\nexport FTALES=1\nexec pi "$@"\n' > ~/bin/ftales && chmod +x ~/bin/ftales
```

For local development instead: clone anywhere and `pi install /path/to/pi-fairy-tales` — local packages load in place, so edit + `/reload` inside pi picks changes up. Remove with `pi remove <source>`.

**Bring your own models.** Nothing personal ships in this package — API keys live in your own `~/.pi/agent/auth.json` (log in with `/login` inside pi), and the default subagent tiers reference models you may not have. Point the tiers at whatever you use by creating `~/.pi/agent/fairy-tales.json`:

```json
{
  "tiers": {
    "scout":  { "model": "your-provider/cheap-model",  "thinkingLevel": "low" },
    "worker": { "model": "your-provider/main-model",   "thinkingLevel": "medium" },
    "brain":  { "model": "your-provider/best-model",   "thinkingLevel": "high" }
  }
}
```

Or skip tiers entirely: run `/agent-model` inside pi and pick "Single — follow my session model". If a tier model is unavailable, subagents automatically fall back to your session model with a visible warning — nothing breaks.

## What you get

| Piece | What it does |
|---|---|
| `agent` tool | Delegate to role-specialized subagents: **explore**, **plan**, **build**, **review**, **general** (config-driven — add your own). Multiple calls in one message run in parallel; overflow **queues** instead of failing. Each returns a structured result envelope; `background: true` runs detached. Turn/cost/concurrency caps enforced, with token-based cost estimation on subscription models and transient-error retry. |
| `agent_control` tool + `/agents` | `list` / `result` / `abort`, plus `continue` (send a follow-up to a just-finished agent, reusing its context) and `transcript` (path to a run's full log). Live widget while agents run. |
| `/agent-model` | Switch subagent model strategy: **tiered** (per-role) or **single** (one model — session or a specific one). Persists to `~/.pi/agent/fairy-tales.json`. |
| Memory | Relevance-ranked `MEMORY.md` injected each session; `remember` (deduped) and `forget` tools; `#topic` autocomplete; `/memory` editor. |
| Plan mode | `/plan`, `--plan`, or `ctrl+alt+p`. Truly read-only — no delegate-to-write escape; saved plans in `~/.pi/agent/plans/`; branch-correct across forks. |
| `/ultraplan` | Heavy-planning workflow: backgrounds a planning agent (terminal stays free) → **approval gate** (Approve & Execute / Approve / View / Reject) → on execute, a build agent implements the plan in an **isolated git worktree**, self-repairing against `.pi/test-command`, ending in a PR or a patch. Your working tree is untouched until you adopt the result. Always runs on your **session model**. Distinct from `/plan` (in-session, read-only). |
| Hooks | Bash regex + path glob guard rails (`block`/`confirm`, headless fail-safe) that also catch **bash-mediated writes** and normalize quote/`$HOME` evasion. Post-edit hook runs `<project>/.pi/test-command` and steers failures back to self-fix. Active inside subagents. |
| Checkpoints | `/checkpoints` and `/rollback` — non-destructive git snapshots after edits, so a broken change can return to the last good state. |
| `todo` tool | Multi-step checklist, widget, state survives restart/fork. |
| Smart compaction | Structured handoff summaries on a cheap tier, keeping the recent tail; triggers **proactively** at a context threshold; falls back to pi's default on error. Provider overflow errors normalized so compaction engages. |
| Status line | `model · ctx% · $cost · ⚡agents` (one owner of the vitals). |
| `fetch` tool | URL → readable text, **SSRF-protected** (blocks private/loopback hosts), streamed to a byte cap. |
| **`artifact` tool** | Produce a polished, self-contained, theme-aware HTML document (report/roadmap/dashboard) and open it in the browser. Backed by the `artifact` design skill. |
| Input shortcuts | `??` ask-mode (answer read-only this turn), `>>` verbatim. |
| Skills | `deep-review`, `handoff`, `ship`, `artifact`. |
| Prompts | `/commit`, `/review`, `/plan-task`, `/standup`. |
| `/grimoire` | Scrollable on-demand catalog of skills/prompts/extensions/themes (pairs with `quietStartup`). |
| `/grimoire` | Browse installed skills, prompts, extensions, and themes in a book overlay. Pairs with pi's `quietStartup: true` setting (enabled) so startup is clean instead of listing everything. Works in plain pi and ftales. |

## Configuration

Defaults ship in [`fairy-tales.config.json`](fairy-tales.config.json). Override globally in `~/.pi/agent/fairy-tales.json` or per project in `<project>/.pi/fairy-tales.json` (deep-merged, project wins). Key sections:

- `tiers` — model per tier (`provider/model-id` + thinkingLevel). **Out of the box, subagents follow your session model** (`modelMode: "single"`, `singleModel: "session"`) so a fresh install just works with no warnings. To get cheap-fast scouts and deep-thinking brains, switch to tiered — run `/agent-model` inside pi, or set real models in `~/.pi/agent/fairy-tales.json` and set `"modelMode": "tiered"`.
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
