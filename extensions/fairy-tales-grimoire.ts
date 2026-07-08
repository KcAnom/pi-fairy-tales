/**
 * fairy-tales-grimoire: /grimoire — the on-demand catalog of skills, prompts,
 * extensions, and themes, replacing pi's always-on startup lists
 * (hidden via the quietStartup setting). Works in plain pi and ftales.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { basename } from "node:path";
import { isNested } from "../src/config.ts";

export default function (pi: ExtensionAPI) {
  if (isNested()) return;

  pi.registerCommand("grimoire", {
    description: "Browse installed skills, prompts, extensions, and themes",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const commands = pi.getCommands();
      const skills = commands
        .filter((c) => c.source === "skill")
        .map((c) => c.name.replace(/^skill:/, ""))
        .sort();
      const prompts = commands
        .filter((c) => c.source === "prompt")
        .map((c) => `/${c.name}`)
        .sort();

      const extensionFiles = new Set<string>();
      for (const c of commands) {
        if (c.source === "extension" && c.sourceInfo?.path) extensionFiles.add(basename(c.sourceInfo.path));
      }
      for (const t of pi.getAllTools()) {
        const src = t.sourceInfo?.source;
        if (src && src !== "builtin" && src !== "sdk" && t.sourceInfo?.path) {
          extensionFiles.add(basename(t.sourceInfo.path));
        }
      }
      const extensions = [...extensionFiles].sort();

      let themes: string[] = [];
      try {
        themes = (ctx.ui.getAllThemes() ?? []).map((t: { name: string }) => t.name).sort();
      } catch {
        // themes unavailable over RPC
      }

      const section = (title: string, items: string[]) =>
        `${title} (${items.length})\n${items.length ? items.join(", ") : "(none)"}`;
      const body = [
        section("Skills", skills),
        section("Prompts", prompts),
        section("Extensions", extensions),
        section("Themes", themes),
      ].join("\n\n");

      await ctx.ui.custom(
        (
          _tui: unknown,
          theme: { fg(c: string, s: string): string; bold(s: string): string },
          _kb: unknown,
          done: (v: undefined) => void,
        ) => ({
          render(width: number): string[] {
            const inner = Math.max(20, width - 4);
            const rule = theme.fg("dim", "· ✦ ".repeat(Math.max(1, Math.floor(inner / 4))));
            const lines: string[] = ["", `  ${theme.fg("accent", theme.bold("❦ The Grimoire ❦"))}`, `  ${rule}`, ""];
            for (const block of body.split("\n\n")) {
              const [head, ...rest] = block.split("\n");
              lines.push(`  ${theme.fg("accent", head)}`);
              for (const l of wrapTextWithAnsi(theme.fg("text", rest.join(" ")), inner - 2)) {
                lines.push(`   ${l}`);
              }
              lines.push("");
            }
            lines.push(`  ${rule}`, `  ${theme.fg("dim", "press any key to close the book")}`, "");
            return lines;
          },
          invalidate() {},
          handleInput(data: string) {
            if (data) done(undefined);
          },
        }),
        { overlay: true, overlayOptions: { anchor: "center", width: "80%" } },
      );
    },
  });
}
