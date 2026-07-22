# Ecosystem map — where everything lives and why

Two repos, one runtime. This page is the answer to "why do I have two folders, and what does each file under `~/.pi` do?"

## The two repos

| Repo | Role | Depends on |
|---|---|---|
| `~/pi-fairy-tales` | **The base harness.** 22 extensions, 4 skills, 4 prompts, 2 themes. Provides the `agent` / `quest` / `fetch` / `codebase_intel` tools, `/ultraplan`, hooks, memory, checkpoints, compaction, `ftales` branding. | pi core only (peer deps) |
| `~/pi-fairy-tales-chains` | **A thin add-on.** 1 extension (the `chain` tool) + 22 phase skills forming six durable multi-phase chains (release, feature-ship, onboard, bughunt, migrate, research). | `pi-fairy-tales >= 0.15.0` (required peer) |

They are deliberately **not** bundled: two installs, zero conflicts, no second copy of the base loaded inside the add-on. Chains *calls* the base's tools at runtime; it cannot function without it. If the near-identical names trip you up, read `-chains` as "the chain skills *for* pi-fairy-tales".

## How they load into pi

`~/.pi/agent/settings.json` registers both as local-path packages:

```json
"packages": ["../../pi-fairy-tales", "../../pi-fairy-tales-chains", ...]
```

(Paths resolve relative to `~/.pi/agent`.) pi reads each repo's `package.json` `pi` field and loads its `extensions/`, `skills/`, `prompts/`, `themes/` directly from the repo — TypeScript via jiti, no build step. Editing a repo file + `/reload` inside pi is the whole dev loop. Nothing is copied into `~/.pi`.

## Runtime footprint under `~/.pi/agent/`

| Path | What it is | Written by |
|---|---|---|
| `fairy-tales.json` | **Your machine config** — real model tiers, `modelMode: "orchestrated"`. Overrides the repo's shipped `fairy-tales.config.json` (deep-merge; a project's `.pi/fairy-tales.json` wins over both). | you |
| `fairy-tales-quests.sqlite` (+ `-shm`/`-wal`) | Durable quest queue. | `QuestStore` (`src/quest-store.ts`); read-only by `~/.pi/system-dashboard/scan.py` |
| `fairy-tales-transcripts/` | Per-subagent-run transcripts, `<epochMs>-<run-name>-<agentId>.json`, auto-pruned to newest 50. | `src/subagent/engine.ts` |
| `memory/`, `plans/` | Persistent memory + plan files. | memory / plan extensions |
| `cache/code-intelligence/<sha256(project)>/` | Code-intel index per project. | `src/code-intel/` |

Chains state is **per-project**, not here: `<project>/.pi/fairy-tales/chains/<chain>/state.json` (+ `state.md` projection).

## Config precedence (base harness)

1. `<project>/.pi/fairy-tales.json` — wins
2. `~/.pi/agent/fairy-tales.json` — your machine defaults
3. `<repo>/fairy-tales.config.json` — shipped defaults (tier model IDs are placeholders on purpose; out of the box `modelMode: "single"` follows the session model, so they're never used until you opt into tiers)

## Related tooling

- `pi-skill-system-creator` (installed via npm in settings.json) — authoring/validation toolchain used to build and lint the chain skills.
- `install.sh` (base repo) — idempotent: `pi install <repo>`, `~/bin/ftales` launcher, macOS `ftales.app`.
