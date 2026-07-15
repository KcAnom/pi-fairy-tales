/** Rule evaluation for the fairy-tales hook engine. */
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { BashRule, PathRule } from "./config.ts";
import { pathMatches } from "./glob.ts";

export interface RuleVerdict {
  action: "block" | "confirm";
  reason: string;
}

/**
 * Normalize a command so trivial evasions (quotes, $HOME/~ expansion) don't slip
 * past regex rules. Defense-in-depth, not a sandbox — we match rules against BOTH
 * the raw and normalized forms.
 *
 * This catches SYNTACTIC evasion — character-level tricks that hide dangerous
 * commands from naive string/regex matching (quote-splitting, `$IFS` word
 * splitting). It does NOT handle SEMANTIC indirection, where the dangerous
 * command is assembled at runtime (e.g. `$(echo rm)`, `$CMD -rf`); that class
 * of evasion is handled by the shipped confirm rules in fairy-tales.config.json.
 */
export function normalizeCommand(command: string): string {
  return command
    .replace(/\\(["'])/g, "$1") // unescape escaped quotes
    .replace(/["']/g, "") // drop quotes: r""m -> rm
    .replace(/\$\{HOME\}|\$HOME|(?<=^|\s)~(?=\/|\s|$)/g, homedir())
    .replace(/\$\{?IFS\}?/g, " ") // $IFS / ${IFS} word-splitting -> space (defeats `rm$IFS-rf$IFS/`)
    .replace(/\s+/g, " ")
    .trim();
}

export function checkBashCommand(rules: BashRule[], command: string): RuleVerdict | undefined {
  const forms = [command, normalizeCommand(command)];
  for (const rule of rules ?? []) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, "i");
    } catch {
      continue; // invalid user regex — skip, never brick tool calls
    }
    if (forms.some((f) => re.test(f))) {
      return { action: rule.action, reason: rule.reason ?? `matched rule: ${rule.pattern}` };
    }
  }
  return undefined;
}

/**
 * Best-effort extraction of filesystem paths a bash command writes to:
 * output redirects, cp/mv/install destinations, tee/dd targets, sed -i files.
 * Returned as absolute paths (resolved against cwd) so path rules can catch
 * bash-mediated writes that never touch the write/edit tools.
 */
export function extractBashWriteTargets(command: string, cwd: string): string[] {
  const norm = normalizeCommand(command);
  const targets = new Set<string>();
  const add = (p: string | undefined) => {
    if (p && !p.startsWith("-") && !p.startsWith("/dev/") && p !== "&2" && p !== "&1") {
      targets.add(resolve(cwd, p));
    }
  };

  // Redirects: > file, >> file, N> file (skip >&2 / >&1)
  for (const m of norm.matchAll(/(?:^|\s)\d*>>?\s*([^\s|&;<>]+)/g)) add(m[1]);
  // tee [-a] file...
  for (const m of norm.matchAll(/\btee\b\s+(?:-a\s+)?([^\s|&;<>]+)/g)) add(m[1]);
  // dd of=file
  for (const m of norm.matchAll(/\bdd\b[^|;&]*\bof=([^\s|&;<>]+)/g)) add(m[1]);
  // sed -i ... file (last token of the segment)
  for (const m of norm.matchAll(/\bsed\b\s+-[a-z]*i[a-z]*\s+.*?([^\s|&;<>]+)\s*$/gim)) add(m[1]);
  // cp/mv/install/ln SRC... DEST  (destination is the last token)
  for (const m of norm.matchAll(/\b(?:cp|mv|install|ln)\b\s+([^|;&]+)/g)) {
    const parts = m[1].trim().split(/\s+/).filter((t) => !t.startsWith("-"));
    if (parts.length >= 2) add(parts[parts.length - 1]);
  }
  return [...targets];
}

export function checkPath(rules: PathRule[], path: string): RuleVerdict | undefined {
  for (const rule of rules ?? []) {
    if (pathMatches(rule.glob, path)) {
      return { action: rule.action, reason: rule.reason ?? `matched path rule: ${rule.glob}` };
    }
  }
  return undefined;
}

/** Heuristic: does this bash command mutate state? Used by plan mode. */
const MUTATION_PATTERNS: RegExp[] = [
  />>?\s*[^&|\s]/, // redirects to files (not >&2)
  /\b(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|dd|truncate)\b/,
  /\bgit\s+(add|commit|push|rebase|merge|reset|clean|checkout|restore|stash|cherry-pick|am|apply)\b/,
  /\b(npm|yarn|pnpm|bun)\s+(install|add|remove|uninstall|update|link|publish)\b/,
  /\bpip3?\s+(install|uninstall)\b/,
  /\bbrew\s+(install|uninstall|upgrade)\b/,
  /\b(sed|perl)\s+(-[a-zA-Z]*i)/, // in-place edits
  /\btee\b/,
  /\b(kill|pkill|killall|shutdown|reboot)\b/,
];

export function isMutatingBash(command: string): boolean {
  return MUTATION_PATTERNS.some((re) => re.test(command));
}
