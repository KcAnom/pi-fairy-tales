/**
 * fairy-tales-artifact: the `artifact` tool (#39).
 *
 * Produces a polished, fully self-contained HTML document (inlined CSS/JS, no
 * external requests), writes it to <cwd>/artifacts/, and opens it in the
 * browser. The agent supplies the body content and its own <style>; the tool
 * wraps it in a theme-aware skeleton (light/dark via prefers-color-scheme +
 * a data-theme toggle) with a minimal reset and an emoji favicon — the same
 * shape as a Claude artifact. If the agent supplies a full document
 * (<!doctype>/<html>), it is written verbatim.
 *
 * The `artifact` skill carries the full design method for substantial work.
 */
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { platform } from "node:os";
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { isNested } from "../src/config.ts";
import { slugify } from "../src/text.ts";
import { debug } from "../src/util.ts";

const DESIGN_BRIEF =
  "Use artifact for anything that reads better as a designed page than as terminal text — a report, roadmap, dashboard, summary, or spec. Write real design, not boilerplate: derive a 4–6 colour palette and type hierarchy from the SUBJECT; style BOTH light and dark themes via CSS custom properties (redefine tokens under @media (prefers-color-scheme: dark) AND :root[data-theme]); keep body text near 65ch; use semantic state colours (good/warn/critical) separate from the accent; make tables/code scroll inside their own overflow-x container. Provide the <body> content plus your own <style> — the tool supplies the doctype, head, reset, theme toggle, and favicon. Everything must be self-contained (no external fonts/scripts/images; inline or data-URI).";

function emojiFavicon(emoji: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${emoji}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function wrapDocument(title: string, bodyHtml: string, favicon: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="${emojiFavicon(favicon)}">
<style>
  *, *::before, *::after { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; min-height: 100vh; }
  img, svg, video { max-width: 100%; height: auto; }
  table { border-collapse: collapse; }
  :where(pre, table) { overflow-x: auto; }
  a { color: inherit; }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: .01ms !important; transition-duration: .01ms !important; }
  }
</style>
</head>
<body>
${bodyHtml}
</body>
</html>
`;
}

async function openInBrowser(pi: ExtensionAPI, file: string): Promise<boolean> {
  const p = platform();
  const cmd = p === "darwin" ? "open" : p === "win32" ? "cmd" : "xdg-open";
  const args = p === "win32" ? ["/c", "start", "", file] : [file];
  try {
    const r = await pi.exec(cmd, args, { timeout: 8000 });
    return r.code === 0;
  } catch (err) {
    debug("artifact", "open failed", err);
    return false;
  }
}

export default function (pi: ExtensionAPI) {
  if (isNested()) return; // artifacts are a lead-agent capability

  pi.registerTool({
    name: "artifact",
    label: "Artifact",
    description:
      "Create a polished, self-contained HTML artifact (report, roadmap, dashboard, summary) and open it in the browser. Provide the <body> content and your own <style>; the tool wraps it in a theme-aware document skeleton with a reset and favicon, saves it to artifacts/, and opens it. Pass a full <!doctype> document to skip wrapping. Must be fully self-contained — no external fonts, scripts, or images.",
    promptSnippet: "Create a designed, self-contained HTML artifact and open it in the browser",
    promptGuidelines: [DESIGN_BRIEF],
    parameters: Type.Object({
      title: Type.String({ description: "Document title (shown in the browser tab)" }),
      html: Type.String({ description: "The <body> content plus a <style> block, OR a complete <!doctype> document" }),
      favicon: Type.Optional(Type.String({ description: "An emoji for the browser-tab icon, e.g. 📊" })),
      filename: Type.Optional(Type.String({ description: "Base filename (without .html); defaults to a slug of the title" })),
      open: Type.Optional(Type.Boolean({ description: "Open in the browser after writing (default true)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const isFullDoc = /<!doctype|<html[\s>]/i.test(params.html);
      const doc = isFullDoc ? params.html : wrapDocument(params.title, params.html, params.favicon ?? "✨");

      const dir = join(ctx.cwd, "artifacts");
      const base = slugify(params.filename ?? params.title);
      const file = join(dir, `${base}.html`);
      await withFileMutationQueue(file, async () => {
        mkdirSync(dir, { recursive: true });
        await writeFile(file, doc, "utf-8");
      });

      let opened = false;
      const wantOpen = params.open !== false && ctx.hasUI;
      if (wantOpen) opened = await openInBrowser(pi, file);

      return {
        content: [
          {
            type: "text",
            text:
              `Artifact written to ${file}` +
              (opened ? " and opened in your browser." : `. Open it with: open "${file}"`),
          },
        ],
        details: { file, opened, bytes: doc.length },
      };
    },
  });
}
