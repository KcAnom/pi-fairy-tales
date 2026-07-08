# Troubleshooting

Known failure modes and their fixes, in the order you're likely to meet them.

## Install & launch

**`pi: command not found` after installing**
The npm global bin dir isn't on PATH. `npm bin -g` shows where it is; add it to PATH. nvm users: `nvm use` a version first.

**`ftales: command not found`**
The launcher is a plain file at `~/bin/ftales`. Recreate:
```bash
mkdir -p ~/bin && printf '#!/bin/sh\nexport FTALES=1\nexec pi "$@"\n' > ~/bin/ftales && chmod +x ~/bin/ftales
```
Ensure `~/bin` is on PATH. (This location deliberately survives Node upgrades.)

**`pi` works but the package didn't load (no `agent` tool, no branding)**
`grep packages ~/.pi/agent/settings.json` — the source must be listed. Reinstall: `pi install git:github.com/KcAnom/pi-fairy-tales`. If an extension has a syntax error pi prints the file/line at startup and suggests `pi -ne`.

## Models & subagents

**Subagent result starts with `⚠ Tier "…" model unavailable`**
The tier references a model you don't have. Fix the tier in `~/.pi/agent/fairy-tales.json` (see [CONFIGURATION.md](CONFIGURATION.md)) or run `/agent-model` → "Single — follow my session model". The run still completed on your session model.

**Subagent result says `Provider error … 402 / Insufficient Balance` (or 401/403)**
The tier's provider account is out of credit or the key is invalid. Top up, or repoint that tier at another model. `pi --list-models` shows what's available; `/login` refreshes credentials.

**`Too many concurrent agents (max N)`**
Working as intended. Wait for a run, abort one via `agent_control`/`/agents`, or raise `agents.maxConcurrent`.

**Run ends with `Run stopped early: turn cap (N) reached`**
The stuck-loop brake fired. If the task legitimately needed more turns, raise `agents.maxTurnsPerRun`; the money brake is `maxCostPerRunUsd` and fires independently.

**Background agent's result never arrived**
Background runs do not survive `/reload`, `/new`, or switching sessions (pi limitation) — they are aborted on session shutdown. Re-run in the new session, or use foreground for must-not-lose work.

## Hooks

**A command/file I need is blocked**
The block message names the rule. Edit `hooks.bash` / `hooks.paths` in your override file, then `/reload`. Headless runs (`pi -p`, CI) intentionally hard-block anything that would ask for confirmation.

**Post-edit tests didn't run**
Requires `<project>/.pi/test-command` to exist and be non-empty, and `hooks.postEdit.enabled` true. One test batch runs at a time; edits during a running batch are picked up on the next turn.

## Branding & TUI

**Plain `pi` opened with the Fairy Tales theme**
Should self-heal: the next plain `pi` start restores your previous theme (recorded in `~/.pi/agent/fairy-tales.json` under `ui.previousTheme`). Manual fix: `/settings` → theme, or edit `"theme"` in `~/.pi/agent/settings.json`.

**Masthead looks wrong / hollow boxes**
Your terminal font is missing a glyph. The masthead needs `█ ☾ ✦ ❦`; most Nerd Fonts and system monospace fonts have them. The banner auto-falls back to a compact form under ~65 columns.

**No colors / washed-out gradient**
The gradient uses 24-bit ANSI color. Use a truecolor terminal (iTerm2, Terminal.app ≥ macOS 11, kitty, WezTerm, Windows Terminal) and `TERM` not set to a 16-color profile.

**Startup shows big resource lists**
Set `"quietStartup": true` in `~/.pi/agent/settings.json`; browse resources with `/grimoire` instead.

**Overlay leaves stray glyphs after closing** (custom extensions)
pi repaints only rows its content reaches. If you write your own overlay, force a repaint on close — see `closeOverlay()` in `src/banner.ts`.

## Memory & sessions

**Memory not injected**
`memory.injectIndex` must be true and `MEMORY.md` must exist (created on first `remember`). Injection is once per session; `/reload` re-arms it.

**Todos vanished after `/fork`**
They're rebuilt from the session branch — a fork before the todo write won't have them. This is branch-correctness, not data loss; the other branch still has its state.

## Still stuck?

Run with a fresh session and no package to isolate: `pi -ne` (no extensions). If the problem disappears, it's this package — open an issue at github.com/KcAnom/pi-fairy-tales with the startup error text and your `pi --version`.
