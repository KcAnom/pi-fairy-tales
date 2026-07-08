# Setup Guide

Complete instructions for installing pi-fairy-tales on a new machine. Written to be executed by a human **or an AI coding agent** — every step is idempotent (safe to re-run) and ends with a verification command whose expected output is stated.

## Prerequisites

- **Node.js ≥ 20** (`node --version`). Any install method works; [nvm](https://github.com/nvm-sh/nvm) is recommended.
- A POSIX shell (macOS or Linux; Windows via WSL).
- At least one LLM provider account (Anthropic, OpenAI, or any provider pi supports — see "Models" below).

## Step 1 — Install pi

```bash
npm i -g @earendil-works/pi-coding-agent
```

**Verify:** `pi --version` prints a version number.

Optional (nvm users): make pi survive future Node upgrades automatically:

```bash
echo "@earendil-works/pi-coding-agent" >> ~/.nvm/default-packages
```

## Step 2 — Install this package

```bash
pi install git:github.com/KcAnom/pi-fairy-tales
```

**Verify:** `grep packages ~/.pi/agent/settings.json` shows the package source.

To develop locally instead, clone and `pi install /path/to/pi-fairy-tales` — local installs load in place, so edits apply after `/reload` inside pi.

## Step 3 — Create the `ftales` launcher

`ftales` launches pi with the Fairy Tales experience (theme, masthead, enchanted footer, `/tale`, Fae Council). Plain `pi` stays completely standard.

```bash
mkdir -p ~/bin
printf '#!/bin/sh\nexport FTALES=1\nexec pi "$@"\n' > ~/bin/ftales
chmod +x ~/bin/ftales
```

Ensure `~/bin` is on PATH (add to `~/.zshrc` or `~/.bashrc` if not):

```bash
export PATH="$HOME/bin:$PATH"
```

**Verify:** `which ftales` prints `~/bin/ftales`.

> Cloned the repo? `./install.sh` performs Steps 2–3 in one command.

## Step 4 — Log in to your provider(s)

Start `pi` and run `/login`, or export a standard API key env var (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …). Credentials are stored in `~/.pi/agent/auth.json` on **your** machine — never in this package.

**Verify:** `pi -p "Reply with exactly: OK"` prints `OK`.

## Step 5 — Point the subagent tiers at YOUR models

The shipped defaults reference models the original author uses. You have two options:

**Option A (simplest):** inside pi, run `/agent-model` and choose **"Single — follow my session model"**. Every subagent then uses whatever model your session uses. Done.

**Option B (tiered — cheap scouts, strong planners):** create `~/.pi/agent/fairy-tales.json`:

```json
{
  "tiers": {
    "scout":  { "model": "provider/cheap-fast-model", "thinkingLevel": "low" },
    "worker": { "model": "provider/your-main-model",  "thinkingLevel": "medium" },
    "brain":  { "model": "provider/your-best-model",  "thinkingLevel": "high" }
  }
}
```

Model identifiers use `provider/model-id` form — run `pi --list-models` to see yours.

Either way, nothing breaks if a tier model is unavailable: subagents fall back to your session model and prepend a visible warning to their result.

**Verify:** in pi, ask: *"Use the agent tool with role explore to list files here."* — a subagent runs and returns a result with a stats line.

## Step 6 (recommended) — Clean startup

Hide pi's startup resource listing (browse it anytime with `/grimoire`):

```bash
python3 - <<'EOF'
import json, os
p = os.path.expanduser("~/.pi/agent/settings.json")
d = json.load(open(p)) if os.path.exists(p) else {}
d["quietStartup"] = True
json.dump(d, open(p, "w"), indent=2)
EOF
```

## Step 7 (optional) — Post-edit test hook, per project

In any project where you want automatic verification after the agent edits files, create `.pi/test-command` containing your test command:

```bash
mkdir -p .pi && echo "npm test" > .pi/test-command
```

After every file edit, the hook runs this command; failures are steered back to the agent, which fixes them and re-runs until green.

## Final verification checklist

| Check | Command | Expected |
|---|---|---|
| pi works | `pi -p "Reply with exactly: OK"` | `OK` |
| Package loaded | `pi -p "..."` output has no extension errors on stderr | clean |
| Launcher | `ftales -p "Reply with exactly: OK"` | `OK` |
| Guard rails | ask pi to write a `.env` file | blocked with a fairy-tales path-rule message |
| Subagents | ask for an explore agent | result + `[explore · model · turns · tok · $ · time]` stats |
| Branding | open `ftales` interactively | masthead, themed UI, enchanted footer |

## Uninstall

```bash
pi remove git:github.com/KcAnom/pi-fairy-tales
rm -f ~/bin/ftales
```

Your `~/.pi/agent/fairy-tales.json`, memory, and plans are left untouched; delete them manually if desired.
