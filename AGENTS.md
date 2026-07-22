# Agent instructions — pi-fairy-tales

You are working in the pi-fairy-tales codebase: a pi package providing subagent orchestration, memory, plan mode, hooks, todos, smart compaction, a status line, and the `ftales` branded TUI.

## If your task is "set this up on this machine"

Follow [docs/SETUP.md](docs/SETUP.md) top to bottom — every step is idempotent and has a verification command with expected output. Do not skip verifications. Machine-personal state (API keys, model tiers, settings) belongs in `~/.pi/agent/`, never in this repo.

## Architecture (read before editing)

- `extensions/*.ts` — one pi extension per file, each default-exports `function (pi: ExtensionAPI)`. Loaded via jiti (TypeScript runs directly, no build step). `fairy-tales-agents.ts` + `src/subagent/` is the core.
- `src/` — shared library code, imported by extensions via relative paths **with `.ts` extensions**.
- Cross-extension state flows ONLY over `pi.events` with names/types in `src/bus.ts` — module-level sharing across extension files is not guaranteed.
- Config: `fairy-tales.config.json` (shipped defaults) deep-merged with `~/.pi/agent/fairy-tales.json` then `<project>/.pi/fairy-tales.json`. Loader in `src/config.ts`.
- Subagents (`src/subagent/engine.ts`): in-process `createAgentSession` with an EMPTY agentDir + in-memory settings, so installed packages (including this one) never load inside subagents — recursion is structurally impossible. Hooks + fetch are re-injected via `extensionFactories`. Role tool allowlists must never include `agent`/`agent_control`.

## Hard-won conventions (violating these reintroduces fixed bugs)

- `StringEnum` from `@earendil-works/pi-ai` for all enum tool params (Google API compat) — never `Type.Union` of literals.
- Throw from tool `execute` to signal errors; returning a value never sets `isError`.
- Wrap ALL file mutations in `withFileMutationQueue(absolutePath, fn)` — tools run in parallel by default.
- Guard every `ctx.ui.*` call with `ctx.hasUI`; confirm-gated logic must fail-safe to block when headless.
- `renderResult`/`renderCall` must return a pi-tui `Component` (e.g. `new Text(str, 0, 0)`), not strings.
- Overlays must close via `closeOverlay()` (`src/banner.ts`) — plain `done()` leaves stale glyphs below pi's content rows.
- `ctx.ui.setTheme()` PERSISTS to settings.json. The brand extension records `ui.previousTheme` before switching and plain pi restores it — preserve this handoff if you touch theming.
- Never cache `ctx` beyond a handler except the documented widget-refresh pattern (refreshed each `session_start`, calls wrapped in try/catch).
- Truncate all large outputs: `clipTail` for results/logs (end matters), `clipHead` for fetched content (start matters).
- Branding activates only when `process.env.FTALES === "1"`; plain pi must remain visually stock.

## Testing changes

Unit tests live in `src/__tests__/` (`npm test` runs vitest). They cover the library layer (`src/`); extension behavior is verified behaviorally, against the real pi:

- Headless: `pi -e /path/to/this/repo -p "prompt exercising the feature"` from a scratch directory.
- Full TUI: run in a pty and reconstruct the screen (`script -q log ftales`, then parse with a terminal emulator like pyte) — grep-ing raw logs is unreliable because of cursor-positioned writes.
- RPC (for compaction/commands): pipe JSONL into `pi --mode rpc --no-session`.
- After editing an installed local copy, `/reload` inside pi picks it up.

## Reference

pi extension/SDK docs: https://github.com/earendil-works/pi (docs/extensions.md, docs/sdk.md). Key facts this package relies on: `before_agent_start` may return `{message, systemPrompt}`; `tool_call` may return `{block, reason}` or mutate `event.input`; `tool_result` returns partial patches; `session_before_compact` may return a custom `{compaction}`; session-replacement methods exist only on command contexts (deadlock from event handlers).
