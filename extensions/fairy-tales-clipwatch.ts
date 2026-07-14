/**
 * fairy-tales-clipwatch: toast when the clipboard changes while the TUI runs.
 * Terminal copy-on-select (drag → release → copied) is silent by design — the
 * terminal never tells the app. This watcher polls the system clipboard and
 * notifies "⧉ Copied to clipboard (N lines · M chars)" so a drag-copy gets
 * visible confirmation. Privacy: only counts are shown, never content, and
 * nothing is stored or sent anywhere. Disable with ui.clipboardNotify: false.
 */
import { execFile } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isNested, loadFairyTalesConfig } from "../src/config.ts";
import { CLIP_MARK } from "../src/bus.ts";
import { flashStatus } from "../src/util.ts";

const POLL_MS = 1000;

/** Resolve the platform's clipboard-read command once; undefined = unsupported. */
function readerCommand(): [string, string[]] | undefined {
  if (process.platform === "darwin") return ["pbpaste", []];
  if (process.platform === "linux") {
    // First tool that exists wins; probed lazily on first read failure instead
    // of shelling out at startup.
    return ["sh", ["-c", "wl-paste 2>/dev/null || xclip -selection clipboard -o 2>/dev/null || xsel --clipboard --output 2>/dev/null"]];
  }
  return undefined;
}

function readClipboard(cmd: [string, string[]]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(cmd[0], cmd[1], { maxBuffer: 4 * 1024 * 1024, timeout: 2000 }, (err, stdout) => {
      resolve(err ? undefined : stdout);
    });
  });
}

export default function (pi: ExtensionAPI) {
  if (isNested()) return;
  const cmd = readerCommand();
  if (!cmd) return;

  let timer: ReturnType<typeof setInterval> | undefined;
  let lastSeen: string | undefined; // undefined until the baseline read
  let selfSet: string | undefined; // /grab's own copies — already toasted there

  pi.events.on(CLIP_MARK, (d: unknown) => {
    selfSet = (d as { text?: string })?.text;
  });

  pi.on("session_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    const cfg = loadFairyTalesConfig(ctx.cwd);
    if (cfg.ui?.clipboardNotify === false) return;
    if (timer) clearInterval(timer);
    lastSeen = undefined;
    timer = setInterval(async () => {
      const now = await readClipboard(cmd);
      if (now === undefined) return; // read failed — try again next tick
      const first = lastSeen === undefined;
      const changed = !first && now !== lastSeen;
      lastSeen = now;
      if (first || !changed || !now.trim()) return;
      if (selfSet !== undefined && now === selfSet) {
        selfSet = undefined; // /grab already showed its own toast
        return;
      }
      const lines = now.split("\n").length;
      flashStatus(ctx.ui, "fairy-tales-clip", `⧉ Copied to clipboard (${lines} line${lines > 1 ? "s" : ""} · ${now.length} chars)`);
    }, POLL_MS);
  });

  pi.on("session_shutdown", async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  });
}
