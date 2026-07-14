# Changelog

## 0.4.0 — 2026-07-14

Token-economy release: the cost of running fairy-tales is now visible, configurable from the TUI, and frugal by default.

**Changed**
- **No more silent expensive fallback.** When a tier a session would actually use (subagent roles in tiered mode, the compaction tier) doesn't resolve to an available model, a session-start warning names the broken tier and points to `/agent-model`. Previously that work silently ran on the lead session's model — the #1 hidden token cost.
- **`/agent-model` is now a tier wizard.** "Tiered" walks scout/worker/brain (and custom tiers), listing *your* available models with their per-Mtok prices (or "free/local"), plus a "Keep current" option when the tier already resolves. Esc anywhere cancels without saving. Picks persist to `~/.pi/agent/fairy-tales.json`.
- **Cheapest-model fallback for scout work.** When the scout tier is unconfigured, scout subagents, compaction summaries, and `/tale` fall back to the cheapest *priced* model available instead of the session model (new `resolveCheapestModel`, input-weighted 3:1). Zero-cost models (local, unknown pricing) are deliberately skipped — silently routing work to a tiny local model is worse than the session-model fallback.
- **Frugal shipped defaults**: `agents.maxTurnsPerRun` 50 → 20, `compaction.proactiveAtPercent` 85 → 90.

## 0.3.0 — 2026-07-09

**New capability**
- **`/ultraplan <task>`** — a heavier sibling of plan mode. Backgrounds a read-only planning agent (the terminal stays free), gates the finished plan on your approval (Approve & Execute / Approve / View / Reject), then implements it in an **isolated git worktree** — self-repairing against `.pi/test-command` — landing the result as a **PR** (when a remote + `gh` exist) or a **patch**. Your working tree is never touched until you adopt it. Always runs on your **session model**, ignoring tier/single config. Built natively on the existing subagent engine (no external planning engine). New `ultraplan` config block (`planners`, `worktree`, `autoExecute`, `planRole`, `buildRole`); `planners > 1` adds a synthesis pass. Verified end-to-end in `ftales` across both the patch and PR paths, with full worktree + branch cleanup. Distinct from `/plan`, which stays in-session and read-only.

**Changed**
- Default subagent model mode is now `single` / `session`: a fresh install runs on your own session model out of the box, with no fallback warnings. Tiered per-role models are an explicit opt-in via `/agent-model`. Shipped tier models are generic placeholders now (the retired deepseek references removed).

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
