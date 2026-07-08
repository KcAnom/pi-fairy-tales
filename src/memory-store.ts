/** File-based persistent memory: MEMORY.md index + topics/*.md detail files. */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { expandHome } from "./config.ts";
import { slugify } from "./text.ts";

export class MemoryStore {
  readonly dir: string;
  readonly indexPath: string;
  readonly topicsDir: string;

  constructor(configuredDir: string) {
    this.dir = expandHome(configuredDir);
    this.indexPath = join(this.dir, "MEMORY.md");
    this.topicsDir = join(this.dir, "topics");
  }

  readIndex(): string | undefined {
    try {
      if (!existsSync(this.indexPath)) return undefined;
      const text = readFileSync(this.indexPath, "utf-8").trim();
      return text || undefined;
    } catch {
      return undefined;
    }
  }

  private ensureDirs(): void {
    mkdirSync(this.topicsDir, { recursive: true });
  }

  /** Append a memory. Without topic: one bullet in the index. With topic:
   *  appended to topics/<topic>.md plus an index pointer (once). */
  async remember(content: string, topic?: string): Promise<string> {
    this.ensureDirs();
    const date = new Date().toISOString().slice(0, 10);
    if (!topic) {
      await withFileMutationQueue(this.indexPath, async () => {
        await appendFile(this.indexPath, `- ${content} _(${date})_\n`, "utf-8");
      });
      return this.indexPath;
    }
    const slug = slugify(topic);
    const topicPath = join(this.topicsDir, `${slug}.md`);
    await withFileMutationQueue(topicPath, async () => {
      if (!existsSync(topicPath)) {
        await writeFile(topicPath, `# ${topic}\n\n`, "utf-8");
      }
      await appendFile(topicPath, `- ${content} _(${date})_\n`, "utf-8");
    });
    await withFileMutationQueue(this.indexPath, async () => {
      const index = existsSync(this.indexPath) ? readFileSync(this.indexPath, "utf-8") : "";
      if (!index.includes(`topics/${slug}.md`)) {
        await appendFile(this.indexPath, `- [${topic}](topics/${slug}.md) — see topic file for details\n`, "utf-8");
      }
    });
    return topicPath;
  }

  async writeIndex(content: string): Promise<void> {
    this.ensureDirs();
    await withFileMutationQueue(this.indexPath, async () => {
      await writeFile(this.indexPath, content, "utf-8");
    });
  }
}
