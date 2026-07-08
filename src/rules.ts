/** Rule evaluation for the fairy-tales hook engine. */
import type { BashRule, PathRule } from "./config.ts";
import { pathMatches } from "./glob.ts";

export interface RuleVerdict {
  action: "block" | "confirm";
  reason: string;
}

export function checkBashCommand(rules: BashRule[], command: string): RuleVerdict | undefined {
  for (const rule of rules ?? []) {
    try {
      if (new RegExp(rule.pattern, "i").test(command)) {
        return { action: rule.action, reason: rule.reason ?? `matched rule: ${rule.pattern}` };
      }
    } catch {
      // invalid user regex — skip, never brick tool calls
    }
  }
  return undefined;
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
