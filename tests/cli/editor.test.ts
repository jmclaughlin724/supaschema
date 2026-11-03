import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(root, path), "utf8"));
}

function readText(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter((file) => file && existsSync(resolve(root, file)));
}

function stageableFiles(paths: string[]): string[] {
  return execFileSync("git", ["ls-files", "--others", "--exclude-standard", "--", ...paths], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

function ignoredFiles(paths: string[]): string[] {
  const result = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
    cwd: root,
    encoding: "utf8",
    input: paths.join("\n"),
  });
  return result.stdout.split("\n").filter(Boolean).sort();
}

describe("public agent and editor surfaces", () => {
  it("keeps private maintainer and operator files out of the public repository", () => {
    const files = trackedFiles();
    const privateAgentFiles = [
      ".agents/prompts/internal.md",
      ".agents/skills/elegant/SKILL.md",
      ".agents/tmp.json",
      ".claude/agents/elegant.md",
      ".claude/skills/elegant/SKILL.md",
      ".codex/agents/elegant.toml",
    ];
    expect(ignoredFiles(privateAgentFiles)).toEqual([...privateAgentFiles].sort());
    expect(stageableFiles([".agents", ".claude", ".codex"])).toEqual([]);
    const privateFiles = [".vscode/settings.json", ".vscode/extensions.json"];
    for (const file of privateFiles) {
      expect(files, file).not.toContain(file);
    }
    expect(ignoredFiles(privateFiles.filter((file) => existsSync(resolve(root, file))))).toEqual(
      privateFiles
        .filter((file) => existsSync(resolve(root, file)))
        .sort((left, right) => left.localeCompare(right))
    );
    expect(stageableFiles(privateFiles)).toEqual([]);
    expect(existsSync(resolve(root, "lsp-soleaux.json"))).toBe(true);
    expect(ignoredFiles(["lsp-soleaux.json"])).toEqual([]);
    expect(
      files.includes("lsp-soleaux.json") ||
        stageableFiles(["lsp-soleaux.json"]).includes("lsp-soleaux.json")
    ).toBe(true);
    const { heldPrivate: privatePrefixes } = readJson<{ heldPrivate: string[] }>(
      "scripts/guards/repo-surface/private-paths.json"
    );
    for (const prefix of privatePrefixes) {
      expect(
        files.some((file) => file.startsWith(prefix)),
        prefix
      ).toBe(false);
    }
    expect(stageableFiles(privatePrefixes)).toEqual([]);
  }, 15_000);

  it("ships only Supaschema-specific consumer hook registration", () => {
    const packageJson = readJson<{ files?: string[] }>("package.json");
    const claudeSettings = readText("agent-bundle/claude/settings.npm.json");
    const codexHooks = readText("agent-bundle/codex/hooks.npm.json");

    expect(packageJson.files).toEqual(expect.arrayContaining(["agent-bundle"]));
    expect(packageJson.files).not.toEqual(
      expect.arrayContaining([".agents/skills/supaschema", ".claude/rules/supaschema.md"])
    );
    expect(codexHooks).toContain("supaschema hook generated-artifact-edit");
    expect(codexHooks).toContain("supaschema hook schema-write");
    expect(codexHooks).not.toContain("general-guard.mjs");
    expect(codexHooks).not.toContain("bash-policy-checks.mjs");
    expect(codexHooks).not.toContain("context-");
    expect(codexHooks).not.toContain("scripts/agent-hooks");
    expect(codexHooks).not.toContain("sync-llm-on-claude-surface-change.mjs");
    expect(claudeSettings).toContain("supaschema hook generated-artifact-edit");
    expect(claudeSettings).toContain("supaschema hook schema-write");
    expect(claudeSettings).not.toContain("bash-policy-checks.mjs");
    expect(claudeSettings).not.toContain("general-guard.mjs");
    expect(claudeSettings).not.toContain("sync-llm-on-claude-surface-change.mjs");
    expect(
      existsSync(resolve(root, "agent-bundle/claude/hooks/guards/bash-policy-checks.mjs"))
    ).toBe(false);
    expect(existsSync(resolve(root, "agent-bundle/codex/hooks/general-guard.mjs"))).toBe(false);
    expect(
      existsSync(resolve(root, "agent-bundle/codex/hooks/guards/bash-policy-checks.mjs"))
    ).toBe(false);
  });
});
