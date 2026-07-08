---
name: artifact
description: Design and produce a polished, self-contained HTML artifact (report, roadmap, dashboard, one-pager, spec) using the artifact tool. Use when the deliverable reads better as a designed page than as terminal text, or when the user asks for a report, roadmap, visual summary, dashboard, or something to keep or share.
---

# Artifact

Produce a considered, self-contained HTML document with the `artifact` tool — not boilerplate. Treat it as a design task calibrated to what the request actually needs.

## Method

1. **Read the request; calibrate the treatment.** Most artifacts (a plan, a report, a memo) want a *utilitarian-but-polished* look: real typographic hierarchy, considered spacing, a proper palette — but no giant hero, no flourish for its own sake. A landing page, a thing they'll keep or share, warrants an editorial treatment with one deliberate aesthetic risk. When unsure, a quiet, well-composed page is never wrong.

2. **Ground it in the subject.** Pin one subject, its audience, and the page's single job. The palette and type should come from the subject's own world, not a default. Build with the real content — never lorem.

3. **Write a short design plan first** (in your head or the reply): a 4–6 colour palette as named hex values (choose neutrals with a slight hue bias toward the accent — a pure mid-grey reads as unconsidered); two type roles (a characterful display face used with restraint + a readable body face; a mono utility face if there's data/code); and a one-line layout concept.

4. **Build both themes.** Define the palette as CSS custom properties on `:root`; redefine the tokens under `@media (prefers-color-scheme: dark)`, then again under `:root[data-theme="dark"]` and `:root[data-theme="light"]` so the viewer's toggle wins in both directions. Style components through the tokens, never inside the media query. Give the second theme the same care — don't naively invert.

5. **Information design when it's a dashboard, not a document.** Surface the summary before the detail. Encode state in form as well as number — a pill, a chip, a severity stripe — so what needs attention reads at a glance. Semantic colour (good/warn/critical) is separate from the accent.

## Rules (the tool enforces the skeleton; you own the design)

- **Self-contained only.** No external fonts, scripts, images, or CDNs — a strict environment blocks them. Use good system font stacks (e.g. `"Iowan Old Style", Palatino, Georgia, serif` for display; `system-ui` for body; `ui-monospace, Menlo` for data) or inline a font as a data URI. Embed images as data URIs.
- **Provide the `<body>` content + your own `<style>`.** The tool supplies the doctype, `<head>`, a minimal reset, and an emoji favicon. (Pass a full `<!doctype>` document only if you need to own the head.)
- **Layout does the spacing** — flex/grid with `gap`, not collapsing margins. Wide content (tables, code) scrolls inside its own `overflow-x:auto` container; the page body never scrolls sideways. Use `font-variant-numeric: tabular-nums` where digits align.
- **Structure encodes meaning.** Numbered markers only when the content is genuinely a sequence. Eyebrows, dividers, and labels should say something true, not decorate.
- **Copy is design material.** Name things by what the reader recognizes; active voice; specific beats clever.
- Give focus states a visible outline; respect `prefers-reduced-motion`.

## Invoke

Call `artifact` with `title`, the `html` (body + style), an optional `favicon` emoji, and an optional `filename`. It writes to `artifacts/<slug>.html` and opens it in the browser. Report the path and one line on the design choices you made.
