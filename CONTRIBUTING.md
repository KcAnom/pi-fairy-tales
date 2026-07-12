# Contributing to pi-fairy-tales

Thanks for your interest! This is an open-source pi package and contributions — bug reports, ideas, docs, and PRs — are all welcome.

## Dev loop (no build step)

pi-fairy-tales is TypeScript loaded directly by pi via [jiti](https://github.com/unjs/jiti) — there is **no compile step**. The loop is:

```bash
git clone https://github.com/KcAnom/pi-fairy-tales
pi install /path/to/pi-fairy-tales   # local packages load in place
```

Then, inside pi:

1. Edit any extension in `extensions/` or module in `src/`.
2. Run `/reload` — pi hot-reloads the package.
3. Try your change.

Remove the package with `pi remove <source>` when you're done.

## Project layout

- `extensions/` — one file per feature, each default-exporting `function(pi: ExtensionAPI)`. This is where commands, tools, and events are wired up.
- `src/` — shared logic the extensions import (subagent engine, hooks/rules, net/SSRF, overlays, config, the event bus).
- `skills/`, `prompts/`, `themes/` — pi resources shipped by the package.
- `fairy-tales.config.json` — shipped defaults. User overrides live in `~/.pi/agent/fairy-tales.json`; project overrides in `<project>/.pi/fairy-tales.json` (deep-merged, project wins).
- `docs/` — Setup, Configuration, Troubleshooting.
- `AGENTS.md` — conventions for coding agents working on this repo.

## Conventions

- **Nothing personal ships.** No API keys, no `.env`, no machine-specific paths, no generated artifacts. Secrets live only in the user's `~/.pi/agent/`.
- **Cross-extension state flows only over `pi.events`** (`src/bus.ts`) — extensions don't reach into each other.
- **All file writes go through `withFileMutationQueue`** so parallel tool calls stay safe.
- **Every UI call is behind `ctx.hasUI`** — features must work headless (`-p` / JSON / RPC), and confirm-gated rules must fail safe to *block*.
- **Subagents stay isolated** — they run with an empty agentDir + in-memory settings so packages never load inside them; re-inject anything they need explicitly.
- Commit messages: imperative subject, body explains *why*.

## Before opening a PR

- Verify your change end-to-end — many features can be exercised headless with `pi -p "…"` or `pi -e`.
- If you touched a guard rail, hook, or the subagent engine, confirm the safety fallbacks still hold (blocked commands still block; headless still fails closed).
- Update `CHANGELOG.md` and the relevant `docs/` page.
- Keep the change minimal and focused — one concern per PR.

## Reporting issues

Open a GitHub issue with what you ran, what you expected, and what happened. Include your pi version (`pi --version`) and OS. For anything model-related, note your `modelMode` and which provider you're on.
