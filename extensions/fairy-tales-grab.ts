/**
 * fairy-tales-grab: /grab — clipboard without mouse-selecting wrapped terminal text.
 * Opens a picker over recent code blocks, responses, and tool outputs so you copy
 * exactly what the model produced, as clean logical text (no wrapping, no UI
 * decoration). Complements pi's built-in /copy, which takes the last message whole.
 * Clipboard: pbcopy / wl-copy / xclip / xsel / clip, falling back to the OSC 52
 * escape (the terminal sets the clipboard itself — works over SSH).
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isNested } from "../src/config.ts";
import { CLIP_MARK } from "../src/bus.ts";
import { flashStatus } from "../src/util.ts";

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => (b as { type?: string })?.type === "text" && typeof (b as { text?: unknown }).text === "string")
      .map((b) => (b as { text: string }).text)
      .join("\n");
  }
  return "";
}

/** First meaningful line, collapsed and clipped, for picker labels. */
function snippet(text: string, max = 48): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  const flat = line.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Try native clipboard tools, then fall back to OSC 52. Exported for tests. */
export async function copyToClipboard(text: string): Promise<string> {
  const candidates: Array<[string, string[]]> =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];
  for (const [cmd, args] of candidates) {
    const ok = await new Promise<boolean>((resolve) => {
      try {
        const p = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
        p.on("error", () => resolve(false));
        p.on("close", (code) => resolve(code === 0));
        p.stdin.on("error", () => resolve(false));
        p.stdin.write(text);
        p.stdin.end();
      } catch {
        resolve(false);
      }
    });
    if (ok) return cmd;
  }
  // OSC 52: ask the terminal itself to set the clipboard. Many terminals cap the
  // payload (~100kB base64) — large copies may truncate, but it works over SSH.
  const b64 = Buffer.from(text, "utf-8").toString("base64");
  process.stdout.write(`\x1b]52;c;${b64}\x07`);
  return "osc52";
}

const fmtSize = (bytes: number) => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${bytes} B`);

export default function (pi: ExtensionAPI) {
  if (isNested()) return;

  pi.registerCommand("grab", {
    description: "Pick a code block, response, or tool output to copy (pi's built-in /copy takes the last message)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) return;

      const messages: Array<{ role?: string; toolName?: string; content?: unknown }> = [];
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "message") {
          messages.push((entry as { message?: { role?: string; toolName?: string; content?: unknown } }).message ?? {});
        }
      }

      const doCopy = async (text: string, what: string) => {
        pi.events.emit(CLIP_MARK, { text }); // clipwatch: this change is ours, don't double-toast
        const via = await copyToClipboard(text);
        const lines = text.split("\n").length;
        flashStatus(
          ctx.ui,
          "fairy-tales-grab",
          `⧉ Copied ${what} — ${lines} line${lines > 1 ? "s" : ""}, ${fmtSize(Buffer.byteLength(text, "utf-8"))}${
            via === "osc52" ? " (via terminal OSC 52)" : ""
          }`,
        );
      };

      // Picker over recent copyable items, newest first.
      interface Item {
        label: string;
        text: string;
      }
      const items: Item[] = [];
      const MAX_ITEMS = 30;
      for (let i = messages.length - 1; i >= 0 && items.length < MAX_ITEMS; i--) {
        const m = messages[i];
        if (m.role === "assistant") {
          const text = extractText(m.content).trim();
          if (!text) continue;
          // Code blocks are the most-wanted copies — list them before their message.
          for (const match of text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)) {
            const code = match[2].replace(/\n$/, "");
            if (!code.trim()) continue;
            const lang = match[1].trim();
            const lines = code.split("\n").length;
            items.push({
              label: `code${lang ? ` (${lang})` : ""} · ${lines}L · ${snippet(code)}`,
              text: code,
            });
          }
          items.push({ label: `response · ${snippet(text)}`, text });
        } else if (m.role === "toolResult") {
          const text = extractText(m.content).trim();
          if (!text) continue;
          items.push({ label: `${m.toolName ?? "tool"} output · ${snippet(text)}`, text });
        }
      }
      if (!items.length) {
        ctx.ui.notify("Nothing to copy yet.", "info");
        return;
      }
      // Recency number keeps labels unique for the select control.
      const labels = items.map((it, i) => `${i + 1} · ${it.label}`);
      const choice = await ctx.ui.select("Copy what? (1 = newest)", labels);
      if (choice === undefined) return;
      const picked = items[labels.indexOf(choice)];
      if (picked) await doCopy(picked.text, labels.indexOf(choice) + 1 === 1 ? "newest item" : picked.label.split(" · ")[0]);
    },
  });
}
