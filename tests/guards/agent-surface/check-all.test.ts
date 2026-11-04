import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { check, runAgentSurfaceSyncGuard } from "../../../scripts/guards/check-all.mts";
import { agentSurfaceTargetPaths } from "../../../scripts/skills/agent-surface-safety.mts";
import { tempGuardRepo } from "../fixture.js";

function write(root: string, file: string, content: string): void {
  mkdirSync(join(root, dirname(file)), { recursive: true });
  writeFileSync(join(root, file), content);
}

function trackedRepo(files: Record<string, string>): string {
  const root = tempGuardRepo(files);
  execFileSync("git", ["add", ...Object.keys(files)], { cwd: root, stdio: "ignore" });
  return root;
}

describe("aggregate generated-surface drift guard", { timeout: 20_000 }, () => {
  it("derives every projection target, including Codex hook registration, from the manifest", () => {
    expect(agentSurfaceTargetPaths()).toEqual(
      expect.arrayContaining([
        ".agents/skills",
        ".codex/agents",
        ".codex/hooks",
        ".codex/hooks.json",
        ".codex/rules",
        "agent-bundle",
        "skills",
      ])
    );
  });

  it("fails after the writer changes an already-dirty tracked projection", () => {
    const root = trackedRepo({ ".codex/hooks.json": "committed\n" });
    write(root, ".codex/hooks.json", "pre-existing generated change\n");
    const commands: string[] = [];

    expect(() =>
      check(root, (command: string, args: string[]) => {
        commands.push([command, ...args].join(" "));
        if (command === "npm" && args.join(" ") === "run sync:llm") {
          write(root, ".codex/hooks.json", "writer repair\n");
        }
      })
    ).toThrow(".codex/hooks.json (tracked projection changed)");
    expect(commands).toEqual(["npm run sync:llm"]);
  });

  it("fails after the writer creates a nonignored untracked projection", () => {
    const root = trackedRepo({ "README.md": "fixture\n" });

    expect(() =>
      runAgentSurfaceSyncGuard(root, () => {
        write(root, ".codex/rules/generated.rules", "generated\n");
      })
    ).toThrow(".codex/rules/generated.rules (new untracked projection)");
  });

  it("fails after the writer creates a git-ignored projection", () => {
    const root = trackedRepo({
      ".gitignore": ".codex/hooks/*\n",
      "README.md": "fixture\n",
    });

    expect(() =>
      runAgentSurfaceSyncGuard(root, () => {
        write(root, ".codex/hooks/generated.mjs", "generated\n");
      })
    ).toThrow(".codex/hooks/generated.mjs (new untracked projection)");
  });

  it("rejects a generated target-root symlink before running the writer", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = trackedRepo({ "README.md": "fixture\n" });
    const outside = mkdtempSync(join(tmpdir(), "supa-agent-target-outside-"));
    write(outside, "sentinel.txt", "keep\n");
    mkdirSync(join(root, ".agents"), { recursive: true });
    symlinkSync(outside, join(root, ".agents/skills"), "dir");
    let writerRan = false;

    expect(() =>
      runAgentSurfaceSyncGuard(root, () => {
        writerRan = true;
      })
    ).toThrow(".agents/skills: symbolic links are not allowed");
    expect(writerRan).toBe(false);
    expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("keep\n");
  });

  it("rejects a source-root symlink before running the writer", () => {
    if (process.platform === "win32") {
      return;
    }

    const root = trackedRepo({ "README.md": "fixture\n" });
    const outside = mkdtempSync(join(tmpdir(), "supa-agent-source-outside-"));
    write(outside, "sentinel.txt", "external secret\n");
    mkdirSync(join(root, ".claude"), { recursive: true });
    symlinkSync(outside, join(root, ".claude/skills"), "dir");
    let writerRan = false;

    expect(() =>
      runAgentSurfaceSyncGuard(root, () => {
        writerRan = true;
      })
    ).toThrow(".claude/skills: symbolic links are not allowed");
    expect(writerRan).toBe(false);
    expect(readFileSync(join(outside, "sentinel.txt"), "utf8")).toBe("external secret\n");
  });

  it("rejects nested file symlinks and non-directory target roots", () => {
    if (process.platform === "win32") {
      return;
    }

    const symlinkRoot = trackedRepo({ "README.md": "fixture\n" });
    const outside = mkdtempSync(join(tmpdir(), "supa-agent-file-outside-"));
    const sentinel = join(outside, "sentinel.mjs");
    writeFileSync(sentinel, "keep\n");
    mkdirSync(join(symlinkRoot, ".codex/hooks"), { recursive: true });
    symlinkSync(sentinel, join(symlinkRoot, ".codex/hooks/generated.mjs"));

    expect(() => runAgentSurfaceSyncGuard(symlinkRoot, () => undefined)).toThrow(
      ".codex/hooks/generated.mjs: symbolic links are not allowed"
    );
    expect(readFileSync(sentinel, "utf8")).toBe("keep\n");

    const fileRoot = trackedRepo({ "README.md": "fixture\n" });
    write(fileRoot, ".codex/hooks", "not a directory\n");
    expect(() => runAgentSurfaceSyncGuard(fileRoot, () => undefined)).toThrow(
      ".codex/hooks: expected a directory"
    );
  });

  it("allows unrelated dirt and already-correct generated changes", () => {
    const root = trackedRepo({
      ".codex/hooks.json": "committed\n",
      ".gitignore": ".agents/skills/local-cache/\n",
      "README.md": "committed\n",
    });
    write(root, ".codex/hooks.json", "already-correct generated change\n");
    write(root, ".agents/skills/local/SKILL.md", "already-correct untracked projection\n");
    write(root, ".agents/skills/local-cache/state.json", "ignored local state\n");
    write(root, "README.md", "unrelated tracked change\n");
    write(root, "notes.txt", "unrelated untracked change\n");

    expect(() => runAgentSurfaceSyncGuard(root, () => undefined)).not.toThrow();
  });
});
