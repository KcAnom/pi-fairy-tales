/**
 * Baseline tests for src/rules.ts — guard-rail evaluation.
 * (Phase 3 adds evasion-hardening + selectTestCommands tests.)
 */
import { describe, it, expect } from "vitest";
import { normalizeCommand, checkBashCommand, extractBashWriteTargets, isMutatingBash, checkPath } from "../rules.ts";
import type { BashRule, PathRule } from "../config.ts";

describe("normalizeCommand", () => {
  it("strips single and double quotes", () => {
    expect(normalizeCommand('rm "file"')).toBe("rm file");
    expect(normalizeCommand("rm 'file'")).toBe("rm file");
  });

  it("unescapes escaped quotes then strips them", () => {
    expect(normalizeCommand('rm \\"file\\"')).toBe("rm file");
  });

  it("expands $HOME and ${HOME}", () => {
    const home = process.env.HOME || "/home/user";
    expect(normalizeCommand("cat $HOME/.bashrc")).toBe(`cat ${home}/.bashrc`);
    expect(normalizeCommand("cat ${HOME}/.bashrc")).toBe(`cat ${home}/.bashrc`);
  });

  it("collapses runs of whitespace", () => {
    expect(normalizeCommand("rm    -rf     /tmp")).toBe("rm -rf /tmp");
  });

  it("leaves already-normal commands unchanged", () => {
    expect(normalizeCommand("git status")).toBe("git status");
  });
});

describe("checkBashCommand", () => {
  const rules: BashRule[] = [
    { pattern: "rm\\s+-rf\\s+/", action: "block", reason: "dangerous rm" },
    { pattern: "git\\s+push.*--force", action: "confirm", reason: "force push" },
  ];

  it("matches the raw command form", () => {
    expect(checkBashCommand(rules, "rm -rf /etc")).toEqual({ action: "block", reason: "dangerous rm" });
  });

  it("matches the normalized form (quote evasion)", () => {
    expect(checkBashCommand(rules, 'rm "-rf" /etc')).toEqual({ action: "block", reason: "dangerous rm" });
  });

  it("matches the normalized form ($HOME expands to a path starting with /)", () => {
    expect(checkBashCommand(rules, "rm -rf $HOME")).toEqual({ action: "block", reason: "dangerous rm" });
  });

  it("returns undefined for non-matching commands", () => {
    expect(checkBashCommand(rules, "ls -la")).toBeUndefined();
  });

  it("skips invalid regex rules without throwing", () => {
    const bad: BashRule[] = [{ pattern: "[invalid", action: "block", reason: "x" }];
    expect(checkBashCommand(bad, "anything")).toBeUndefined();
  });
});

describe("extractBashWriteTargets", () => {
  it("extracts redirect targets", () => {
    expect(extractBashWriteTargets("echo x > .env", "/cwd")).toContain("/cwd/.env");
  });

  it("does NOT extract stderr redirects (>&2)", () => {
    expect(extractBashWriteTargets("echo x >&2", "/cwd")).toHaveLength(0);
  });

  it("extracts tee targets", () => {
    expect(extractBashWriteTargets("echo x | tee out.log", "/cwd")).toContain("/cwd/out.log");
  });

  it("extracts cp destination (last token)", () => {
    expect(extractBashWriteTargets("cp src.txt dest.txt", "/cwd")).toContain("/cwd/dest.txt");
  });

  it("ignores /dev/ paths", () => {
    expect(extractBashWriteTargets("echo x > /dev/null", "/cwd")).not.toContain("/dev/null");
  });
});

describe("isMutatingBash", () => {
  it("flags file-writing commands", () => {
    expect(isMutatingBash("echo x > file")).toBe(true);
    expect(isMutatingBash("rm file")).toBe(true);
    expect(isMutatingBash("git commit -m x")).toBe(true);
    expect(isMutatingBash("npm install")).toBe(true);
  });

  it("does NOT flag read-only commands", () => {
    expect(isMutatingBash("ls -la")).toBe(false);
    expect(isMutatingBash("git status")).toBe(false);
    expect(isMutatingBash("echo hello")).toBe(false);
  });
});

describe("checkPath", () => {
  const rules: PathRule[] = [
    { glob: "**/.env*", action: "block", reason: "no env writes" },
    { glob: "**/.git/**", action: "block", reason: "no git internals" },
  ];

  it("matches .env files", () => {
    expect(checkPath(rules, "/proj/.env")).toEqual({ action: "block", reason: "no env writes" });
  });

  it("matches .git internals", () => {
    expect(checkPath(rules, "/proj/.git/config")).toEqual({ action: "block", reason: "no git internals" });
  });

  it("returns undefined for normal paths", () => {
    expect(checkPath(rules, "/proj/src/index.ts")).toBeUndefined();
  });
});
