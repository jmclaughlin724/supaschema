import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderCodexAgent, renderCodexRule } from "../../scripts/skills/codex-rules.mts";
import { publicSkillNames, syncAgentSurfaces } from "../../scripts/skills/sync-llm.mts";

const publicSupaschemaSkill = `---
name: supaschema
description: Maintain Supaschema workflows.
metadata:
  public: true
---

# Supaschema
`;

describe("agent surface sync", { timeout: 30_000 }, () => {
  it("runs idempotently when generated mirrors already match", async () => {
    const root = await seedSurfaceRoot();
    const first = syncAgentSurfaces({ root });
    const second = syncAgentSurfaces({ root });

    expect(second).toEqual(first);
  });

  it("repairs missing, drifted, and unmanaged mirror files", async () => {
    const root = await seedSurfaceRoot();
    syncAgentSurfaces({ root });
    await rm(join(root, ".agents/skills/supaschema/SKILL.md"));
    await write(root, ".agents/skills/supaschema/extra.md", "extra\n");
    await write(root, ".agents/skills/upstream/SKILL.md", "drift\n");

    syncAgentSurfaces({ root });

    expect(await readFile(join(root, ".agents/skills/supaschema/SKILL.md"), "utf8")).toBe(
      publicSupaschemaSkill
    );
    expect(existsSync(join(root, ".agents/skills/supaschema/extra.md"))).toBe(false);
    expect(await readFile(join(root, ".agents/skills/upstream/SKILL.md"), "utf8")).toBe(
      "upstream skill\n"
    );
  });

  it("rewrites skills, hooks, Codex agents, and Codex rules from Claude sources", async () => {
    const root = await seedSurfaceRoot();
    syncAgentSurfaces({ root });
    await write(root, ".agents/skills/upstream/extra.md", "extra\n");
    await write(root, ".codex/hooks/stale.mjs", "stale\n");
    await write(root, ".codex/agents/stale.toml", 'name = "stale"\n');
    await write(root, ".codex/rules/stale.rules", "# stale\n");
    await write(root, "skills/supaschema/stale.md", "stale\n");

    const result = syncAgentSurfaces({ root });

    expect(result).toMatchObject({
      agentBundle: 21,
      agents: 2,
      codexHookConfig: 1,
      hooks: 4,
      publicSkills: 3,
      rules: 2,
      skills: 4,
      skillTargets: 1,
    });
    expect(existsSync(join(root, ".agents/skills/upstream/extra.md"))).toBe(false);
    expect(existsSync(join(root, ".codex/hooks/stale.mjs"))).toBe(false);
    expect(existsSync(join(root, ".codex/agents/stale.toml"))).toBe(false);
    expect(existsSync(join(root, ".codex/rules/stale.rules"))).toBe(false);
    expect(existsSync(join(root, "skills/supaschema/stale.md"))).toBe(false);
    expect(await readFile(join(root, "skills/supaschema/SKILL.md"), "utf8")).toBe(
      publicSupaschemaSkill
    );
    expect(await readFile(join(root, "skills/supaschema/references/maintain.md"), "utf8")).toBe(
      "maintain reference\n"
    );
    expect(
      JSON.parse(await readFile(join(root, "agent-bundle/skills-manifest.json"), "utf8"))
    ).toEqual({ skills: publicSkillNames(root) });
    expect(await readFile(join(root, ".codex/hooks/sample-hook.mjs"), "utf8")).toBe(
      await readFile(join(root, ".claude/hooks/sample-hook.mjs"), "utf8")
    );
    expect(await readFile(join(root, ".codex/agents/database.toml"), "utf8")).toContain(
      'name = "database"'
    );
    expect(await readFile(join(root, ".codex/rules/supaschema.rules"), "utf8")).toContain(
      "Canonical rule owner: .claude/rules/supaschema.md"
    );
  });

  it("repairs documentation updates, additions, renames, removals, and unmanaged files", async () => {
    const root = await seedSurfaceRoot();
    const originalBytes = Buffer.from([0x23, 0x20, 0x47, 0x75, 0x69, 0x64, 0x65, 0x0d, 0x0a]);
    await write(root, "docs/guide.mdx", originalBytes);
    await write(root, "docs/image.png", "not an image fixture\n");

    syncAgentSurfaces({ root });

    expect(await readFile(join(root, "agent-bundle/docs/guide.mdx"))).toEqual(originalBytes);
    expect(existsSync(join(root, "agent-bundle/docs/image.png"))).toBe(false);

    await write(root, "docs/guide.mdx", "# Updated guide\n");
    syncAgentSurfaces({ root });
    expect(await readFile(join(root, "agent-bundle/docs/guide.mdx"), "utf8")).toBe(
      "# Updated guide\n"
    );

    await rm(join(root, "docs/guide.mdx"));
    await rm(join(root, "docs/start.mdx"));
    await write(root, "docs/a-added.mdx", "# Added\n");
    await write(root, "docs/nested/renamed.mdx", "# Renamed\n");
    await write(root, "agent-bundle/docs/stale.mdx", "# Stale\n");

    syncAgentSurfaces({ root });

    expect(existsSync(join(root, "agent-bundle/docs/guide.mdx"))).toBe(false);
    expect(existsSync(join(root, "agent-bundle/docs/start.mdx"))).toBe(false);
    expect(existsSync(join(root, "agent-bundle/docs/stale.mdx"))).toBe(false);
    expect(existsSync(join(root, "agent-bundle/docs/a-added.mdx"))).toBe(true);
    expect(existsSync(join(root, "agent-bundle/docs/nested/renamed.mdx"))).toBe(true);
    const indexEntries = (await readFile(join(root, "agent-bundle/docs/index.md"), "utf8"))
      .split("\n")
      .filter((line) => line.startsWith("- ["));
    expect(indexEntries).toEqual(
      [...indexEntries].sort((left, right) => Number(left > right) - Number(left < right))
    );
  });

  it("repairs generated Codex hook config drift", async () => {
    const root = await seedSurfaceRoot();
    syncAgentSurfaces({ root });
    await write(root, ".codex/hooks.json", `${JSON.stringify({ hooks: { Stop: [] } }, null, 2)}\n`);

    const result = syncAgentSurfaces({ root });

    expect(result.codexHookConfig).toBe(1);
    expect(await readFile(join(root, ".codex/hooks.json"), "utf8")).toContain("context-stop.mts");
  });

  it("reconciles minimal Claude source directories into generated mirrors", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-agent-surfaces-empty-"));
    await seedRequiredAgentBundleInputs(root);
    await mkdir(join(root, ".claude/agents"), { recursive: true });

    const result = syncAgentSurfaces({ root });

    expect(result).toMatchObject({
      agentBundle: 19,
      agents: 0,
      codexHookConfig: 1,
      hooks: 2,
      publicSkills: 2,
      rules: 1,
      skills: 2,
      skillTargets: 1,
    });
    expect(existsSync(join(root, ".agents/skills"))).toBe(true);
    expect(existsSync(join(root, ".codex/skills"))).toBe(false);
    expect(existsSync(join(root, "skills/supaschema"))).toBe(true);
    expect(existsSync(join(root, ".codex/hooks"))).toBe(true);
    expect(existsSync(join(root, ".codex/agents"))).toBe(true);
    expect(existsSync(join(root, ".codex/rules"))).toBe(true);
  });

  it("rejects pre-existing temp-file symlinks while syncing mirrors", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await seedSurfaceRoot();
    const targetDir = join(root, ".agents/skills/supaschema");
    await mkdir(targetDir, { recursive: true });
    const sentinel = join(root, "sentinel.txt");
    await writeFile(sentinel, "keep\n");

    const timestamp = 1_234_567_890;
    const tempCandidate = join(targetDir, `.SKILL.md.${process.pid}.${timestamp}.tmp`);
    await symlink(sentinel, tempCandidate);

    expect(() => syncAgentSurfaces({ root })).toThrow(
      `.agents/skills/supaschema/.SKILL.md.${process.pid}.${timestamp}.tmp: symbolic links are not allowed`
    );

    expect(await readFile(sentinel, "utf8")).toBe("keep\n");
    expect(existsSync(join(targetDir, "SKILL.md"))).toBe(false);
  });

  it("rejects generated target-root symlinks before writing outside the repository", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await seedSurfaceRoot();
    const outside = await mkdtemp(join(tmpdir(), "supa-agent-target-outside-"));
    await write(outside, "sentinel.txt", "keep\n");
    await symlink(outside, join(root, ".agents/skills"), "dir");

    expect(() => syncAgentSurfaces({ root })).toThrow(
      ".agents/skills: symbolic links are not allowed"
    );
    expect(await readFile(join(outside, "sentinel.txt"), "utf8")).toBe("keep\n");
    expect(existsSync(join(outside, "supaschema/SKILL.md"))).toBe(false);
  });

  it("rejects source-root symlinks before copying external files", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await seedSurfaceRoot();
    const outside = await mkdtemp(join(tmpdir(), "supa-agent-source-outside-"));
    await write(outside, "supaschema/SKILL.md", publicSupaschemaSkill);
    await rm(join(root, ".claude/skills"), { recursive: true });
    await symlink(outside, join(root, ".claude/skills"), "dir");

    expect(() => syncAgentSurfaces({ root })).toThrow(
      ".claude/skills: symbolic links are not allowed"
    );
    expect(existsSync(join(root, ".agents/skills/supaschema/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, "skills/supaschema/SKILL.md"))).toBe(false);
  });

  it("rejects nested source symlinks before reading their targets", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await seedSurfaceRoot();
    const outside = await mkdtemp(join(tmpdir(), "supa-agent-nested-source-outside-"));
    const sentinel = join(outside, "sentinel.mjs");
    await writeFile(sentinel, "external secret\n");
    await rm(join(root, ".claude/hooks/sample-hook.mjs"));
    await symlink(sentinel, join(root, ".claude/hooks/sample-hook.mjs"));

    expect(() => syncAgentSurfaces({ root })).toThrow(
      ".claude/hooks/sample-hook.mjs: symbolic links are not allowed"
    );
    expect(existsSync(join(root, ".codex/hooks/sample-hook.mjs"))).toBe(false);
  });

  it("rejects exact source-file symlinks before reading their targets", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await seedSurfaceRoot();
    const outside = await mkdtemp(join(tmpdir(), "supa-agent-source-file-outside-"));
    const sentinel = join(outside, "install.md");
    await writeFile(sentinel, "external install prompt\n");
    await rm(join(root, ".agents/prompts/supaschema-install.md"));
    await symlink(sentinel, join(root, ".agents/prompts/supaschema-install.md"));

    expect(() => syncAgentSurfaces({ root })).toThrow(
      ".agents/prompts/supaschema-install.md: symbolic links are not allowed"
    );
    expect(existsSync(join(root, "agent-bundle/agents/prompts/supaschema-install.md"))).toBe(false);
  });

  it("rejects nested generated file symlinks instead of reading their targets", async () => {
    if (process.platform === "win32") {
      return;
    }

    const root = await seedSurfaceRoot();
    const outside = await mkdtemp(join(tmpdir(), "supa-agent-file-outside-"));
    const sentinel = join(outside, "sentinel.mjs");
    await writeFile(sentinel, "keep\n");
    await mkdir(join(root, ".codex/hooks"), { recursive: true });
    await symlink(sentinel, join(root, ".codex/hooks/sample-hook.mjs"));

    expect(() => syncAgentSurfaces({ root })).toThrow(
      ".codex/hooks/sample-hook.mjs: symbolic links are not allowed"
    );
    expect(await readFile(sentinel, "utf8")).toBe("keep\n");
  });

  it("renders Claude agents as Codex custom-agent TOML", () => {
    const rendered = renderCodexAgent(
      `---
name: code-reviewer
description: |
  Review code for correctness.
tools: Read, Grep, Glob, Bash
---

# Code Reviewer

Review like an owner.
`,
      ".claude/agents/code-reviewer.md"
    );

    expect(rendered).toContain('name = "code-reviewer"');
    expect(rendered).toContain('description = "Review code for correctness."');
    expect(rendered).toContain('sandbox_mode = "read-only"');
    expect(rendered).toContain(
      'developer_instructions = "# Code Reviewer\\n\\nReview like an owner."'
    );
  });

  it("renders wildcard Claude agents as writable Codex custom agents", () => {
    const rendered = renderCodexAgent(
      `---
name: worker
description: Execute autonomous worker tasks.
tools: "*"
---

Work directly.
`,
      ".claude/agents/worker.md"
    );

    expect(rendered).toContain('sandbox_mode = "workspace-write"');
  });

  it("renders Claude rule command policy as Codex prefix rules", () => {
    const rendered = renderCodexRule(
      `---
codexExecPolicy: |
  [
    {
      "pattern": ["git", "checkout"],
      "decision": "forbidden",
      "justification": "Use git switch instead.",
      "match": ["git checkout main"],
      "not_match": ["git switch main"]
    }
  ]
---

# Supaschema Rule

- Keep migrations replay-safe.
`,
      ".claude/rules/supaschema.md"
    );

    expect(rendered).toContain("# Generated by npm run sync:llm from .claude/rules/supaschema.md.");
    expect(rendered).toContain('pattern = ["git", "checkout"]');
    expect(rendered).toContain('decision = "forbidden"');
    expect(rendered).toContain('match = ["git checkout main"]');
    expect(rendered).not.toContain("# - Keep migrations replay-safe.");
  });
});

async function seedSurfaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "supa-agent-surfaces-"));
  await seedRequiredAgentBundleInputs(root);
  await write(root, ".claude/skills/supaschema/references/workflow.md", "workflow\n");
  await write(root, ".claude/skills/upstream/SKILL.md", "upstream skill\n");
  await write(root, ".claude/hooks/sample-hook.mjs", "sample hook\n");
  await write(root, ".claude/hooks/sample-hook-extra.mjs", "sample hook extra\n");
  await write(root, ".claude/rules/operating.md", "# Operating Rule\n");
  await write(
    root,
    ".claude/agents/database.md",
    `---
name: database
description: Database agent
tools: Read, Write, Edit, Grep, Glob, Bash
---

# Database

Work on database behavior.
`
  );
  await write(
    root,
    ".claude/agents/code-reviewer.md",
    `---
name: code-reviewer
description: Review code
tools: Read, Grep, Glob, Bash
---

# Code Reviewer

Review code.
`
  );
  return root;
}

async function seedRequiredAgentBundleInputs(root: string): Promise<void> {
  await write(root, "docs/start.mdx", "# Start\n");
  await write(root, "agent-bundle/INSTALL.md", "install\n");
  await write(root, ".agents/prompts/supaschema-install.md", "install prompt\n");
  await write(root, ".claude/skills/supaschema/references/maintain.md", "maintain reference\n");
  await write(root, ".claude/skills/supaschema/SKILL.md", publicSupaschemaSkill);
  await write(root, ".claude/hooks/guards/bash-policy-checks.mts", "bash guard\n");
  await write(root, ".claude/hooks/sync-llm-on-claude-surface-change.mjs", "sync hook\n");
  await write(root, ".claude/rules/supaschema.md", "# Supaschema Rule\n");
  await write(root, ".codex/hooks.json", "{}\n");
}

async function write(
  root: string,
  relativePath: string,
  content: string | Uint8Array
): Promise<void> {
  const file = join(root, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}
