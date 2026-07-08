# Changelog

## 0.2.0 — 2026-07-08

A 39-item enhancement pass across security, agentic depth, TUI, ops, and a new capability.

**Security & correctness**
- Bash-mediated writes (`echo > .env`, `cp … .git/`, `tee`, `dd of=`) now run through path rules; commands are normalized against quote/`$HOME` evasion.
- `fetch` gained SSRF protection — every redirect hop's host is resolved and private/loopback/link-local IPs (incl. cloud metadata) and localhost are rejected — and streams the body to enforce `maxBytes` instead of buffering it all.
- Plan mode is no longer escapable (dropped `agent`/`remember` from the read-only keep-set) and rebuilds state from the current branch so forks don't resurrect it.
- Config-array overrides that drop shipped safety guards now warn; `hooks.bashAppend`/`pathsAppend` add rules without replacing defaults.

**Agentic**
- Subagents return a structured JSON envelope; can be continued with a follow-up (`agent_control continue`); overflow spawns queue instead of failing; transient provider errors retry with backoff; cost is estimated from tokens when providers report $0; roles are config-driven; transcripts persist for debugging.
- Memory is now a store — dedupe, `forget`, relevance-ranked injection, `#topic` autocomplete — and a `context` handler de-dups repeated injections.
- Compaction runs on a cheap tier, keeps the recent tail, and can trigger proactively at a context threshold.
- New checkpoint/rollback harness (`/checkpoints`, `/rollback`) via non-destructive git snapshots; `??` ask-mode and `>>` verbatim input shortcuts.

**TUI**
- `/tale` and `/grimoire` overlays scroll; masthead gradient adapts to the light dawn theme; footer render race fixed; one owner for the vitals; `/tale` cached and cost-attributed; agent results and hook failures render as cards.

**Ops**
- Provider context-overflow errors normalized so auto-compaction engages; session-switch guards warn on a dirty repo or unsaved plan; cent-precise cost; env-gated debug channel (`FAIRY_TALES_DEBUG=1`); config cached by mtime.

**New capability**
- The `artifact` tool + skill: produce polished, self-contained, theme-aware HTML documents and open them in the browser.

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
