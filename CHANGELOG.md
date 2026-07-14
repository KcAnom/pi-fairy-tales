# Changelog

## 0.13.0 — 2026-07-14

Clarity + interchangeability: always know what you're running, swap it in one move.

**New capability**
- **`/loadout`** — named model lineups. `save <name>` snapshots the entire arrangement (mode, tiers, role assignments, session model); `use <name>` (or bare `/loadout` for a picker) swaps the whole lineup in one command, realigning the session model; `delete <name>` removes one. Each shows a one-line summary ("🎼 sol ▸ mini·luna · orchestrated").
- **Lineup in the footer** — in orchestrated mode the footer/status line shows the arrangement instead of just one model name: `🎼 sol ▸ mini·luna` (conductor ▸ crew). Changes the moment a loadout switches.
- **Tier tags on runs** — the live agents widget and result cards now show `[tier·model]` (e.g. `[scout·mini]`, `[conductor·sol]`), so the division of labor — and any ⤴ escalation jumping tiers — is readable at a glance.

## 0.12.0 — 2026-07-14

**New capability**
- **Orchestrated model mode** — the flipped pyramid: a strong "conductor" model leads while a cheap crew executes. `agents.modelMode: "orchestrated"` adds a `conductor` tier that (1) the session model is auto-aligned to at startup (via pi's setModel; falls back to a /model hint), (2) the judgment roles (plan/review) run on, and (3) **failed runs escalate to**: any subagent run that ends in a provider error or reports `status: failed/blocked` in its structured envelope is retried once on the conductor with the failed attempt's report attached (run name gets a ⤴ suffix). `/agent-model` gained an "Orchestrated" wizard option (one pick: your strongest model); `/agent-models` shows the mode, the conductor, and the escalation rule. Config validation requires a conductor tier in this mode.

## 0.11.0 — 2026-07-14

**New capability**
- **`/agent-models`** — a read-only roster overlay of the current subagent setup: mode, each tier's model with live availability (✓/✗), every role's **effective** model (mirroring the engine's exact resolution, including scout's cheapest-model fallback), the compaction tier, ultraplan's session-model rule, and the spend caps. `/agent-model` (singular) remains the setter.

**Fixed**
- **Scrolling is back.** The mouse wheel now scrolls book overlays directly (`/tale`, `/grimoire`, `/ledger`, `/doctor` — wheel events are translated to their `j`/`k` keys), and in the main view a wheel tick **releases mouse tracking back to the terminal**, so native scrollback scrolling — and native selection while you're up there — works; any keypress re-arms mouse select. A one-time hint explains the handoff.

## 0.10.0 — 2026-07-14

**New capability**
- **Mouse in the editor: click places the cursor, drag selects, ⌫ deletes** — clicking inside the input box moves the cursor to the clicked spot (wrap- and scroll-aware, anchored on the renderer's cursor tracking); dragging inside it selects text (live highlight), copies on release, and keeps the selection alive so Backspace/Delete removes it in one stroke. Any other key clears the selection and behaves normally.
- **Copy-on-select inside the TUI** — drag-select with the mouse; on release the selection is extracted from the renderer's frame and copied to the clipboard, with a toast. Implemented the way Claude Code's fullscreen mode does it: SGR mouse tracking (1002/1006) enabled while the session runs, events intercepted before the editor, selection sliced from the last rendered frame (ANSI-stripped), modes restored on shutdown and process exit. Wheel and non-left-button events are consumed so they never leak into the editor. Requires the terminal to deliver mouse reporting (Terminal.app: View → Allow Mouse Reporting). Selections are highlighted in reverse video while dragging; wide glyphs may offset a slice. Disable with `ui.copyOnSelect: false`.
- **Clipboard toasts** — terminal copy-on-select is silent by design (the terminal never tells the app), so fairy-tales now watches the system clipboard and toasts "⧉ Copied to clipboard (N lines · M chars)" when it changes. Privacy: counts only, never content; nothing stored or sent. `/grab`'s own copies don't double-toast. Disable with `ui.clipboardNotify: false`. Verified live in a running session.
- **`ftales.app` (macOS)** — `install.sh` creates `~/Applications/ftales.app`: Spotlight → "ftales" → Enter launches Fairy Tales directly in a terminal window (iTerm2 if present, else Terminal.app). The `.command` handoff it uses rebinds stdout to the tty (some terminals pipe it, which kills a TUI) and self-deletes via a delayed background job (the file is read incrementally).

**Changed**
- **Removed 0.9.0's iTerm2 handoff from the `ftales` launcher, reverting to the simple launcher.** It was built on a wrong assumption: recent macOS Terminal.app *does* auto-copy mouse selections (verified empirically), so rerouting sessions to iTerm2 was unnecessary window churn. `/doctor`'s terminal check now informs instead of asserting, and `install.sh` no longer offers to install iTerm2.

## 0.9.0 — 2026-07-14

**Changed**
- **`ftales` hands itself to iTerm2.** When launched from macOS Terminal.app (which cannot copy-on-select) with iTerm2 installed, the launcher reopens the session in a new iTerm2 window — via a self-deleting `.command` handoff file that needs **no automation permissions** — so drag-select → release → clipboard just works. Preserves the working directory. Opt out per launch or permanently with `FTALES_NO_ITERM=1`; skipped automatically when arguments are passed or output isn't a terminal.

## 0.8.0 — 2026-07-14

**Changed**
- **`/doctor` now checks terminal ergonomics.** Copy-on-select (drag text → release → it's on the clipboard) is a terminal-emulator feature, not an app feature — so the doctor detects the host: warns on macOS Terminal.app (which can't do it) with the iTerm2 one-liner, verifies iTerm2's `CopySelection` setting, notes the `terminal.integrated.copyOnSelection` setting under VS Code, and on Linux checks that a clipboard tool (`wl-copy`/`xclip`/`xsel`) exists for `/grab`.
- **`install.sh` offers iTerm2 on macOS** — strictly opt-in (interactive prompt, only under Terminal.app, only when Homebrew is present and iTerm2 isn't), enabling copy-on-select on install. Never runs in non-interactive/piped installs.

## 0.7.1 — 2026-07-14

**Fixed**
- **`/copy` renamed to `/grab`** — pi ships a built-in `/copy` (last message → clipboard) and the extension command conflicted with it. `/grab` now opens the picker directly (code blocks first, then responses and tool outputs); use pi's `/copy` for the whole last message.

## 0.7.0 — 2026-07-14

**New capability**
- **`/copy`** — the last assistant response straight to the clipboard as clean logical text: no terminal line-wrapping, no UI decoration, exactly what the model produced. **`/copy pick`** opens a picker over recent copyable items — each code block (listed first, with language and line count), each response, each tool output. Clipboard via `pbcopy` / `wl-copy` / `xclip` / `xsel` / `clip`, falling back to the OSC 52 escape so it works over SSH too.

## 0.6.0 — 2026-07-14

No more silence during things that matter.

**New capability**
- **`/doctor`** — a health-check overlay for the whole install: tier model resolution (with what each broken tier falls back to), config diagnostics, memory writability, post-edit test wiring, guard-rail counts, git/`gh` prerequisites for `/ultraplan`'s PR path, and spend caps at a glance. Every failing line names its fix.

**Changed**
- **Compaction announces itself.** Each compaction shows a one-line notice — trigger (manual/proactive/overflow), tokens condensed, approximate summary size, and summarizer cost — instead of happening invisibly.
- **Subagent retries are visible.** During transient-error backoff the live widget shows `⟳ provider hiccup — retry 1/2 in 1s` instead of appearing hung.

## 0.5.0 — 2026-07-14

**New capability**
- **`/ledger`** — where the session's tokens and cost actually went, in a book overlay: main conversation vs. each subagent (per run, with model/turns/tokens) vs. compaction summaries vs. `/tale`, with cost-share bars, totals, and cache-read stats. Main and subagent totals rebuild from the session branch, so they survive restarts. Works in plain pi and `ftales`.

**Fixed**
- **Compaction spend is no longer invisible.** The compaction summarizer now reports its cost (and token counts) through the cost bus, so the footer's gold counter, the status line, and `/ledger` all include it. `/tale` and subagent cost events now carry a source tag so the ledger can attribute spend by category.

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
