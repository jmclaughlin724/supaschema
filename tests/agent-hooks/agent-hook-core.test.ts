import { spawnSync } from "node:child_process";
import fs, {
  existsSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateBashPolicy } from "../../.claude/hooks/guards/bash-policy-checks.mts";
import {
  classifyCommandDomains,
  classifyCommandOutcomeDomains,
} from "../../scripts/agent-hooks/command-evidence.mts";
import { shapeHookResult } from "../../scripts/agent-hooks/hook-output.mts";
import { claimedVerificationDomains } from "../../scripts/agent-hooks/response-claims.mts";
import { handleAgentHookEvent } from "../../scripts/agent-hooks/runner.mts";
import { handleSessionLifecycleEvent } from "../../scripts/agent-hooks/session-lifecycle.mts";
import { parseShellCommand } from "../../scripts/agent-hooks/shell-command.mts";
import {
  inspectSessionState,
  normalizeState,
  readSessionState,
  refreshSessionState,
  sessionStatePath,
  withSessionState,
} from "../../scripts/agent-hooks/state.mts";
import { isCanonicalAgentSurfaceSource } from "../../scripts/skills/agent-surface-manifest.mts";

const repositoryRoot = process.cwd();
const originalStateDir = process.env.STATE_DIR;

afterEach(() => {
  vi.restoreAllMocks();
  if (originalStateDir === undefined) {
    delete process.env.STATE_DIR;
  } else {
    process.env.STATE_DIR = originalStateDir;
  }
});

describe("parser-backed command and edit analysis", () => {
  it("uses a shell AST for quoting, pipelines, substitutions, and glob expansion", () => {
    const analysis = parseShellCommand(
      "TOKEN='literal value' psql -c 'select 1' | tee output.txt; rm -rf $TARGET"
    );

    expect(analysis.errors).toEqual([]);
    expect(analysis.invocations.map((invocation) => invocation.executable)).toEqual([
      "psql",
      "tee",
      "rm",
    ]);
    expect(analysis.invocations.find((invocation) => invocation.executable === "psql")?.piped).toBe(
      true
    );
    expect(
      analysis.invocations.find((invocation) => invocation.executable === "rm")?.arguments.at(-1)
        ?.parts[0]?.type
    ).toBe("SimpleExpansion");
  });

  it("classifies verification domains from parsed commands and package scripts", () => {
    expect(classifyCommandDomains("npm run check", { root: repositoryRoot })).toEqual([
      "build",
      "lint",
      "test",
      "typecheck",
    ]);
    expect(classifyCommandDomains("npm run guard:agent", { root: repositoryRoot })).toEqual([
      "guard",
      "sync",
    ]);
    expect(classifyCommandDomains("npx vitest run && gh pr checks 42")).toEqual([
      "github-checks",
      "test",
    ]);
    expect(classifyCommandDomains("printf 'npm test' && unknown-command")).toEqual([]);
    expect(classifyCommandDomains("npm run does-not-exist")).toEqual([]);
    for (const inspection of [
      "npm test -- --help",
      "npx vitest --help",
      "gh pr status",
      "gh run list",
      "gh run view 123",
      "gh run watch 123",
      "gh api repos/example/project/actions/runs",
    ]) {
      expect(classifyCommandDomains(inspection), inspection).toEqual([]);
    }
    expect(classifyCommandDomains("gh run watch 123 --exit-status")).toEqual(["github-checks"]);
  });

  it("records only outcomes proven by the enclosing shell AST", () => {
    for (const command of [
      "npm test || true",
      "npm test; true",
      "npm test | cat",
      "result=$(npm test); true",
      "bash -c 'npm test || true'",
    ]) {
      expect(classifyCommandDomains(command, { root: repositoryRoot }), command).toEqual([]);
    }

    expect(classifyCommandDomains("npm test && npm run lint", { root: repositoryRoot })).toEqual([
      "lint",
      "test",
    ]);
    expect(
      classifyCommandOutcomeDomains("npm test && npm run lint", "failure", {
        root: repositoryRoot,
      })
    ).toEqual([]);
    expect(
      classifyCommandOutcomeDomains("npm run typecheck", "failure", { root: repositoryRoot })
    ).toEqual(["typecheck"]);
    expect(
      classifyCommandOutcomeDomains("npm run check:package", "failure", {
        root: repositoryRoot,
      })
    ).toEqual(["package"]);
  });

  it("classifies only the exact owned prompt as a surface-sync source", () => {
    expect(isCanonicalAgentSurfaceSource(".agents/prompts/supaschema-install.md")).toBe(true);
    expect(isCanonicalAgentSurfaceSource(".agents/prompts/unrelated.md")).toBe(false);
  });
});

describe("narrow Bash enforcement", () => {
  const evaluate = (command: string, options: { env?: NodeJS.ProcessEnv; root?: string } = {}) =>
    evaluateBashPolicy(
      {
        cwd: options.root ?? repositoryRoot,
        tool_input: { command, cwd: options.root ?? repositoryRoot },
        tool_name: "Bash",
      },
      options.env ?? process.env,
      { root: options.root ?? repositoryRoot }
    );

  it.each([
    "git switch -c feature/parser-hooks",
    "git reset --hard HEAD",
    "git push --force origin main",
    "git merge --squash feature/parser-hooks",
    "git worktree add ../parser-hooks HEAD",
  ])("does not hook-block Git or worktree command: %s", (command) => {
    expect(evaluate(command)).toEqual({ action: "allow" });
  });

  it("blocks literal secrets and direct known-secret-file display", () => {
    expect(evaluate("API_TOKEN='abcdefghijklmnop' curl https://example.com").action).toBe("block");
    expect(evaluate("curl --api-key abcdefghijklmnop https://example.com").action).toBe("block");
    expect(evaluate("curl postgresql://user:abcdefghijklmnop@localhost/database").action).toBe(
      "block"
    );
    expect(evaluate("cat .env").action).toBe("block");
    expect(evaluate("command cat -- .env").action).toBe("block");
    expect(evaluate("cat config/.pgpass").action).toBe("block");
    expect(evaluate("cat .env.example")).toEqual({ action: "allow" });
    expect(evaluate("cat .env.template")).toEqual({ action: "allow" });
  });

  it("blocks parser-confirmed literal PostgreSQL DDL arguments only", () => {
    expect(evaluate("psql -c 'CREATE TABLE app.accounts (id bigint)'").action).toBe("block");
    expect(evaluate("psql --command='ALTER TABLE app.accounts ADD COLUMN name text'").action).toBe(
      "block"
    );
    expect(
      evaluate("psql -v ON_ERROR_STOP=1 -XAtc 'CREATE TABLE app.audit (id bigint)'").action
    ).toBe("block");
    expect(evaluate("env psql -c 'CREATE POLICY p ON app.accounts USING (true)'").action).toBe(
      "block"
    );
    expect(evaluate("supabase db execute --sql 'DROP TABLE app.accounts'").action).toBe("block");
    expect(evaluate("psql -c 'SELECT 1'")).toEqual({ action: "allow" });
    expect(evaluate("psql -f migration.sql")).toEqual({ action: "allow" });
    expect(evaluate("psql -c $SQL")).toEqual({ action: "allow" });
    expect(evaluate("psql <<'SQL'\nCREATE TABLE app.t(id int);\nSQL")).toEqual({ action: "allow" });
  });

  it("blocks only high-confidence dangerous recursive forced deletion", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-bash-delete-root-"));
    const env = { ...process.env, HOME: dirname(root) };

    expect(evaluate("rm -rf /", { env, root }).action).toBe("block");
    expect(evaluate("rm --recursive --force /", { env, root }).action).toBe("block");
    expect(evaluate(`rm -rf ${root}`, { env, root }).action).toBe("block");
    expect(evaluate("rm -rf ..", { env, root }).action).toBe("block");
    expect(evaluate("rm -rf $TARGET", { env, root }).action).toBe("block");
    expect(evaluate("rm -rf build/*", { env, root }).action).toBe("block");
    expect(evaluate('rm -rf / "unterminated', { env, root })).toEqual({ action: "allow" });
    expect(evaluate("rm -rf .tmp/cache", { env, root })).toEqual({ action: "allow" });
    expect(evaluate("rm -r /", { env, root })).toEqual({ action: "allow" });
    expect(evaluate("rm -f /", { env, root })).toEqual({ action: "allow" });
    expect(evaluate("rm -rf 'unterminated", { env, root })).toEqual({ action: "allow" });
  });
});

describe("structured verification conflicts", () => {
  it("blocks only a success claim contradicted by the latest matching failure", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const sessionId = "verification-conflict";

    expect((await stop(sessionId, "Tests passed.", fixture)).output).toEqual({});
    await failedCommand(sessionId, "npm test", fixture);
    expect((await stop(sessionId, "Tests failed; the error remains.", fixture)).output).toEqual({});
    expect(
      (await stop(sessionId, "Tests passed previously, but the current tests failed.", fixture))
        .output
    ).toEqual({});
    expect((await stop(sessionId, "Tests passed.", fixture)).output).toMatchObject({
      decision: "block",
      reason: expect.stringContaining("test"),
    });
    await successfulCommand(sessionId, "npm test", fixture);
    expect((await stop(sessionId, "Tests passed.", fixture)).output).toEqual({});
  });

  it("requires structured Codex outcomes before recording verification evidence", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const sessionId = "codex-verification";
    const options: HookFixture["options"] = { ...fixture.options, runtime: "codex" };
    const payload = {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      tool_input: { command: "npm test" },
      tool_name: "Bash",
    };

    await handleAgentHookEvent("PostToolUse", payload, options);
    expect((await stop(sessionId, "Tests passed.", fixture)).output).toEqual({});

    await handleAgentHookEvent(
      "PostToolUse",
      { ...payload, tool_response: { exit_code: 1 } },
      options
    );
    expect((await stop(sessionId, "Tests passed.", fixture)).output.decision).toBe("block");

    await handleAgentHookEvent(
      "PostToolUse",
      { ...payload, tool_response: { exit_code: 0 } },
      options
    );
    expect((await stop(sessionId, "Tests passed.", fixture)).output).toEqual({});
  });

  it("ignores hedging, decision menus, incidents, and raw response text", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const sessionId = "verification-nonclaims";
    failedCommand(sessionId, "npm test", fixture);

    for (const message of [
      "Tests did not pass.",
      "I could rerun tests or inspect the failure; which do you prefer?",
      "Command not found: vitest.",
      "The likely test outcome is uncertain.",
      "Could tests pass after another change?",
      "Will tests pass?",
    ]) {
      expect((await stop(sessionId, message, fixture)).output, message).toEqual({});
    }

    successfulCommand(sessionId, "npm test", fixture, {
      stdout: "Process exited with code 1; tests failed",
    });
    expect((await stop(sessionId, "Tests passed.", fixture)).output).toEqual({});
  });

  it("parses explicit verification claim grammar without subjective response scoring", () => {
    expect(claimedVerificationDomains("Tests and typecheck passed; lint failed.")).toEqual([
      "test",
      "typecheck",
    ]);
    expect(claimedVerificationDomains("Tests did not pass.")).toEqual([]);
    expect(claimedVerificationDomains("Here are options for running tests.")).toEqual([]);
    expect(claimedVerificationDomains("Could tests pass after another change?")).toEqual([]);
    expect(claimedVerificationDomains("Tests passed previously, but now fail.")).toEqual([]);
    expect(claimedVerificationDomains("Earlier tests passed. The current tests failed.")).toEqual(
      []
    );
    expect(claimedVerificationDomains("Tests previously failed but tests now passed.")).toEqual([
      "test",
    ]);
    expect(claimedVerificationDomains("Tests passed after previously failing.")).toEqual(["test"]);
    expect(claimedVerificationDomains("Tests passed previously but are failing now.")).toEqual([]);
  });
});

describe("minimal private hook state", () => {
  it("retries a transient owner-file initialization race", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const payload = { session_id: "retry-owner-initialization" };
    const originalOpenSync = fs.openSync;
    let injectedFailure = false;
    vi.spyOn(fs, "openSync").mockImplementation((file, flags, mode) => {
      const target = String(file);
      if (!injectedFailure && target.includes(".json.lock") && target.includes("owner-")) {
        injectedFailure = true;
        throw Object.assign(new Error("transient owner-file race"), { code: "EINVAL" });
      }
      return originalOpenSync(file, flags, mode);
    });

    withSessionState(payload, (state) => {
      state.turnSequence = 7;
      return { state };
    });

    expect(injectedFailure).toBe(true);
    expect(readSessionState(payload).turnSequence).toBe(7);
    expect(existsSync(`${sessionStatePath(payload)}.lock`)).toBe(false);
  });

  it("persists no prompt or command text and uses private permissions", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const sessionId = "private-state";
    const promptMarker = "do-not-persist-this-prompt";
    const commandMarker = "do-not-persist-this-command";

    await handleAgentHookEvent(
      "UserPromptSubmit",
      { prompt: `$fastmcp ${promptMarker}`, session_id: sessionId },
      fixture.options
    );
    await successfulCommand(sessionId, `npm test -- ${commandMarker}`, fixture);

    const file = sessionStatePath({ session_id: sessionId });
    const serialized = await readFile(file, "utf8");
    expect(serialized).not.toContain(promptMarker);
    expect(serialized).not.toContain(commandMarker);
    expect(serialized).not.toContain("lastPrompt");
    expect(serialized).not.toContain("command");
    if (process.platform !== "win32") {
      expect((await stat(fixture.stateDir)).mode % 0o1000).toBe(0o700);
      expect((await stat(file)).mode % 0o1000).toBe(0o600);
    }
  });

  it("recovers an empty lock directory instead of failing the hook", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const payload = { session_id: "empty-lock" };
    const lockDirectory = `${sessionStatePath(payload)}.lock`;
    await mkdir(lockDirectory, { mode: 0o700, recursive: true });
    const oldDate = new Date(Date.now() - 60_000);
    await utimes(lockDirectory, oldDate, oldDate);

    const result = await handleAgentHookEvent(
      "PreToolUse",
      {
        session_id: payload.session_id,
        tool_input: { file_path: "README.md" },
        tool_name: "Read",
      },
      fixture.options
    );

    expect(result.output.systemMessage).toBeUndefined();
    expect(existsSync(lockDirectory)).toBe(false);
  });

  it("reclaims a lock whose recorded owner process has exited", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const payload = { session_id: "dead-owner-lock" };
    const lockDirectory = `${sessionStatePath(payload)}.lock`;
    const token = "00000000-0000-4000-8000-0000000000de";
    const exited = spawnSync(process.execPath, ["-e", ""]);
    await mkdir(lockDirectory, { mode: 0o700, recursive: true });
    await writeFile(
      join(lockDirectory, `owner-${token}.json`),
      `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: exited.pid, token })}\n`,
      { mode: 0o600 }
    );

    const result = await handleAgentHookEvent(
      "PreToolUse",
      {
        session_id: payload.session_id,
        tool_input: { file_path: "README.md" },
        tool_name: "Read",
      },
      fixture.options
    );

    expect(JSON.stringify(result)).not.toContain("timed out waiting for session state lock");
    expect(result.output.systemMessage).toBeUndefined();
    expect(existsSync(lockDirectory)).toBe(false);
  });

  it("discards a superseded lock owner when the session restarts", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const payload = { session_id: "superseded-owner-lock" };
    const lockDirectory = `${sessionStatePath(payload)}.lock`;
    const token = "00000000-0000-4000-8000-0000000000aa";
    await mkdir(lockDirectory, { mode: 0o700, recursive: true });
    await writeFile(
      join(lockDirectory, `owner-${token}.json`),
      `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token })}\n`,
      { mode: 0o600 }
    );

    expect(handleSessionLifecycleEvent("SessionStart", payload, fixture.options).stdout).toBe("");
    expect(existsSync(lockDirectory)).toBe(false);
    expect(readSessionState(payload).sessionId).toBe(payload.session_id);
  });

  it("keeps malformed lock ownership visible without deleting it", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const payload = { session_id: "malformed-lock" };
    const lockDirectory = `${sessionStatePath(payload)}.lock`;
    await mkdir(lockDirectory, { mode: 0o700, recursive: true });
    const unexpectedOwner = join(lockDirectory, "unexpected");
    await writeFile(unexpectedOwner, "not owner metadata", { mode: 0o600 });
    const oldDate = new Date(Date.now() - 60_000);
    await utimes(lockDirectory, oldDate, oldDate);
    await utimes(unexpectedOwner, oldDate, oldDate);

    const result = await handleAgentHookEvent(
      "PreToolUse",
      {
        session_id: payload.session_id,
        tool_input: { file_path: "README.md" },
        tool_name: "Read",
      },
      fixture.options
    );

    expect(result.output.systemMessage).toContain("invalid session state lock owner");
    expect(result.output.hookSpecificOutput?.permissionDecision).toBeUndefined();
    expect(existsSync(join(lockDirectory, "unexpected"))).toBe(true);
  });

  it("rejects a stale commit and preserves the successor lock owner", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const payload = { session_id: "aba-lock" };
    const lockDirectory = `${sessionStatePath(payload)}.lock`;
    const successorToken = "00000000-0000-4000-8000-000000000001";
    const successorName = `owner-${successorToken}.json`;

    expect(() =>
      withSessionState(payload, (state) => {
        const [ownerName] = readdirSync(lockDirectory);
        const ownerPath = join(lockDirectory, ownerName);
        const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
        expect(Object.keys(owner).sort()).toEqual(["acquiredAt", "pid", "token"]);
        if (process.platform !== "win32") {
          expect(statSync(lockDirectory).mode % 0o1000).toBe(0o700);
          expect(statSync(ownerPath).mode % 0o1000).toBe(0o600);
        }

        unlinkSync(ownerPath);
        writeFileSync(
          join(lockDirectory, successorName),
          `${JSON.stringify({ acquiredAt: new Date().toISOString(), pid: process.pid, token: successorToken })}\n`,
          { mode: 0o600 }
        );
        state.turnSequence = 7;
        return { state };
      })
    ).toThrow("lost session state lock ownership");

    expect(readdirSync(lockDirectory)).toEqual([successorName]);
    expect(existsSync(sessionStatePath(payload))).toBe(false);
    unlinkSync(join(lockDirectory, successorName));
    rmdirSync(lockDirectory);
  });

  it("does not rewrite state for no-op events", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const payload = { session_id: "no-op-state" };
    refreshSessionState(payload);
    const file = sessionStatePath(payload);
    const before = (await stat(file)).mtimeMs;

    await handleAgentHookEvent(
      "PreToolUse",
      {
        session_id: payload.session_id,
        tool_input: { file_path: "README.md" },
        tool_name: "Read",
      },
      fixture.options
    );

    expect((await stat(file)).mtimeMs).toBe(before);
  });

  it("inspects state without repairing file mode and preserves malformed warnings", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const valid = { session_id: "read-only-inspection" };
    refreshSessionState(valid);
    const validFile = sessionStatePath(valid);
    if (process.platform !== "win32") {
      fs.chmodSync(validFile, 0o644);
    }

    const validRecord = inspectSessionState(valid);

    expect(validRecord.found).toBe(true);
    expect(validRecord.warning).toBeUndefined();
    expect(validRecord.state.sessionId).toBe(valid.session_id);
    if (process.platform !== "win32") {
      expect(statSync(validFile).mode % 0o1000).toBe(0o644);
    }

    const malformed = { session_id: "read-only-malformed" };
    const malformedFile = sessionStatePath(malformed);
    await writeFile(malformedFile, "{not-json", { mode: 0o600 });
    const malformedRecord = inspectSessionState(malformed);

    expect(malformedRecord.found).toBe(true);
    expect(malformedRecord.warning).toContain("ignored invalid JSON");
    expect(malformedRecord.state.sessionId).toBe(malformed.session_id);
    expect(inspectSessionState({ session_id: "missing-inspection" }).found).toBe(false);
  });

  it("expires state after 24 hours and treats malformed state as empty with a warning", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const expired = { session_id: "expired-state" };
    refreshSessionState(expired);
    const expiredFile = sessionStatePath(expired);
    const expiredValue = JSON.parse(await readFile(expiredFile, "utf8"));
    expiredValue.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await writeFile(expiredFile, `${JSON.stringify(expiredValue)}\n`, { mode: 0o600 });

    expect(readSessionState(expired).sessionId).toBe(expired.session_id);
    expect(existsSync(expiredFile)).toBe(true);
    await handleAgentHookEvent(
      "PreToolUse",
      {
        session_id: expired.session_id,
        tool_input: { file_path: "README.md" },
        tool_name: "Read",
      },
      fixture.options
    );
    expect(Date.parse(JSON.parse(await readFile(expiredFile, "utf8")).updatedAt)).toBeGreaterThan(
      Date.parse(expiredValue.updatedAt)
    );

    const malformed = { session_id: "malformed-state" };
    const malformedFile = sessionStatePath(malformed);
    await mkdir(dirname(malformedFile), { recursive: true, mode: 0o700 });
    await writeFile(malformedFile, "{not-json", { mode: 0o600 });
    const result = await handleAgentHookEvent(
      "PreToolUse",
      {
        session_id: malformed.session_id,
        tool_input: { file_path: "README.md" },
        tool_name: "Read",
      },
      fixture.options
    );
    expect(result.output.systemMessage).toContain("ignored invalid JSON");
    expect(JSON.parse(await readFile(malformedFile, "utf8"))).toMatchObject({
      sessionId: malformed.session_id,
    });
  });

  it("bounds state to 20 turns and 50 evidence entries", () => {
    const at = new Date().toISOString();
    const turns = Object.fromEntries(
      Array.from({ length: 25 }, (_, turnIndex) => [
        `turn-${turnIndex}`,
        {
          createdAt: at,
          evidence: Array.from({ length: 4 }, (_, evidenceIndex) => ({
            at,
            domain: `test-${turnIndex}-${evidenceIndex}`,
            outcome: "failure",
          })),
        },
      ])
    );
    const state = normalizeState(
      {
        createdAt: at,
        currentTurnId: "turn-24",
        sessionId: "bounded",
        turnSequence: 25,
        turns,
        updatedAt: at,
      },
      "bounded"
    );

    expect(Object.keys(state.turns)).toHaveLength(20);
    expect(Object.values(state.turns).flatMap((turn) => turn.evidence)).toHaveLength(50);
    expect(state.turns).toHaveProperty("turn-24");
  });

  it("resets and removes lifecycle state without standing context", async () => {
    const fixture = await hookFixture();
    process.env.STATE_DIR = fixture.stateDir;
    const payload = { session_id: "lifecycle" };

    expect(handleSessionLifecycleEvent("SessionStart", payload, fixture.options).stdout).toBe("");
    expect(existsSync(sessionStatePath(payload))).toBe(true);
    withSessionState(payload, (state) => {
      state.turnSequence = 9;
      return { state };
    });
    expect(
      handleSessionLifecycleEvent("SessionStart", { ...payload, source: "resume" }, fixture.options)
        .stdout
    ).toBe("");
    expect(readSessionState(payload).turnSequence).toBe(0);
    expect(handleSessionLifecycleEvent("SessionEnd", payload, fixture.options).stdout).toBe("");
    expect(existsSync(sessionStatePath(payload))).toBe(false);
  });
});

describe("hook output contracts", () => {
  it("maps only positive decisions to blocking output", () => {
    expect(shapeHookResult("PreToolUse", { deny: "unsafe" }).output).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "unsafe" },
    });
    expect(shapeHookResult("Stop", {}, "codex").stdout).toBe("{}\n");
  });
});

interface HookFixture {
  codexFastmcpSkill: string;
  fastmcpSkill: string;
  options: { root: string; runtime: "claude" | "codex" };
  root: string;
  skillSource: string;
  stateDir: string;
}

async function hookFixture(): Promise<HookFixture> {
  const root = await mkdtemp(join(tmpdir(), "supa-agent-hook-root-"));
  const stateDir = await mkdtemp(join(tmpdir(), "supa-agent-hook-state-"));
  const fastmcpSkill = join(root, ".claude", "skills", "fastmcp", "SKILL.md");
  const codexFastmcpSkill = join(root, ".agents", "skills", "fastmcp", "SKILL.md");
  await Promise.all([
    mkdir(dirname(fastmcpSkill), { recursive: true }),
    mkdir(dirname(codexFastmcpSkill), { recursive: true }),
  ]);
  const skillSource = [
    "---",
    "name: fastmcp",
    "description: Maintain the local FastMCP server.",
    "metadata:",
    "  keywords:",
    '    - "fast mcp"',
    "---",
    "",
    "# FastMCP",
    "",
    "Use the parser-backed workflow.",
    "",
  ].join("\n");
  await Promise.all([
    writeFile(fastmcpSkill, skillSource),
    writeFile(codexFastmcpSkill, skillSource),
  ]);
  return {
    codexFastmcpSkill,
    fastmcpSkill,
    options: { root, runtime: "claude" },
    root,
    skillSource,
    stateDir,
  };
}

async function postTool(
  sessionId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  fixture: HookFixture,
  toolResponse: unknown = {}
) {
  return await handleAgentHookEvent(
    "PostToolUse",
    {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      tool_input: toolInput,
      tool_name: toolName,
      tool_response: toolResponse,
    },
    fixture.options
  );
}

async function failedCommand(sessionId: string, command: string, fixture: HookFixture) {
  return await handleAgentHookEvent(
    "PostToolUseFailure",
    {
      hook_event_name: "PostToolUseFailure",
      session_id: sessionId,
      tool_input: { command },
      tool_name: "Bash",
    },
    fixture.options
  );
}

async function successfulCommand(
  sessionId: string,
  command: string,
  fixture: HookFixture,
  toolResponse: Record<string, unknown> = {}
) {
  return await postTool(sessionId, "Bash", { command }, fixture, toolResponse);
}

async function stop(sessionId: string, message: string, fixture: HookFixture) {
  return await handleAgentHookEvent(
    "Stop",
    { last_assistant_message: message, session_id: sessionId },
    fixture.options
  );
}
