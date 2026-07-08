# Changelog

## 0.1.0 — 2026-07-08

Initial public release.

- **Subagent orchestration** — `agent` / `agent_control` tools with five roles (explore, plan, build, review, general), tiered or single-model strategy (`/agent-model`), parallel fan-out, background runs with steered result delivery, turn/cost/concurrency caps, live widget, `/agents` manager. Recursion structurally prevented via isolated resource loading.
- **Persistent memory** — injected `MEMORY.md` index, `remember` tool with topic files, `/memory` editor.
- **Plan mode** — `/plan`, `--plan`, tool stripping with hook-layer enforcement, `exit_plan` approval flow, saved plans, restart survival.
- **Hook engine** — config-driven bash regex + path glob guard rails (block/confirm, headless fail-safe), post-edit test runner with self-fix steering; active inside subagents.
- **Todo tracking** — TodoWrite-style `todo` tool, branch-correct state, editor widget.
- **Smart compaction** — structured handoff summaries with default-compaction fallback.
- **Status line** — model, context %, session cost, running agents.
- **Web fetch** — `fetch` tool with HTML→text and truncation.
- **Skills & prompts** — deep-review, handoff, ship; `/commit`, `/review`, `/plan-task`, `/standup`.
- **`/grimoire`** — on-demand resource catalog (pairs with `quietStartup`).
- **`ftales` experience** — Gilded Dusk gradient masthead, twilight + dawn themes with day/night switching and plain-pi theme handback, enchanted footer, Fae Council subagent identities, quest-complete celebration, `/tale` storybook recap, sparkle title screen, chapter-style session names.
