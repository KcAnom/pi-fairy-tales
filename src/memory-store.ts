/** File-based persistent memory: MEMORY.md index + topics/*.md detail files. */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { expandHome } from "./config.ts";
import { slugify } from "./text.ts";
import { debug } from "./util.ts";

const STOPWORDS = new Set(
  "the a an and or of to in on for with is are was were be this that it as at by from you your i we our".split(" "),
);

function normalize(text: string): string {
  return text.toLowerCase().replace(/_\([\d-]+\)_/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokens(text: string): Set<string> {
  return new Set(normalize(text).split(" ").filter((w) => w.length > 2 && !STOPWORDS.has(w)));
}

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
      return readFileSync(this.indexPath, "utf-8").trim() || undefined;
    } catch (err) {
      debug("memory", `failed to read index at ${this.indexPath}`, err);
      return undefined;
    }
  }

  /** Bullet lines of the index (the "- …" entries), excluding topic pointers. */
  private bullets(): string[] {
    const idx = this.readIndex();
    if (!idx) return [];
    return idx.split("\n").filter((l) => l.trim().startsWith("- ") && !/\]\(topics\//.test(l));
  }

  private ensureDirs(): void {
    mkdirSync(this.topicsDir, { recursive: true });
  }

  /**
   * Save a memory. Deduplicates against existing bullets (normalized), so
   * repeating a fact doesn't bloat the index. With a topic, appends to the
   * topic file plus a one-time index pointer.
   */
  async remember(content: string, topic?: string): Promise<string> {
    this.ensureDirs();
    const date = new Date().toISOString().slice(0, 10);
    const norm = normalize(content);

    if (!topic) {
      // Dedup check must run INSIDE the lock — parallel remember calls would
      // otherwise both read the pre-write index and both append.
      await withFileMutationQueue(this.indexPath, async () => {
        const idx = existsSync(this.indexPath) ? readFileSync(this.indexPath, "utf-8") : "";
        const dup = idx
          .split("\n")
          .some((l) => l.trim().startsWith("- ") && !/\]\(topics\//.test(l) && normalize(l) === norm);
        if (dup) return;
        await appendFile(this.indexPath, `- ${content} _(${date})_\n`, "utf-8");
      });
      return this.indexPath;
    }

    const slug = slugify(topic);
    const topicPath = join(this.topicsDir, `${slug}.md`);
    await withFileMutationQueue(topicPath, async () => {
      const current = existsSync(topicPath) ? readFileSync(topicPath, "utf-8") : `# ${topic}\n\n`;
      if (current.split("\n").some((l) => normalize(l) === norm)) return; // dedupe within topic
      if (!existsSync(topicPath)) await writeFile(topicPath, `# ${topic}\n\n`, "utf-8");
      await appendFile(topicPath, `- ${content} _(${date})_\n`, "utf-8");
    });
    // Add the index pointer once — match the FULL link, not a substring (auth vs auth-flow).
    const pointer = `topics/${slug}.md)`;
    await withFileMutationQueue(this.indexPath, async () => {
      const index = existsSync(this.indexPath) ? readFileSync(this.indexPath, "utf-8") : "";
      if (!index.includes(pointer)) {
        await appendFile(this.indexPath, `- [${topic}](topics/${slug}.md) — see topic file for details\n`, "utf-8");
      }
    });
    return topicPath;
  }

  /** Remove index bullets matching a query (case-insensitive substring on normalized text). */
  async forget(query: string): Promise<number> {
    const idx = this.readIndex();
    if (!idx) return 0;
    const q = normalize(query);
    const lines = idx.split("\n");
    let removed = 0;
    const kept = lines.filter((l) => {
      if (l.trim().startsWith("- ") && normalize(l).includes(q)) {
        removed++;
        return false;
      }
      return true;
    });
    if (removed) await this.writeIndex(kept.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n");
    return removed;
  }

  /**
   * Return an index for injection, ranked by relevance to the opening prompt.
   * Topic pointers are always kept; plain bullets are scored by shared keywords
   * and capped so the context window isn't flooded on long-lived memories.
   */
  relevantIndex(prompt: string | undefined, maxBullets = 24): string | undefined {
    const idx = this.readIndex();
    if (!idx) return undefined;
    const lines = idx.split("\n");
    const pointers = lines.filter((l) => /\]\(topics\//.test(l));
    const bullets = lines.filter((l) => l.trim().startsWith("- ") && !/\]\(topics\//.test(l));
    const headers = lines.filter((l) => l.trim().startsWith("#"));

    if (!prompt || bullets.length <= maxBullets) {
      return idx; // nothing to rank against, or already small enough
    }
    const promptTokens = tokens(prompt);
    const scored = bullets
      .map((b) => {
        const bt = tokens(b);
        let score = 0;
        for (const t of bt) if (promptTokens.has(t)) score++;
        return { b, score };
      })
      .sort((a, z) => z.score - a.score);
    const top = scored.slice(0, maxBullets).map((s) => s.b);
    const dropped = scored.length - top.length;
    const parts = [...headers, ...pointers, ...top];
    if (dropped > 0) parts.push(`- _(${dropped} less-relevant memories hidden; ask to recall a topic to see more)_`);
    return parts.join("\n").trim();
  }

  async writeIndex(content: string): Promise<void> {
    this.ensureDirs();
    await withFileMutationQueue(this.indexPath, async () => {
      await writeFile(this.indexPath, content, "utf-8");
    });
  }
}
