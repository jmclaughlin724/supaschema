import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = process.cwd();
const originalStateDir = process.env.STATE_DIR;
const governedToolMatcher =
  "Agent|Bash|Edit|Glob|Grep|MultiEdit|NotebookEdit|Read|Task|WebFetch|WebSearch|Write|apply_patch";

afterEach(() => {
  if (originalStateDir === undefined) {
    delete process.env.STATE_DIR;
  } else {
    process.env.STATE_DIR = originalStateDir;
  }
});

describe("registered hook topology", () => {
  it("registers only the retained Claude events and exact matchers", async () => {
    const settings = JSON.parse(await readFile(join(root, ".claude/settings.json"), "utf8"));

    expect(
      Object.keys(settings.hooks).sort((left, right) => Number(left > right) - Number(left < right))
    ).toEqual(
      [
        "PostToolUse",
        "PostToolUseFailure",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "SubagentStart",
        "SubagentStop",
        "TaskCompleted",
        "UserPromptSubmit",
      ].sort((left, right) => Number(left > right) - Number(left < right))
    );
    expect(settings.hooks.WorktreeCreate).toBeUndefined();
    expect(matcherFor(settings, "PreToolUse", "context-pre-tool-use.mts")).toBe(
      governedToolMatcher
    );
    expect(matcherFor(settings, "PostToolUse", "context-post-tool-use.mts")).toBe(
      "Bash|Read|Skill"
    );
    expect(matcherFor(settings, "PostToolUseFailure", "context-post-tool-use-failure.mts")).toBe(
      "Bash"
    );
    expect(matcherFor(settings, "PreToolUse", "generated-artifact-edit")).toBe(
      "Write|Edit|MultiEdit|apply_patch"
    );
    expect(matcherFor(settings, "PostToolUse", "hook schema-write")).toBe(
      "Write|Edit|MultiEdit|apply_patch"
    );
    expect(JSON.stringify(settings.hooks.PostToolUse)).not.toContain("sync-llm");
    expect(JSON.stringify(settings.hooks.TaskCompleted)).toContain("context-task-completed.mts");
    expect(JSON.stringify(settings.hooks.PostToolUseFailure)).not.toContain("sync-llm");
    expect(JSON.stringify(settings.hooks.Stop)).not.toContain("sync-llm");
  });

  it("keeps Codex context hooks but omits Claude-only failure and completion events", async () => {
    const config = JSON.parse(await readFile(join(root, ".codex/hooks.json"), "utf8"));

    expect(
      Object.keys(config.hooks).sort((left, right) => Number(left > right) - Number(left < right))
    ).toEqual(
      [
        "PostToolUse",
        "PreToolUse",
        "SessionEnd",
        "SessionStart",
        "Stop",
        "SubagentStart",
        "SubagentStop",
        "UserPromptSubmit",
      ].sort((left, right) => Number(left > right) - Number(left < right))
    );
    expect(config.hooks.PostToolUseFailure).toBeUndefined();
    expect(config.hooks.TaskCompleted).toBeUndefined();
    expect(config.hooks.WorktreeCreate).toBeUndefined();
    expect(matcherFor(config, "PreToolUse", "context-pre-tool-use.mts")).toBe(governedToolMatcher);
    expect(matcherFor(config, "PostToolUse", "context-post-tool-use.mts")).toBe("Bash|Read|Skill");
    expect(matcherFor(config, "PreToolUse", "generated-artifact-edit")).toBe("apply_patch");
    expect(matcherFor(config, "PostToolUse", "hook schema-write")).toBe("apply_patch");
    expect(JSON.stringify(config.hooks.PostToolUse)).not.toContain("sync-llm");
    expect(JSON.stringify(config)).not.toContain("CODEX_PROJECT_DIR");
    expect(JSON.stringify(config)).toContain("git rev-parse --show-toplevel");
  });

  it("keeps every consumer template to exactly the two product hooks", async () => {
    for (const packageManager of ["npm", "pnpm", "yarn", "bun"]) {
      const claude = JSON.parse(
        await readFile(join(root, `agent-bundle/claude/settings.${packageManager}.json`), "utf8")
      );
      const codex = JSON.parse(
        await readFile(join(root, `agent-bundle/codex/hooks.${packageManager}.json`), "utf8")
      );

      expect(hookHandlers(claude)).toHaveLength(2);
      expect(
        Object.keys(claude.hooks).sort((left, right) => Number(left > right) - Number(left < right))
      ).toEqual(["PostToolUse", "PreToolUse"]);
      expect(matcherFor(claude, "PreToolUse", "generated-artifact-edit")).toBe(
        "Write|Edit|MultiEdit|apply_patch"
      );
      expect(matcherFor(claude, "PostToolUse", "schema-write")).toBe(
        "Write|Edit|MultiEdit|apply_patch"
      );
      expect(JSON.stringify(claude)).not.toContain("context-");
      expect(JSON.stringify(claude)).not.toContain("sync-llm");

      expect(hookHandlers(codex)).toHaveLength(2);
      expect(
        Object.keys(codex.hooks).sort((left, right) => Number(left > right) - Number(left < right))
      ).toEqual(["PostToolUse", "PreToolUse"]);
      expect(matcherFor(codex, "PreToolUse", "generated-artifact-edit")).toBe("apply_patch");
      expect(matcherFor(codex, "PostToolUse", "schema-write")).toBe("apply_patch");
      expect(JSON.stringify(codex)).not.toContain("context-");
      expect(JSON.stringify(codex)).not.toContain("sync-llm");
    }
  });

  it("has no check-only surface sync command", async () => {
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const generator = await readFile(join(root, "scripts/skills/sync-llm.mts"), "utf8");

    expect(Object.keys(manifest.scripts).filter((name) => name.startsWith("sync:llm"))).toEqual([
      "sync:llm",
    ]);
    expect(manifest.scripts["guard:agent"]).toContain("npm run sync:llm");
    expect(generator).not.toContain('"--check"');
  });
});

describe("actual context hook entrypoints", () => {
  it("allows Git but blocks positive Bash safety matches through a Claude runtime", {
    timeout: 20_000,
  }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "supa-hook-runtime-state-"));
    const hook = join(root, ".claude", "hooks", "context-pre-tool-use.mts");
    const env = hookEnvironment("claude", { STATE_DIR: stateDir });

    const git = await runHook(
      hook,
      {
        hook_event_name: "PreToolUse",
        session_id: "claude-git",
        tool_input: { command: "git reset --hard HEAD" },
        tool_name: "Bash",
      },
      env
    );
    expect(git.code).toBe(0);
    expect(hookOutput(git.stdout).hookSpecificOutput?.permissionDecision).toBeUndefined();

    const unsafe = await runHook(
      hook,
      {
        hook_event_name: "PreToolUse",
        session_id: "claude-secret",
        tool_input: { command: "cat .env" },
        tool_name: "Bash",
      },
      env
    );
    expect(unsafe.code).toBe(0);
    expect(hookOutput(unsafe.stdout).hookSpecificOutput).toMatchObject({
      permissionDecision: "deny",
      permissionDecisionReason: expect.stringContaining("secret-bearing file"),
    });
  });

  it.each([".claude", ".codex"])(
    "makes every already-loaded Codex hook family inert through %s wrappers",
    { timeout: 20_000 },
    async (runtimeRoot) => {
      const stateDir = await mkdtemp(join(tmpdir(), "supa-hook-disabled-state-"));
      const env = hookEnvironment("codex", { STATE_DIR: stateDir });
      const hooks: readonly (readonly [hookName: string, stdout: string])[] = [
        ["context-pre-tool-use.mts", ""],
        ["context-session-start.mts", ""],
        ["supaschema-source-hook.mts", ""],
      ];

      for (const [hookName, stdout] of hooks) {
        const result = await runRawHook(join(root, runtimeRoot, "hooks", hookName), "", env);
        expect(result).toEqual({ code: 0, stderr: "", stdout });
      }
      expect(await readdir(stateDir)).toEqual([]);
    }
  );

  it("makes malformed input visible without denying the event", { timeout: 20_000 }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "supa-hook-malformed-"));
    const result = await runRawHook(
      join(root, ".claude/hooks/context-pre-tool-use.mts"),
      "{not-json",
      hookEnvironment("claude", { STATE_DIR: stateDir })
    );

    expect(result.code).toBe(0);
    const output = hookOutput(result.stdout);
    expect(output.systemMessage).toContain("check crashed; no policy decision was made");
    expect(output.hookSpecificOutput?.permissionDecision).toBeUndefined();
  });

  it("runs silent SessionStart and SessionEnd lifecycle entrypoints", {
    timeout: 20_000,
  }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "supa-hook-lifecycle-"));
    const env = hookEnvironment("claude", { STATE_DIR: stateDir });
    const common = {
      cwd: root,
      permission_mode: "default",
      session_id: "entrypoint-lifecycle",
      transcript_path: null,
    };

    const start = await runHook(
      join(root, ".claude/hooks/context-session-start.mts"),
      { ...common, hook_event_name: "SessionStart", source: "startup" },
      env
    );
    expect(start).toMatchObject({ code: 0, stderr: "", stdout: "" });
    expect(
      (await readFile(join(stateDir, "ZW50cnlwb2ludC1saWZlY3ljbGU.json"), "utf8")).toString()
    ).toContain('"sessionId": "entrypoint-lifecycle"');

    const end = await runHook(
      join(root, ".claude/hooks/context-session-end.mts"),
      { ...common, hook_event_name: "SessionEnd", reason: "clear" },
      env
    );
    expect(end).toMatchObject({ code: 0, stderr: "", stdout: "" });
    await expect(
      readFile(join(stateDir, "ZW50cnlwb2ludC1saWZlY3ljbGU.json"))
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("recovers a killed owner while crediting exact skill content", {
    timeout: 20_000,
  }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "supa-hook-skill-load-"));
    const env = hookEnvironment("claude", { STATE_DIR: stateDir });
    const sessionId = "entrypoint-skill-load";
    const skillPath = ".claude/skills/supaschema/SKILL.md";

    const prompt = await runHook(
      join(root, ".claude/hooks/context-user-prompt-submit.mts"),
      {
        hook_event_name: "UserPromptSubmit",
        prompt: "$supaschema",
        session_id: sessionId,
      },
      env
    );
    expect(prompt.code).toBe(0);

    const lockHolder = await startLockHolder(sessionId, env);
    await killProcess(lockHolder);

    const command = `cat ${skillPath}`;
    const recoveryStartedAt = Date.now();
    const load = await runHook(
      join(root, ".claude/hooks/context-pre-tool-use.mts"),
      {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_input: { command },
        tool_name: "Bash",
      },
      env
    );
    expect(hookOutput(load.stdout).hookSpecificOutput?.permissionDecision).toBeUndefined();

    const recorded = await runHook(
      join(root, ".claude/hooks/context-post-tool-use.mts"),
      {
        hook_event_name: "PostToolUse",
        session_id: sessionId,
        tool_input: { command },
        tool_name: "Bash",
        tool_response: await readFile(join(root, skillPath), "utf8"),
      },
      env
    );
    expect(recorded).toMatchObject({ code: 0, stderr: "", stdout: "" });
    expect(Date.now() - recoveryStartedAt).toBeLessThan(5000);

    const governed = await runHook(
      join(root, ".claude/hooks/context-pre-tool-use.mts"),
      {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_input: { file_path: "README.md" },
        tool_name: "Read",
      },
      env
    );
    expect(hookOutput(governed.stdout).hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(
      await pathExists(join(stateDir, `${Buffer.from(sessionId).toString("base64url")}.json.lock`))
    ).toBe(false);
  });

  it("never age-steals a live owner and lets SessionEnd reclaim it after SIGKILL", {
    timeout: 20_000,
  }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "supa-hook-live-lock-"));
    const env = hookEnvironment("claude", { STATE_DIR: stateDir });
    const sessionId = "entrypoint-live-lock";
    const lockDirectory = join(
      stateDir,
      `${Buffer.from(sessionId).toString("base64url")}.json.lock`
    );
    const lockHolder = await startLockHolder(sessionId, env);
    try {
      const [ownerName] = await readdir(lockDirectory);
      const ownerPath = join(lockDirectory, ownerName);
      const owner = JSON.parse(await readFile(ownerPath, "utf8"));
      const oldDate = new Date(Date.now() - 60_000);
      owner.acquiredAt = oldDate.toISOString();
      await writeFile(ownerPath, `${JSON.stringify(owner)}\n`, { mode: 0o600 });
      await utimes(lockDirectory, oldDate, oldDate);
      await utimes(ownerPath, oldDate, oldDate);

      const startedAt = Date.now();
      const liveEnd = await runHook(
        join(root, ".claude/hooks/context-session-end.mts"),
        {
          cwd: root,
          hook_event_name: "SessionEnd",
          reason: "clear",
          session_id: sessionId,
          transcript_path: null,
        },
        env
      );
      const elapsedMs = Date.now() - startedAt;

      expect(elapsedMs).toBeGreaterThanOrEqual(450);
      expect(elapsedMs).toBeLessThan(5000);
      expect(hookOutput(liveEnd.stdout).systemMessage).toContain(
        "timed out waiting for session state lock"
      );
      expect(await readdir(lockDirectory)).toEqual([ownerName]);
      expect(
        Object.keys(owner).sort((left, right) => Number(left > right) - Number(left < right))
      ).toEqual(["acquiredAt", "pid", "token"]);
    } finally {
      await killProcess(lockHolder);
    }

    const recoveredEnd = await runHook(
      join(root, ".claude/hooks/context-session-end.mts"),
      {
        cwd: root,
        hook_event_name: "SessionEnd",
        reason: "clear",
        session_id: sessionId,
        transcript_path: null,
      },
      env
    );
    expect(recoveredEnd).toMatchObject({ code: 0, stderr: "", stdout: "" });
    expect(await pathExists(lockDirectory)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "holds a live lock with private directory and owner permissions",
    { timeout: 20_000 },
    async () => {
      const stateDir = await mkdtemp(join(tmpdir(), "supa-hook-private-lock-"));
      const env = hookEnvironment("claude", { STATE_DIR: stateDir });
      const sessionId = "entrypoint-private-lock";
      const lockDirectory = join(
        stateDir,
        `${Buffer.from(sessionId).toString("base64url")}.json.lock`
      );
      const lockHolder = await startLockHolder(sessionId, env);
      try {
        const [ownerName] = await readdir(lockDirectory);
        expect((await stat(lockDirectory)).mode % 0o1000).toBe(0o700);
        expect((await stat(join(lockDirectory, ownerName))).mode % 0o1000).toBe(0o600);
      } finally {
        await killProcess(lockHolder);
      }
    }
  );

  it("leaves no lock artifacts when contending waiters are killed", {
    timeout: 20_000,
  }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "supa-hook-killed-waiters-"));
    const env = hookEnvironment("claude", { STATE_DIR: stateDir });
    const hook = join(root, ".claude/hooks/context-pre-tool-use.mts");
    const sessionId = "killed-lock-waiters";
    const encodedSessionId = Buffer.from(sessionId).toString("base64url");
    const lockName = `${encodedSessionId}.json.lock`;
    const lockDirectory = join(stateDir, lockName);
    const lockHolder = await startLockHolder(sessionId, env);
    const ownerNames = await readdir(lockDirectory);
    const waiters = Array.from({ length: 4 }, (_, index) =>
      startHookProcess(
        hook,
        {
          hook_event_name: "PreToolUse",
          session_id: sessionId,
          tool_input: { file_path: `README-${index}.md` },
          tool_name: "Read",
        },
        env
      )
    );
    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(waiters.every(({ child }) => child.exitCode === null)).toBe(true);
      expect(await readdir(stateDir)).toEqual([lockName]);
      await Promise.all(waiters.map(({ child }) => killProcess(child)));
      expect(await readdir(lockDirectory)).toEqual(ownerNames);
    } finally {
      await Promise.all([...waiters.map(({ child }) => child), lockHolder].map(killProcess));
      await Promise.all(waiters.map(({ result }) => result));
    }

    const recovery = await runHook(
      hook,
      {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_input: { file_path: "README.md" },
        tool_name: "Read",
      },
      env
    );

    expect(recovery).toMatchObject({ code: 0, stderr: "", stdout: "" });
    expect(await pathExists(lockDirectory)).toBe(false);
  });

  it("serializes concurrent evidence updates through the actual hook entrypoint", {
    timeout: 20_000,
  }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "supa-hook-concurrent-state-"));
    const env = hookEnvironment("claude", { STATE_DIR: stateDir });
    const hook = join(root, ".claude/hooks/context-post-tool-use.mts");
    const sessionId = "concurrent-entrypoint";
    const lockHolder = await startLockHolder(sessionId, env);
    await killProcess(lockHolder);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        runHookAsync(
          hook,
          {
            hook_event_name: "PostToolUse",
            session_id: sessionId,
            tool_input: { command: "npm test" },
            tool_name: "Bash",
            tool_response: { exit_code: 0 },
            turn_id: `turn-${index}`,
          },
          env
        )
      )
    );

    expect(results).toEqual(Array.from({ length: 8 }, () => ({ code: 0, stderr: "", stdout: "" })));
    const state = JSON.parse(
      await readFile(join(stateDir, `${Buffer.from(sessionId).toString("base64url")}.json`), "utf8")
    );
    const turns =
      state && typeof state === "object" && !Array.isArray(state) && state.turns
        ? Object.values(state.turns)
        : [];
    const evidence = turns.flatMap((turn) =>
      turn && typeof turn === "object" && !Array.isArray(turn) && Array.isArray(turn.evidence)
        ? turn.evidence
        : []
    );
    expect(evidence).toHaveLength(8);
    expect(evidence).toEqual(
      expect.arrayContaining(
        Array.from({ length: 8 }, () =>
          expect.objectContaining({ domain: "test", outcome: "success" })
        )
      )
    );
  });

  it("keeps a masked success from resolving an actual Stop failure conflict", {
    timeout: 20_000,
  }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "supa-hook-outcome-state-"));
    const env = hookEnvironment("claude", { STATE_DIR: stateDir });
    const sessionId = "entrypoint-outcome";
    const failed = await runHook(
      join(root, ".claude/hooks/context-post-tool-use-failure.mts"),
      {
        hook_event_name: "PostToolUseFailure",
        session_id: sessionId,
        tool_input: { command: "npm test" },
        tool_name: "Bash",
      },
      env
    );
    expect(failed).toMatchObject({ code: 0, stderr: "", stdout: "" });

    const masked = await runHook(
      join(root, ".claude/hooks/context-post-tool-use.mts"),
      {
        hook_event_name: "PostToolUse",
        session_id: sessionId,
        tool_input: { command: "npm test || true" },
        tool_name: "Bash",
      },
      env
    );
    expect(masked).toMatchObject({ code: 0, stderr: "", stdout: "" });

    const contradicted = await runHook(
      join(root, ".claude/hooks/context-stop.mts"),
      {
        hook_event_name: "Stop",
        last_assistant_message: "Tests passed.",
        session_id: sessionId,
        stop_hook_active: false,
      },
      env
    );
    expect(hookOutput(contradicted.stdout)).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("test"),
    });

    const honest = await runHook(
      join(root, ".claude/hooks/context-stop.mts"),
      {
        hook_event_name: "Stop",
        last_assistant_message: "Tests passed previously, but the current tests failed.",
        session_id: sessionId,
        stop_hook_active: false,
      },
      env
    );
    expect(honest).toMatchObject({ code: 0, stderr: "", stdout: "" });
  });
});

describe("comment-free source write-time enforcement", () => {
  const probeDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(probeDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function writeProbe(content: string): Promise<string> {
    const dir = await mkdtemp(join(root, "tests", "comment-hook-"));
    probeDirs.push(dir);
    const file = join(dir, "probe.ts");
    await writeFile(file, content, "utf8");
    return slash(file);
  }

  async function runEdit(toolName: string, toolInput: Record<string, unknown>) {
    const stateDir = await mkdtemp(join(tmpdir(), "supa-comment-hook-state-"));
    return runHook(
      join(root, ".claude/hooks/context-pre-tool-use.mts"),
      {
        hook_event_name: "PreToolUse",
        session_id: `comment-hook-${Math.random().toString(36).slice(2)}`,
        tool_name: toolName,
        tool_input: toolInput,
      },
      hookEnvironment("claude", { STATE_DIR: stateDir })
    );
  }

  function decision(stdout: string): { decision?: string; reason?: string } {
    const specific = hookOutput(stdout).hookSpecificOutput;
    return specific?.permissionDecision === "deny"
      ? { decision: "deny", reason: specific.permissionDecisionReason }
      : {};
  }

  it("denies a Write that adds a line comment to tracked JS/TS", async () => {
    const result = await runEdit("Write", {
      file_path: "src/__probe.ts",
      content: "export const x = 1;\n// explain\n",
    });
    expect(decision(result.stdout)).toMatchObject({
      decision: "deny",
      reason: expect.stringContaining("rule 07"),
    });
  });

  it("denies a Write that adds a block comment", async () => {
    const result = await runEdit("Write", {
      file_path: "src/__probe.ts",
      content: "export const x = 1; /* hi */\n",
    });
    expect(decision(result.stdout).decision).toBe("deny");
  });

  it("allows a clean Write to tracked JS/TS", async () => {
    const result = await runEdit("Write", {
      file_path: "src/__probe.ts",
      content: "export const x = 1;\n",
    });
    expect(decision(result.stdout).decision).toBeUndefined();
  });

  it("allows // inside a string literal", async () => {
    const result = await runEdit("Write", {
      file_path: "src/__probe.ts",
      content: 'export const s = "a // not a comment";\n',
    });
    expect(decision(result.stdout).decision).toBeUndefined();
  });

  it("allows a shebang on line 1", async () => {
    const result = await runEdit("Write", {
      file_path: "src/__probe.ts",
      content: "#!/usr/bin/env node\nexport const x = 1;\n",
    });
    expect(decision(result.stdout).decision).toBeUndefined();
  });

  it("ignores non-code paths (markdown, python)", async () => {
    const md = await runEdit("Write", { file_path: "README.md", content: "<!-- c -->\n" });
    expect(decision(md.stdout).decision).toBeUndefined();
    const py = await runEdit("Write", {
      file_path: "src/__probe.py",
      content: "# comment\nx = 1\n",
    });
    expect(decision(py.stdout).decision).toBeUndefined();
  });

  it("denies an Edit that adds a comment", async () => {
    const file = await writeProbe("export const x = 1;\n");
    const result = await runEdit("Edit", {
      file_path: file,
      old_string: "x = 1;",
      new_string: "x = 1;\n// new",
    });
    expect(decision(result.stdout).decision).toBe("deny");
  });

  it("allows a clean Edit to a file that already has a comment", async () => {
    const file = await writeProbe("export const x = 1;\n// existing\n");
    const result = await runEdit("Edit", {
      file_path: file,
      old_string: "x = 1;",
      new_string: "x = 2;",
    });
    expect(decision(result.stdout).decision).toBeUndefined();
  });

  it("denies a MultiEdit where one edit adds a comment", async () => {
    const file = await writeProbe("export const a = 1;\nexport const b = 2;\n");
    const result = await runEdit("MultiEdit", {
      file_path: file,
      edits: [
        { old_string: "a = 1;", new_string: "a = 11;" },
        { old_string: "b = 2;", new_string: "b = 22;\n// added" },
      ],
    });
    expect(decision(result.stdout).decision).toBe("deny");
  });

  it("denies an apply_patch update that adds a comment line", async () => {
    const file = await writeProbe("export const x = 1;\n");
    const result = await runEdit("apply_patch", {
      command: `*** Update File: ${file}\n-x = 1;\n+x = 2;\n+// added\n`,
    });
    expect(decision(result.stdout).decision).toBe("deny");
  });

  it("denies an apply_patch update that adds a duplicate-text comment", async () => {
    const file = await writeProbe("export const a = 1;\n// existing\nexport const b = 2;\n");
    const result = await runEdit("apply_patch", {
      command: `*** Update File: ${file}\n export const a = 1;\n // existing\n export const b = 2;\n+// existing\n`,
    });
    expect(decision(result.stdout).decision).toBe("deny");
  });

  it("allows an apply_patch update that moves a comment by delete and re-add", async () => {
    const file = await writeProbe("export const a = 1;\n// move me\nexport const b = 2;\n");
    const result = await runEdit("apply_patch", {
      command: `*** Update File: ${file}\n export const a = 1;\n-// move me\n export const b = 2;\n+// move me\n`,
    });
    expect(decision(result.stdout).decision).toBeUndefined();
  });

  it("denies an apply_patch add of a new commented file under src", async () => {
    const result = await runEdit("apply_patch", {
      command: "*** Add File: src/__new_probe.ts\n+export const x = 1;\n+// comment\n",
    });
    expect(decision(result.stdout).decision).toBe("deny");
  });

  it("allows a +// line added inside a multiline template literal", async () => {
    const file = await writeProbe("export const s = `\nhello\n`;\n");
    const result = await runEdit("apply_patch", {
      command: `*** Update File: ${file}\n export const s = \`\n hello\n+// text\n \`;\n`,
    });
    expect(decision(result.stdout).decision).toBeUndefined();
  });

  it("denies an @@-anchored apply_patch add of a comment at the later duplicate context line", async () => {
    const file = await writeProbe(
      "export const s = `\n  doThing();\n`;\nfunction main() {\n  doThing();\n  otherThing();\n}\n"
    );
    const result = await runEdit("apply_patch", {
      command: `*** Update File: ${file}\n@@ function main() {\n   doThing();\n+// anchored\n   otherThing();\n }\n`,
    });
    expect(decision(result.stdout).decision).toBe("deny");
  });

  it("denies a comment added by a later Update File section that only parses as a comment after the earlier section's reconstruction", async () => {
    const file = await writeProbe("export const s = `\nhello\n`;\n");
    const result = await runEdit("apply_patch", {
      command: `*** Update File: ${file}\n-export const s = \`\n+export const s = "start";\n*** Update File: ${file}\n-hello\n+// added\n`,
    });
    expect(decision(result.stdout).decision).toBe("deny");
  });

  it("allows a net-neutral comment move via Move to", async () => {
    const file = await writeProbe("export const x = 1;\n// move me\n");
    const result = await runEdit("apply_patch", {
      command: `*** Update File: ${file}\n export const x = 1;\n // move me\n*** Move to: src/__moved_probe.ts\n`,
    });
    expect(decision(result.stdout).decision).toBeUndefined();
  });

  it("does not load the comment scanner for a non-edit tool", { timeout: 20_000 }, async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "supa-comment-hook-lazy-load-"));
    const startedAt = Date.now();
    const result = await runHook(
      join(root, ".claude/hooks/context-pre-tool-use.mts"),
      {
        hook_event_name: "PreToolUse",
        session_id: `comment-hook-lazy-${Math.random().toString(36).slice(2)}`,
        tool_input: { file_path: "src/index.ts" },
        tool_name: "Read",
      },
      hookEnvironment("claude", { STATE_DIR: stateDir })
    );
    const elapsedMs = Date.now() - startedAt;
    expect(result.code).toBe(0);
    expect(decision(result.stdout).decision).toBeUndefined();
    expect(elapsedMs).toBeLessThan(500);
  });
});

function slash(absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

function matcherFor(config: any, eventName: string, commandFragment: string): string | undefined {
  for (const entry of config.hooks?.[eventName] ?? []) {
    if (hookHandlers(entry).some((handler) => handlerText(handler).includes(commandFragment))) {
      return entry.matcher;
    }
  }
}

function hookHandlers(value: any): any[] {
  const handlers: any[] = [];
  const visit = (candidate: any) => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }
    if (!(candidate && typeof candidate === "object")) {
      return;
    }
    if (candidate.type === "command" && typeof candidate.command === "string") {
      handlers.push(candidate);
    }
    for (const item of Object.values(candidate)) {
      visit(item);
    }
  };
  visit(value);
  return handlers;
}

function handlerText(handler: any): string {
  return [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])].join(" ");
}

function hookOutput(stdout: string): any {
  return stdout.trim() ? JSON.parse(stdout) : {};
}

function hookEnvironment(
  runtime: "claude" | "codex",
  overrides: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  const env = { ...process.env, ...overrides };
  if (runtime === "codex") {
    env.CODEX_THREAD_ID = env.CODEX_THREAD_ID ?? "test-codex-thread";
    return env;
  }
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== "CODEX_THREAD_ID"));
}

function runHook(
  hook: string,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv
): { code: number; stderr: string; stdout: string } {
  return runRawHook(hook, JSON.stringify(payload), env);
}

function runRawHook(
  hook: string,
  input: string,
  env: NodeJS.ProcessEnv
): { code: number; stderr: string; stdout: string } {
  const result = spawnSync(process.execPath, [hook], {
    cwd: root,
    encoding: "utf8",
    env,
    input,
    timeout: 15_000,
  });
  if (result.error) {
    throw result.error;
  }
  return {
    code: result.status ?? 1,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function runHookAsync(
  hook: string,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv
): Promise<{ code: number; stderr: string; stdout: string }> {
  return startHookProcess(hook, payload, env).result;
}

function startHookProcess(
  hook: string,
  payload: Record<string, unknown>,
  env: NodeJS.ProcessEnv
): {
  child: ChildProcessWithoutNullStreams;
  result: Promise<{ code: number; stderr: string; stdout: string }>;
} {
  const child = spawn(process.execPath, [hook], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const result = new Promise<{ code: number; stderr: string; stdout: string }>(
    (resolve, reject) => {
      let stderr = "";
      let stdout = "";
      child.stderr.setEncoding("utf8");
      child.stdout.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => {
        resolve({ code: code ?? 1, stderr, stdout });
      });
    }
  );
  child.stdin.end(JSON.stringify(payload));
  return { child, result };
}

async function startLockHolder(
  sessionId: string,
  env: NodeJS.ProcessEnv
): Promise<ChildProcessWithoutNullStreams> {
  const stateModule = pathToFileURL(join(root, "scripts/agent-hooks/state.mts")).href;
  const source = [
    `import { withSessionState } from ${JSON.stringify(stateModule)};`,
    `withSessionState({ session_id: ${JSON.stringify(sessionId)} }, (state) => {`,
    '  process.stdout.write("locked\\n");',
    "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);",
    "  return { state };",
    "});",
  ].join("\n");
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: root,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        child.off("error", onError);
        child.off("close", onClose);
        child.stdout.off("data", onData);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onError = (error: Error) => finish(error);
      const onClose = (code: number | null) =>
        finish(new Error(`lock holder exited before acquiring the lock: ${code}; ${stderr}`));
      const onData = (chunk: string) =>
        finish(
          chunk === "locked\n" ? undefined : new Error(`unexpected lock holder output: ${chunk}`)
        );
      const timeout = setTimeout(
        () => finish(new Error(`timed out waiting for lock holder; ${stderr}`)),
        5000
      );
      child.once("error", onError);
      child.once("close", onClose);
      child.stdout.once("data", onData);
    });
  } catch (error) {
    await killProcess(child);
    throw error;
  }
  return child;
}

async function killProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const closed = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => resolve());
  });
  if (!child.kill("SIGKILL")) {
    throw new Error("failed to kill process");
  }
  await closed;
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}
