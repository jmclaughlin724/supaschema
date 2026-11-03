import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROOT } from "../../../scripts/guards/lib/repository.mts";
import { check } from "../../../scripts/guards/repo-surface/check-public-repo-surface.mts";
import { tempGuardRepo } from "../fixture.js";

const privatePaths: { agentPrivate: string[]; heldPrivate: string[] } = JSON.parse(
  readFileSync(
    new URL("../../../scripts/guards/repo-surface/private-paths.json", import.meta.url),
    "utf8"
  )
);

describe("public repo surface guard", () => {
  it("allows agent runtime skill targets without a public-surface catalog", () => {
    const root = tempGuardRepo({
      ".agents/skills/elegant/SKILL.md": "# elegant\n",
    });
    expect(() => check(root)).not.toThrow();
  });

  it("allows reviewed source-repo hook runtime surfaces", () => {
    const root = tempGuardRepo({
      ".claude/hooks/context-pre-tool-use.mts": "export {};\n",
      ".claude/hooks/supaschema-source-hook.mts": "export {};\n",
      ".claude/rules/22-agent-surface-sync-ownership.md": "# Rule 22\n",
      ".claude/settings.json": "{}\n",
      ".codex/hooks/context-pre-tool-use.mts": "export {};\n",
      ".codex/hooks/supaschema-source-hook.mts": "export {};\n",
      ".codex/rules/22-agent-surface-sync-ownership.rules": "# Rule 22\n",
      "scripts/agent-hooks/runner.mts": "export {};\n",
    });
    expect(() => check(root)).not.toThrow();
  });

  it("blocks unignored private local paths before they can be staged", () => {
    const root = tempGuardRepo({
      "advisor-plans/local.md": "# local\n",
    });
    expect(() => check(root)).toThrow("unignored local files that could be staged");
  });

  it("blocks tracked private local paths with an untrack-only repair", () => {
    const root = tempGuardRepo({
      ".planning/roadmap.md": "# roadmap\n",
    });
    execFileSync("git", ["add", ".planning/roadmap.md"], {
      cwd: root,
      stdio: "ignore",
    });
    expect(() => check(root)).toThrow("tracked public GitHub exposure");
  });

  it("blocks the wired stripe catalog tooling left untracked on disk", () => {
    const root = tempGuardRepo({
      "scripts/stripe/create-catalog.mts": "export {};\n",
    });
    expect(() => check(root)).toThrow("wired maintainer tooling must be tracked");
  });

  it("allows the wired stripe catalog tooling once tracked", () => {
    const root = tempGuardRepo({
      "scripts/stripe/create-catalog.mts": "export {};\n",
    });
    execFileSync("git", ["add", "scripts/stripe/create-catalog.mts"], {
      cwd: root,
      stdio: "ignore",
    });
    expect(() => check(root)).not.toThrow();
  });

  it("keeps every canonical private prefix covered by .gitignore and wired prefixes clear", () => {
    const prefixes = [...privatePaths.heldPrivate, ...privatePaths.agentPrivate];
    expect(prefixes.length).toBeGreaterThan(0);
    for (const prefix of prefixes) {
      const probe = `${prefix}parity-probe`;
      expect(
        () => execFileSync("git", ["check-ignore", probe], { cwd: ROOT, stdio: "ignore" }),
        probe
      ).not.toThrow();
    }
    expect(privatePaths.heldPrivate).not.toContain("scripts/stripe/");
    expect(privatePaths.agentPrivate).not.toContain("scripts/stripe/");
    expect(() =>
      execFileSync("git", ["check-ignore", "scripts/stripe/create-catalog.mts"], {
        cwd: ROOT,
        stdio: "ignore",
      })
    ).toThrow();
  });

  it("blocks wired maintainer tooling left untracked on disk", () => {
    const root = tempGuardRepo({
      "services/agent-mcp/pyproject.toml": "[project]\n",
    });
    expect(() => check(root)).toThrow("wired maintainer tooling must be tracked");
  });

  it("blocks wired config files left untracked on disk", () => {
    const root = tempGuardRepo({
      "fastmcp.json": "{}\n",
    });
    expect(() => check(root)).toThrow("wired maintainer tooling must be tracked");
  });

  it("allows wired maintainer tooling once tracked", () => {
    const root = tempGuardRepo({
      "services/agent-mcp/pyproject.toml": "[project]\n",
      "fastmcp.json": "{}\n",
    });
    execFileSync("git", ["add", "services/agent-mcp/pyproject.toml", "fastmcp.json"], {
      cwd: root,
      stdio: "ignore",
    });
    expect(() => check(root)).not.toThrow();
  });

  it("blocks untracked helpers beneath a partially tracked wired prefix", () => {
    const root = tempGuardRepo({
      "services/agent-mcp/pyproject.toml": "[project]\n",
      "services/agent-mcp/helper.py": "x = 1\n",
    });
    execFileSync("git", ["add", "services/agent-mcp/pyproject.toml"], {
      cwd: root,
      stdio: "ignore",
    });
    expect(() => check(root)).toThrow("services/agent-mcp/helper.py");
  });

  it("blocks ignored non-artifact files beneath a wired prefix but allows artifacts", () => {
    const root = tempGuardRepo({
      ".gitignore": "services/agent-mcp/local-only.py\nservices/agent-mcp/.venv/\n",
      "services/agent-mcp/pyproject.toml": "[project]\n",
      "services/agent-mcp/local-only.py": "x = 1\n",
      "services/agent-mcp/.venv/lib/python3.12/site-packages/pkg.py": "x = 1\n",
    });
    execFileSync("git", ["add", "services/agent-mcp/pyproject.toml"], {
      cwd: root,
      stdio: "ignore",
    });
    expect(() => check(root)).toThrow("services/agent-mcp/local-only.py");
    expect(() => check(root)).not.toThrow("services/agent-mcp/.venv");
  });
});
