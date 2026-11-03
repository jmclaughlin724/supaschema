import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { bundleDocsFiles } from "../../scripts/skills/bundle-docs.mts";
import {
  publicSkillNames,
  renderSourceCodexHooks,
  syncAgentSurfaces,
} from "../../scripts/skills/sync-llm.mts";

const root = resolve(import.meta.dirname, "../..");
const claudeProjectDir = ["$", "{", "CLAUDE_PROJECT_DIR", "}"].join("");
const codexProjectDir = ["$(", "git rev-parse --show-toplevel", ")"].join("");
const editToolMatcher = "apply_patch";
const hookRuntimeSource = readFileSync(join(root, "scripts/agent-hooks/hook-runtime.mts"), "utf8");
const agentSurfaceManifestSource = readFileSync(
  join(root, "scripts/skills/agent-surface-manifest.mts"),
  "utf8"
);
const publicSupaschemaSkill = `---
name: supaschema
description: Maintain Supaschema workflows.
metadata:
  public: true
---

# Supaschema
`;
const curatedSkillSources = {
  ".claude/skills/supaschema/references/migrate.md": "migrate reference\n",
  ".claude/skills/supaschema/SKILL.md": publicSupaschemaSkill,
};

function tempSurface(files: Record<string, string | Uint8Array>): string {
  const root = mkdtempSync(join(tmpdir(), "supa-sync-llm-"));
  const sourceFiles = {
    "scripts/agent-hooks/hook-runtime.mts": hookRuntimeSource,
    "scripts/skills/agent-surface-manifest.mts": agentSurfaceManifestSource,
    ...curatedSkillSources,
    ...(Object.keys(files).some((file) => file.startsWith("docs/"))
      ? {}
      : { "docs/getting-started.mdx": "# Getting started\n" }),
    ...files,
  };
  for (const [file, source] of Object.entries(sourceFiles)) {
    mkdirSync(join(root, dirname(file)), { recursive: true });
    writeFileSync(join(root, file), source);
  }
  return root;
}

function read(root: string, file: string): string {
  return readFileSync(join(root, file), "utf8");
}

function claudeHookSourceFiles(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    ".claude/rules/12-skill-loading-enforcement.md": [
      "Source and inventory reads MUST NOT become verification evidence",
      "process.exitCode = 2",
      "",
    ].join("\n"),
    ".claude/settings.json": `${JSON.stringify(claudeHookSettings())}\n`,
    "AGENTS.md": "# Agents\n",
    "CLAUDE.md": "@AGENTS.md\n",
    "scripts/agent-hooks/command-evidence.mts": "domains.length === 0\n",
    "scripts/agent-hooks/response-evidence.mts":
      "exitCodeFromExecutionStatus isExecutionStatusLabel\n",
    "scripts/agent-hooks/runner.mts":
      "function responseShape() { return { block: detectorResult.contextParts.join('\\n') }; }\n",
    ...overrides,
  };
}

function claudeHookSettings() {
  return {
    hooks: {
      PostToolUse: [
        {
          hooks: [claudeNodeHook(".claude/hooks/context-post-tool-use.mts")],
          matcher: "Bash|Read|Skill",
        },
        {
          hooks: [claudeSupaschemaHook("schema-write")],
        },
      ],
      PostToolUseFailure: [
        {
          hooks: [claudeNodeHook(".claude/hooks/context-post-tool-use-failure.mts")],
          matcher: "Bash",
        },
      ],
      PreToolUse: [
        {
          hooks: [claudeNodeHook(".claude/hooks/context-pre-tool-use.mts")],
          matcher:
            "Agent|Bash|Edit|Glob|Grep|MultiEdit|NotebookEdit|Read|Task|WebFetch|WebSearch|Write|apply_patch",
        },
        {
          hooks: [claudeSupaschemaHook("generated-artifact-edit")],
          matcher: "Write|Edit|MultiEdit|apply_patch",
        },
      ],
      SessionEnd: [
        {
          hooks: [claudeNodeHook(".claude/hooks/context-session-end.mts")],
        },
      ],
      SessionStart: [
        {
          hooks: [claudeNodeHook(".claude/hooks/context-session-start.mts")],
        },
      ],
      SubagentStart: [
        {
          hooks: [claudeNodeHook(".claude/hooks/context-subagent-start.mts")],
        },
      ],
      TaskCompleted: [
        {
          hooks: [claudeNodeHook(".claude/hooks/context-task-completed.mts")],
        },
      ],
      Stop: [
        {
          hooks: [claudeNodeHook(".claude/hooks/context-stop.mts")],
        },
      ],
      SubagentStop: [
        {
          hooks: [claudeNodeHook(".claude/hooks/context-subagent-stop.mts")],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [claudeNodeHook(".claude/hooks/context-user-prompt-submit.mts")],
        },
      ],
    },
  };
}

function claudeNodeHook(relativePath: string) {
  return {
    args: [`${claudeProjectDir}/${relativePath}`],
    command: "node",
    statusMessage: `Running ${relativePath}`,
    type: "command",
  };
}

function claudeSupaschemaHook(command: string) {
  return {
    args: [`${claudeProjectDir}/.claude/hooks/supaschema-source-hook.mts`, "hook", command],
    command: "node",
    statusMessage: `Running supaschema hook ${command}`,
    type: "command",
  };
}

describe("sync:llm", () => {
  it("builds a sorted byte-exact MDX bundle and excludes non-MDX sources", () => {
    const nestedBytes = Buffer.from([0x23, 0x20, 0x41, 0x0d, 0x0a, 0x00, 0xff]);
    const root = tempSurface({
      "docs/.cache/hidden.mdx": "# Hidden\n",
      "docs/a/first.mdx": nestedBytes,
      "docs/docs.json": "{}\n",
      "docs/image.svg": "<svg />\n",
      "docs/node_modules/some-dep/README.mdx": "# Dependency\n",
      "docs/z-last.mdx": "# Z\n",
    });

    const files = bundleDocsFiles(root);

    expect(files.get("docs/a/first.mdx")).toEqual(nestedBytes);
    expect(files.get("docs/z-last.mdx")).toEqual(Buffer.from("# Z\n"));
    expect(files.has("docs/docs.json")).toBe(false);
    expect(files.has("docs/image.svg")).toBe(false);
    expect(files.has("docs/node_modules/some-dep/README.mdx")).toBe(false);
    expect(files.has("docs/.cache/hidden.mdx")).toBe(false);
    expect(files.get("docs/index.md")?.toString("utf8")).toBe(
      [
        "# Supaschema Documentation",
        "",
        "- [agent-bundle/docs/a/first.mdx](https://supaschema.com/docs/a/first)",
        "- [agent-bundle/docs/z-last.mdx](https://supaschema.com/docs/z-last)",
        "",
      ].join("\n")
    );
  });

  it("mirrors private Claude surfaces locally and keeps public skills narrow", {
    timeout: 15_000,
  }, () => {
    const root = tempSurface({
      ".agents/prompts/supaschema-install.md": "# Install\n",
      ".agents/skills/stale/SKILL.md": "# stale\n",
      ".claude/agents/ci-debugger.md": [
        "---",
        "name: ci-debugger",
        "description: Debug CI failures.",
        "tools: Read, Write",
        "---",
        "",
        "# CI Debugger",
        "",
        "Fix CI failures.",
        "",
      ].join("\n"),
      ".claude/hooks/context-pre-tool-use.mts": "process.stdout.write('pre');\n",
      ".claude/hooks/guards/bash-policy-checks.mts": "export {};\n",
      ".claude/hooks/supaschema-source-hook.mts": "export {};\n",
      ".claude/rules/21-source-control.md": [
        "---",
        "description: Source control process.",
        "---",
        "",
        "# Rule 21",
        "",
        "Protected pull requests are required for main.",
        "",
      ].join("\n"),
      ".claude/rules/supaschema.md": "# Supaschema rule\n",
      ".claude/skills/elegant/SKILL.md": "# elegant\n",
      ".claude/skills/supaschema/SKILL.md": publicSupaschemaSkill,
      ".codex/agents/stale.toml": 'name = "stale"\n',
      ".codex/hooks.json": `${JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              hooks: [
                {
                  command: `node "${codexProjectDir}/.codex/hooks/context-post-tool-use.mts"`,
                  type: "command",
                },
              ],
              matcher: "Bash",
            },
            {
              hooks: [
                {
                  command: `node "${codexProjectDir}/.codex/hooks/supaschema-source-hook.mts" hook schema-write`,
                  type: "command",
                },
              ],
              matcher: editToolMatcher,
            },
          ],
          PreToolUse: [
            {
              hooks: [
                {
                  command: `node "${codexProjectDir}/.codex/hooks/context-pre-tool-use.mts"`,
                  type: "command",
                },
                {
                  command: `node "${codexProjectDir}/.codex/hooks/general-guard.mjs"`,
                  type: "command",
                },
              ],
              matcher: "Bash",
            },
            {
              hooks: [
                {
                  command: `node "${codexProjectDir}/.codex/hooks/supaschema-source-hook.mts" hook generated-artifact-edit --runtime codex`,
                  type: "command",
                },
              ],
              matcher: editToolMatcher,
            },
          ],
          UserPromptSubmit: [
            {
              hooks: [
                {
                  command: `node "${codexProjectDir}/.codex/hooks/context-user-prompt-submit.mts"`,
                  type: "command",
                },
              ],
            },
          ],
        },
      })}\n`,
      ".codex/hooks/general-guard.mjs": "process.stdout.write('native');\n",
      ".codex/hooks/stale.mjs": "process.stdout.write('stale');\n",
      ".codex/rules/stale.rules": "# stale\n",
      "agent-bundle/INSTALL.md": "# Agent bundle install\n",
      "agent-bundle/claude/hooks/sync-llm-on-claude-surface-change.mjs": "stale\n",
      "agent-bundle/codex/hooks/sync-llm-on-claude-surface-change.mjs": "stale\n",
      "skills/README.md": "# Public skills\n",
      "skills/stale/SKILL.md": "# stale\n",
    });

    const result = syncAgentSurfaces({ root });

    expect(result).toMatchObject({
      agentBundle: 19,
      agents: 1,
      codexHookConfig: 1,
      hooks: 3,
      publicSkills: 2,
      rules: 2,
      skills: 3,
      skillTargets: 1,
    });
    expect(read(root, ".codex/rules/21-source-control.rules")).toContain(
      "Canonical rule owner: .claude/rules/21-source-control.md"
    );
    expect(read(root, ".codex/rules/21-source-control.rules")).not.toContain(
      "Protected pull requests are required for main."
    );
    expect(read(root, ".codex/agents/ci-debugger.toml")).toContain(
      'sandbox_mode = "workspace-write"'
    );
    expect(read(root, ".codex/hooks/context-pre-tool-use.mts")).toBe(
      "process.stdout.write('pre');\n"
    );
    expect(existsSync(join(root, ".codex/hooks/general-guard.mjs"))).toBe(false);
    expect(read(root, "agent-bundle/codex/hooks.npm.json")).not.toContain("general-guard.mjs");
    expect(read(root, "agent-bundle/codex/hooks.npm.json")).not.toContain("bash-policy-checks.mts");
    expect(read(root, "agent-bundle/codex/hooks.npm.json")).toContain(
      "npm exec -- supaschema hook generated-artifact-edit --runtime codex"
    );
    expect(read(root, "agent-bundle/codex/hooks.npm.json")).toContain(
      "npm exec -- supaschema hook schema-write"
    );
    expect(read(root, "agent-bundle/claude/settings.bun.json")).toContain(
      '"command": "./node_modules/.bin/supaschema hook schema-write"'
    );
    expect(read(root, "agent-bundle/claude/settings.npm.json")).toContain(
      '"statusMessage": "Running supaschema auto-diff on schema change"'
    );
    expect(read(root, "agent-bundle/claude/settings.npm.json")).not.toContain(
      "bash-policy-checks.mts"
    );
    expect(read(root, "agent-bundle/codex/hooks.bun.json")).toContain(
      "./node_modules/.bin/supaschema hook generated-artifact-edit --runtime codex"
    );
    expect(read(root, "agent-bundle/codex/hooks.bun.json")).not.toContain(
      "bunx --no-install supaschema"
    );
    expect(read(root, "agent-bundle/codex/hooks.npm.json")).not.toContain("/bin/");
    expect(read(root, "agent-bundle/codex/hooks.npm.json")).not.toContain(
      "supaschema-source-hook.mts"
    );
    expect(read(root, "agent-bundle/codex/hooks.npm.json")).not.toContain("context-");
    expect(read(root, "agent-bundle/codex/hooks.npm.json")).not.toContain("scripts/agent-hooks");
    expect(read(root, "agent-bundle/codex/hooks.npm.json")).not.toContain(
      "sync-llm-on-claude-surface-change.mjs"
    );
    expect(read(root, "agent-bundle/claude/settings.npm.json")).not.toContain(
      "sync-llm-on-claude-surface-change.mjs"
    );
    expect(
      existsSync(join(root, "agent-bundle/claude/hooks/sync-llm-on-claude-surface-change.mjs"))
    ).toBe(false);
    expect(existsSync(join(root, "agent-bundle/claude/hooks/guards/bash-policy-checks.mts"))).toBe(
      false
    );
    expect(
      existsSync(join(root, "agent-bundle/codex/hooks/sync-llm-on-claude-surface-change.mjs"))
    ).toBe(false);
    expect(existsSync(join(root, "agent-bundle/codex/hooks/general-guard.mjs"))).toBe(false);
    expect(existsSync(join(root, "agent-bundle/codex/hooks/guards/bash-policy-checks.mts"))).toBe(
      false
    );
    expect(read(root, ".codex/hooks.json")).toContain("context-session-start.mts");
    expect(read(root, ".codex/hooks.json")).toContain("context-session-end.mts");
    expect(read(root, ".codex/hooks.json")).toContain("Refreshing agent hook state");
    expect(read(root, ".codex/hooks.json")).not.toContain("Loading supaschema agent context");
    expect(read(root, ".codex/hooks.json")).toContain("context-pre-tool-use.mts");
    expect(read(root, ".codex/hooks.json")).not.toContain("general-guard.mjs");
    expect(read(root, ".codex/hooks.json")).toContain("context-stop.mts");
    expect(read(root, ".codex/hooks.json")).not.toContain("sync-llm-on-claude-surface-change.mjs");
    expect(read(root, ".codex/hooks.json")).toContain("$(git rev-parse --show-toplevel)");
    expect(read(root, ".codex/hooks.json")).toContain('"commandWindows"');
    expect(read(root, ".codex/hooks.json")).toContain(
      `for /f \\"delims=\\" %S in ('git rev-parse --show-toplevel') do @node`
    );
    expect(read(root, ".codex/hooks.json")).not.toContain("CODEX_PROJECT_DIR");
    expect(read(root, ".agents/skills/elegant/SKILL.md")).toBe("# elegant\n");
    expect(read(root, "skills/supaschema/SKILL.md")).toBe(publicSupaschemaSkill);
    expect(read(root, "skills/supaschema/references/migrate.md")).toBe("migrate reference\n");
    expect(read(root, "agent-bundle/claude/skills/supaschema/references/migrate.md")).toBe(
      "migrate reference\n"
    );
    expect(JSON.parse(read(root, "agent-bundle/skills-manifest.json"))).toEqual({
      skills: publicSkillNames(root),
    });
    expect(read(root, "skills/README.md")).toBe("# Public skills\n");
    expect(existsSync(join(root, "skills/elegant/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, ".codex/skills"))).toBe(false);
    expect(existsSync(join(root, ".codex/rules/stale.rules"))).toBe(false);
  });

  it("allows public clean checkouts without private Claude agents", () => {
    const root = tempSurface({
      ".agents/prompts/supaschema-install.md": "# Install\n",
      ".claude/hooks/guards/bash-policy-checks.mts": "export {};\n",
      ".claude/hooks/supaschema-source-hook.mts": "export {};\n",
      ".claude/rules/supaschema.md": "# Supaschema rule\n",
      ".claude/skills/supaschema/SKILL.md": publicSupaschemaSkill,
      ".codex/agents/stale.toml": 'name = "stale"\n',
      ".codex/hooks.json": `${JSON.stringify({ hooks: {} })}\n`,
      ".codex/hooks/general-guard.mjs": "process.stdout.write('native');\n",
      "agent-bundle/INSTALL.md": "# Agent bundle install\n",
    });

    const result = syncAgentSurfaces({ root });

    expect(result.agents).toBe(0);
    expect(existsSync(join(root, ".codex/agents/stale.toml"))).toBe(false);
    expect(existsSync(join(root, ".codex/hooks/general-guard.mjs"))).toBe(false);
  });

  it("preserves git-ignored local overlays inside generated targets", () => {
    const root = tempSurface({
      ".agents/prompts/supaschema-install.md": "# Install\n",
      ".agents/skills/local/SKILL.md": "# personal overlay\n",
      ".claude/hooks/guards/bash-policy-checks.mts": "export {};\n",
      ".claude/hooks/supaschema-source-hook.mts": "export {};\n",
      ".claude/rules/supaschema.md": "# Supaschema rule\n",
      ".claude/skills/supaschema/SKILL.md": publicSupaschemaSkill,
      ".codex/agents/stale.toml": 'name = "stale"\n',
      ".codex/hooks.json": `${JSON.stringify({ hooks: {} })}\n`,
      ".codex/hooks/local.mjs": "export const local = true;\n",
      ".gitignore": ".agents/skills/local/\n.codex/hooks/local.mjs\n",
      "agent-bundle/INSTALL.md": "# Agent bundle install\n",
    });
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });

    syncAgentSurfaces({ root });

    expect(read(root, ".agents/skills/local/SKILL.md")).toBe("# personal overlay\n");
    expect(read(root, ".codex/hooks/local.mjs")).toBe("export const local = true;\n");
    expect(existsSync(join(root, ".codex/agents/stale.toml"))).toBe(false);
  });

  it("blocks Codex hook rendering when present Claude hook registration is incomplete", () => {
    const root = tempSurface({
      ...claudeHookSourceFiles(),
      ".claude/settings.json": `${JSON.stringify({ hooks: { Stop: [] } })}\n`,
    });

    expect(() => renderSourceCodexHooks(root)).toThrow(
      ".claude/settings.json missing SessionStart hooks"
    );
  });

  it("blocks Codex hook rendering when source Claude registers duplicate Bash safety", () => {
    const settings = claudeHookSettings();
    settings.hooks.PreToolUse = [
      ...settings.hooks.PreToolUse,
      {
        hooks: [claudeNodeHook(".claude/hooks/guards/bash-policy-checks.mts")],
        matcher: "Bash",
      },
    ];
    const root = tempSurface({
      ...claudeHookSourceFiles(),
      ".claude/settings.json": `${JSON.stringify(settings)}\n`,
    });

    expect(() => renderSourceCodexHooks(root)).toThrow(
      ".claude/settings.json must not register a direct source Claude Bash guard"
    );
  });

  it("blocks Codex hook rendering when Claude does not import the repo contract", () => {
    const root = tempSurface(claudeHookSourceFiles({ "CLAUDE.md": "# Claude\n" }));

    expect(() => renderSourceCodexHooks(root)).toThrow(
      "CLAUDE.md must import @AGENTS.md so Claude receives the repo contract"
    );
  });
});
