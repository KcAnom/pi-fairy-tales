<div align="center">

# ✦ pi-fairy-tales ✦

**A production-grade agent harness for the [pi coding agent](https://github.com/earendil-works/pi-mono) — wrapped in a fairy tale.**

Subagent orchestration · isolated-worktree planning · guard-rail hooks · persistent memory · smart compaction — as one installable pi package.

[![License: MIT](https://img.shields.io/badge/License-MIT-gold.svg)](LICENSE)
[![Built for pi](https://img.shields.io/badge/built%20for-pi%20coding%20agent-8a5cf6.svg)](https://github.com/earendil-works/pi-mono)
[![Version](https://img.shields.io/badge/version-0.3.0-blue.svg)](CHANGELOG.md)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

---

`pi-fairy-tales` turns the minimal [pi](https://github.com/earendil-works/pi-mono) terminal agent into a full workbench: it can **fan work out to role-specialized subagents**, **plan a change in the background and execute it in an isolated git worktree without touching your working tree**, **guard every risky command and file write**, and **remember what matters across sessions** — all behind safety rails that fail closed. Run it plain, or launch `ftales` for the same engine with the whole fairy-tale experience turned on.

> Built as an exploration of what a *thoughtfully-engineered* agent harness looks like — where the interesting parts are the safety model and the isolation guarantees, not the prompts.

<div align="center">

![Fairy Tales — once upon a terminal](https://raw.githubusercontent.com/KcAnom/pi-fairy-tales/main/assets/masthead.webp)

<em>▶ Demo recording coming soon — <code>ftales</code> planning a change and shipping it as a PR from an isolated worktree.</em>

</div>

## Why it's interesting

The hard parts aren't the features — they're the guarantees underneath them:

- **Subagent recursion is structurally impossible.** Subagents run in-process via pi's SDK with an *empty agentDir + in-memory settings*, so no installed package (including pi-fairy-tales itself) can load inside a subagent. Guard rails and `fetch` are re-injected explicitly rather than inherited. Recursion can't happen because there's nothing there to recurse into.
- **`/ultraplan` never touches your working tree until you adopt the result.** It backgrounds a planning agent (your terminal stays free), gates the plan on your approval, then a build agent implements it inside a throwaway **git worktree on its own branch** — self-repairing against your `.pi/test-command` — and lands the result as a **PR** (remote + `gh`) or a **patch**. Your files are never mutated in place; the worktree and branch are cleaned up either way.
- **Guard rails fail *closed*, even headless.** Bash rules catch not just direct commands but **bash-mediated writes** (`echo > .env`, `tee`, `dd of=`) and normalize quote / `$HOME` evasion. A `confirm` rule with no UI to confirm on (`-p`, JSON, RPC) blocks rather than silently allowing.
- **`fetch` is SSRF-hardened.** Every redirect hop is re-resolved and private / loopback / link-local / cloud-metadata hosts are rejected; the body is streamed to a byte cap instead of buffered.
- **Everything degrades gracefully.** Every UI call is behind `ctx.hasUI`, so the full harness works in headless, JSON, and RPC modes. Compaction triggers proactively before overflow and falls back to pi's default on error.

## Quick start

```bash
npm i -g @earendil-works/pi-coding-agent         # 1. pi itself
pi install git:github.com/KcAnom/pi-fairy-tales   # 2. this package
```

Then create the `ftales` launcher for the branded experience (or clone the repo and run `./install.sh`, which does both steps):

```bash
mkdir -p ~/bin && printf '#!/bin/sh\nexport FTALES=1\nexec pi "$@"\n' > ~/bin/ftales && chmod +x ~/bin/ftales
```

For local development: clone anywhere and `pi install /path/to/pi-fairy-tales` — local packages load in place, so edit + `/reload` inside pi picks up changes. Remove with `pi remove <source>`.

**Docs:** [Setup Guide](docs/SETUP.md) · [Configuration Reference](docs/CONFIGURATION.md) · [Troubleshooting](docs/TROUBLESHOOTING.md) · [Changelog](CHANGELOG.md) · [AGENTS.md](AGENTS.md)

## Bring your own models

Nothing personal ships in this package — API keys live only in your own `~/.pi/agent/auth.json` (log in with `/login` inside pi). **Out of the box, subagents follow your current session model**, so a fresh install just works with no configuration and no fallback warnings.

Want cheap-fast scouts and deep-thinking brains instead? Switch to tiered models — run `/agent-model` inside pi, or point the tiers at whatever you use in `~/.pi/agent/fairy-tales.json`:

```json
{
  "modelMode": "tiered",
  "tiers": {
    "scout":  { "model": "your-provider/cheap-model", "thinkingLevel": "low" },
    "worker": { "model": "your-provider/main-model",  "thinkingLevel": "medium" },
    "brain":  { "model": "your-provider/best-model",  "thinkingLevel": "high" }
  }
}
```

If a tier model is ever unavailable, subagents fall back to your session model with a visible warning — nothing breaks.

## What you get

| Piece | What it does |
|---|---|
| `agent` tool | Delegate to role-specialized subagents: **explore**, **plan**, **build**, **review**, **general** (config-driven — add your own). Multiple calls in one message run in parallel; overflow **queues** instead of failing. Each returns a structured result envelope; `background: true` runs detached. Turn / cost / concurrency caps enforced, with token-based cost estimation on subscription models and transient-error retry. |
| `agent_control` + `/agents` | `list` / `result` / `abort`, plus `continue` (send a follow-up to a just-finished agent, reusing its context) and `transcript` (path to a run's full log). Live widget while agents run. |
| `/agent-model` | Switch subagent model strategy: **tiered** (per-role) or **single** (session or a specific model). Persists to `~/.pi/agent/fairy-tales.json`. |
| Memory | Relevance-ranked `MEMORY.md` injected each session; `remember` (deduped) and `forget` tools; `#topic` autocomplete; `/memory` editor. |
| Plan mode | `/plan`, `--plan`, or `ctrl+alt+p`. Truly read-only — no delegate-to-write escape; saved plans in `~/.pi/agent/plans/`; branch-correct across forks. |
| **`/ultraplan`** | Heavy-planning workflow: backgrounds a planning agent → **approval gate** (Approve & Execute / Approve / View / Reject) → a build agent implements the plan in an **isolated git worktree**, self-repairing against `.pi/test-command`, ending in a PR or a patch. Working tree untouched until you adopt it. Always runs on your **session model**. Distinct from `/plan`. |
| Hooks | Bash regex + path glob guard rails (`block` / `confirm`, headless fail-safe) that also catch **bash-mediated writes** and normalize quote / `$HOME` evasion. Post-edit hook runs `<project>/.pi/test-command` and steers failures back to self-fix. Active inside subagents. |
| Checkpoints | `/checkpoints` and `/rollback` — non-destructive git snapshots after edits, so a broken change can return to the last good state. |
| `todo` tool | Multi-step checklist, widget, state survives restart / fork. |
| Smart compaction | Structured handoff summaries on a cheap tier, keeping the recent tail; triggers **proactively** at a context threshold; falls back to pi's default on error. Provider overflow errors normalized so compaction engages. Every compaction is **announced** (tokens condensed, summarizer cost) instead of happening silently. |
| Status line | `model · ctx% · $cost · ⚡agents` (one owner of the vitals). |
| `/ledger` | Where the session's tokens and cost went: main conversation vs. each subagent vs. compaction summaries vs. `/tale`, with token counts, cache stats, and cost-share bars in a book overlay. Subagent totals survive restarts. |
| `/doctor` | Health-check the install: do tier models resolve (and what work falls back to), config problems, memory writable, post-edit tests wired, guard rails active, git/`gh` present for `/ultraplan`'s PR path, spend caps, and terminal ergonomics (copy-on-select support, clipboard tooling for `/grab`). Every failing line comes with its fix. |
| `fetch` tool | URL → readable text, **SSRF-protected** (blocks private / loopback hosts), streamed to a byte cap. |
| `artifact` tool | Produce a polished, self-contained, theme-aware HTML document (report / roadmap / dashboard) and open it in the browser. Backed by the `artifact` design skill. |
| Input shortcuts | `??` ask-mode (answer read-only this turn), `>>` verbatim. |
| `/grab` | Picker over recent code blocks, responses, and tool outputs → clipboard as clean logical text (no terminal wrapping, no UI decoration). Complements pi's built-in `/copy` (last message). Uses `pbcopy`/`wl-copy`/`xclip`/`clip`, falling back to OSC 52 (works over SSH). |
| Clipboard toasts | A toast whenever the system clipboard changes while the TUI runs — so terminal drag-copy (silent by design) gets visible confirmation. Counts only, never content. Disable: `ui.clipboardNotify: false`. |
| `ftales.app` (macOS) | Created by `install.sh` in `~/Applications`: Spotlight → "ftales" launches Fairy Tales directly in a terminal window (iTerm2 if present, else Terminal.app) — no shell session wasted getting there. |
| Skills | `deep-review`, `handoff`, `ship`, `artifact`. |
| Prompts | `/commit`, `/review`, `/plan-task`, `/standup`. |
| `/grimoire` | Scrollable on-demand catalog of installed skills / prompts / extensions / themes in a book overlay. Pairs with pi's `quietStartup` so startup is clean. Works in plain pi and `ftales`. |

## Configuration

Defaults ship in [`fairy-tales.config.json`](fairy-tales.config.json). Override globally in `~/.pi/agent/fairy-tales.json` or per project in `<project>/.pi/fairy-tales.json` (deep-merged, project wins). Key sections:

- `tiers` — model per tier (`provider/model-id` + thinkingLevel). Out of the box subagents follow your session model; switch to tiered via `/agent-model` or by setting real models here plus `"modelMode": "tiered"`.
- `agents` — `maxConcurrent`, `maxTurnsPerRun`, `maxCostPerRunUsd`, `modelMode` (`"tiered"` | `"single"`), `singleModel` (`"session"` or a `provider/model-id`), and role definitions (tier, tool allowlist, description, `promptAppend`).
- `ultraplan` — `planners` (>1 adds a synthesis pass), `worktree`, `autoExecute`, `planRole`, `buildRole`.
- `hooks.bash` / `hooks.paths` — guard-rail rules (regex / glob, `block` or `confirm`); `bashAppend` / `pathsAppend` add without replacing the shipped defaults.
- `hooks.postEdit` — post-edit test runner (reads `<project>/.pi/test-command`).
- `memory.dir`, `plans.dir`, `web.*`.

## Under the hood

- Subagents run in-process via `createAgentSession` with an **empty agentDir + in-memory settings** — installed packages never load inside subagents, so recursion is structurally impossible. Guard-rail hooks and `fetch` are re-injected explicitly.
- Cross-extension state flows only over `pi.events` (`src/bus.ts`) — extensions never reach into each other.
- All file writes go through `withFileMutationQueue` (safe under parallel tool calls).
- Every UI call is behind `ctx.hasUI`; confirm-gated rules fail safe to block. The harness is identical in interactive, `-p`, JSON, and RPC modes.
- Background runs do not survive `/reload` or session switches (a documented pi limitation); they are aborted on `session_shutdown`.

## `ftales` — the branded launcher

`ftales` (a tiny wrapper at `~/bin/ftales`, outside Node's version folders so it survives Node upgrades) launches the **same engine** with the Fairy Tales experience turned on:

- the `fairy-tales` theme (twilight purple / fairy-dust gold, ships in `themes/`)
- a "✧ F A I R Y  T A L E S ✧ — once upon a terminal" startup header and terminal title `✦ Fairy Tales — <project>`
- **day/night enchantment**: parchment `fairy-tales-dawn` theme 07:00–18:59, twilight `fairy-tales` at night
- **the Enchanted Footer**: `✦ model · ⚘ realm (git branch) · ✒ ink N% (context left) · 🜚 gold (session cost) · ✧ sprites at work`
- **the Fae Council**: subagents appear as 🕯 Will-o'-Wisp (explore), ✶ the Sage (plan), ⚒ the Smith (build), 🪶 the Raven (review), 🜍 the Wanderer (general); finishing every todo triggers "✦ Quest complete ✦"
- **`/tale`**: the session retold as a storybook chapter in a book overlay
- a drifting-sparkle working indicator, and sessions auto-named like chapters ("The Tale of …")

Plain `pi` stays completely unbranded — the brand extension records your previous theme when `ftales` starts, and the next plain `pi` session switches back automatically. Every harness feature (subagents, memory, hooks…) is identical in both.

The launcher is just `FTALES=1 exec pi "$@"`. Recreate it if ever needed:
```bash
printf '#!/bin/sh\nexport FTALES=1\nexec pi "$@"\n' > ~/bin/ftales && chmod +x ~/bin/ftales
```

## Contributing

Contributions are welcome. The dev loop is intentionally frictionless — `pi install /path/to/pi-fairy-tales`, edit a `.ts` extension, and `/reload` inside pi picks it up (no build step). See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for repo conventions.

## License

[MIT](LICENSE) © KcAnom. Built on and for the [pi coding agent](https://github.com/earendil-works/pi-mono).
