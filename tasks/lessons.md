# Lessons

## Check pi built-ins before registering extension commands (2026-07-14)

**What happened:** Registered a `/copy` command in an extension; pi ships a built-in
interactive `/copy`, so the extension command was silently skipped in autocomplete
and shipped broken in 0.7.0. Renamed to `/grab` in 0.7.1.

**Rule:** Before `pi.registerCommand("<name>", …)`, check the built-in list:
`@earendil-works/pi-coding-agent/dist/core/slash-commands.js` (settings, model,
scoped-models, export, import, share, copy, name, session, changelog, hotkeys,
fork, clone, tree, trust, login, logout, new, compact, resume, reload, quit).
Also grep this repo's own `registerCommand(` calls for internal collisions.
