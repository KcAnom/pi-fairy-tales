# Configuration Reference

All behavior is driven by one merged configuration. Sources, later wins (deep merge — override only the keys you change):

1. `fairy-tales.config.json` — shipped defaults (in this package; don't edit if installed from git)
2. `~/.pi/agent/fairy-tales.json` — your global overrides
3. `<project>/.pi/fairy-tales.json` — per-project overrides

Config is re-read on `/reload` inside pi.

## `tiers`

Named model tiers referenced by subagent roles.

```json
"tiers": {
  "scout":  { "model": "provider/model-id", "thinkingLevel": "low" },
  "worker": { "model": "provider/model-id", "thinkingLevel": "medium" },
  "brain":  { "model": "provider/model-id", "thinkingLevel": "high" }
}
```

- `model` — `provider/model-id` as shown by `pi --list-models`.
- `thinkingLevel` — `off | minimal | low | medium | high | xhigh` (clamped to model capability).
- Unavailable tier model → subagent falls back to the lead session's model with a visible warning.

## `agents`

```json
"agents": {
  "maxConcurrent": 5,
  "maxTurnsPerRun": 50,
  "maxCostPerRunUsd": 1.5,
  "modelMode": "tiered",
  "singleModel": "session",
  "roles": { ... }
}
```

| Key | Meaning |
|---|---|
| `maxConcurrent` | Ceiling on simultaneously running subagents. A spawn beyond this fails with a clear tool error. |
| `maxTurnsPerRun` | Per-run turn cap — the stuck-loop brake. The run is aborted and the partial result returned with a warning. |
| `maxCostPerRunUsd` | Per-run spend cap (from provider-reported usage). The money brake; fires regardless of turns. Note: subscription-billed models may report $0 — then only the turn cap applies. |
| `modelMode` | `"tiered"` (per-role tier models) or `"single"` (one model for every role). Switch interactively with `/agent-model` — it persists your choice to the global override file. |
| `singleModel` | Used when `modelMode` is `"single"`: `"session"` (follow the lead session's current model) or a `provider/model-id`. Roles keep their tier's thinking level in single mode. |

### `agents.roles`

Each role defines a subagent specialty:

```json
"explore": {
  "tier": "scout",
  "tools": ["read", "grep", "find", "ls", "bash"],
  "description": "Fast read-only codebase scout...",
  "promptAppend": "optional extra system-prompt text"
}
```

- `tier` — which tier's model/thinking the role uses (in tiered mode).
- `tools` — tool allowlist. Never include `agent`/`agent_control` (recursion guard). Include `fetch` to give a role web access. Built-ins: `read, bash, edit, write, grep, find, ls`.
- `description` — shown to the lead model; write it like a job posting.
- `promptAppend` — appended to the role's system prompt.

Shipped roles: `explore` (read-only scout), `plan` (architect, read-only), `build` (implements + verifies), `review` (defect finder, read-only), `general` (full toolbox + fetch). You may add custom roles; the `agent` tool's role enum is fixed to the shipped five, so custom roles are reachable only if you also edit the extension — prefer tuning the shipped roles.

## `memory`

```json
"memory": { "dir": "~/.pi/agent/memory", "injectIndex": true }
```

- `dir` — where `MEMORY.md` (index) and `topics/*.md` live. `~` expands.
- `injectIndex` — inject the index into context once per session (and after compaction). Set `false` to disable.

## `plans`

```json
"plans": { "dir": "~/.pi/agent/plans" }
```

Approved plan-mode plans are saved here as `<date>-<slug>.md`.

## `hooks`

```json
"hooks": {
  "bash":  [ { "pattern": "regex", "action": "block|confirm", "reason": "shown to agent/user" } ],
  "paths": [ { "glob": "**/.env*", "action": "block|confirm", "reason": "..." } ],
  "postEdit": { "testCommandFile": ".pi/test-command", "enabled": true, "timeoutMs": 120000 }
}
```

- `bash` rules — regex (case-insensitive) tested against every bash command the agent runs. `block` refuses; `confirm` asks you interactively — and **fail-safes to block** when there is no UI (print/CI runs).
- `paths` rules — globs (`**`, `*`, `?`; bare names also match basenames) tested against resolved absolute paths of `write`/`edit` targets.
- `postEdit` — after any turn that edited files, if `<project>/<testCommandFile>` exists its contents run as a shell command; non-zero exit steers the full failure output back to the agent to self-fix. Runs detached; never stalls the session.
- Rules also apply **inside subagents**.

Shipped defaults block recursive force-deletes of root/home and writes to `.env*` / `.git/**`, and require confirmation for force-push, `git reset --hard`, and curl-pipe-to-shell.

## `web`

```json
"web": { "timeoutMs": 20000, "maxBytes": 51200, "blockPrivateHosts": true }
```

Controls the `fetch` tool: request timeout, response byte cap (streamed — the download aborts past it), and SSRF protection. `blockPrivateHosts` (default true) rejects private, loopback, and link-local hosts, re-checking after every redirect.

## `hooks.bashAppend` / `hooks.pathsAppend`

Additive rule arrays — concatenated onto the shipped defaults instead of replacing them. **Prefer these** over overriding `hooks.bash`/`hooks.paths` wholesale (which drops the built-in safety guards; the loader warns if you do).

```json
"hooks": { "bashAppend": [ { "pattern": "\\bterraform\\s+destroy\\b", "action": "confirm" } ] }
```

## `compaction`

```json
"compaction": { "tier": "scout", "proactiveAtPercent": 85 }
```

- `tier` — which tier model summarizes during compaction and `/tale` (a cheap tier saves cost). Omit to use the lead model.
- `proactiveAtPercent` — when context usage crosses this %, compact automatically with focus instructions rather than waiting for pi's trigger. Omit to disable proactive compaction.

## Debugging

Set `FAIRY_TALES_DEBUG=1` to log internal diagnostics (swallowed errors, config problems, overlay/subagent internals) to `$TMPDIR/fairy-tales-debug.log`.

## pi settings that pair well (in `~/.pi/agent/settings.json`)

| Setting | Why |
|---|---|
| `"quietStartup": true` | Hide the startup resource listing; use `/grimoire` instead. |
| `"theme"` | Managed automatically under `ftales` (day/night); your own theme is remembered and restored for plain `pi`. |

## Command / tool inventory

**Tools (model-invoked):** `agent`, `agent_control`, `todo`, `remember`, `fetch`, `exit_plan`
**Commands:** `/plan`, `/agents`, `/agent-model`, `/memory`, `/grimoire`, `/tale` (ftales only)
**Prompts:** `/commit`, `/review`, `/plan-task`, `/standup`
**Skills:** `deep-review`, `handoff`, `ship`
