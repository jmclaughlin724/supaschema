import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main as formatMain, validateFormatTargets } from "../scripts/format.mts";
import {
  collectRepoFiles,
  isRepositoryContextPath,
  LOCAL_BIOME_PATHS,
  LOCAL_REPOSITORY_FILES,
  LOCAL_REPOSITORY_PREFIXES,
  REPOSITORY_DENY_SEGMENTS,
} from "../scripts/lib/repo-files.mts";
import { main as lintMain, parseLintArguments } from "../scripts/lint.mts";

const temporaryRoots: string[] = [];

describe("formatter file discovery", () => {
  afterEach(async () => {
    await Promise.all(
      temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
    );
  });

  it("returns tracked and unignored files scoped to the requested roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "supaschema-formatter-files-"));
    temporaryRoots.push(root);
    await Promise.all([
      mkdir(join(root, ".claude/worktrees/other"), { recursive: true }),
      mkdir(join(root, ".private"), { recursive: true }),
      mkdir(join(root, "ignored"), { recursive: true }),
      mkdir(join(root, "scripts/stripe"), { recursive: true }),
      mkdir(join(root, "scripts"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(root, ".gitignore"),
        ".claude/worktrees/\n.private/\nignored/\nscripts/stripe/\n"
      ),
      writeFile(join(root, ".claude/worktrees/other/config.toml"), "key = 'worktree'\n"),
      writeFile(join(root, ".private/config.toml"), "key = 'private'\n"),
      writeFile(join(root, "ignored/config.toml"), "key = 'ignored'\n"),
      writeFile(join(root, "scripts/stripe/local.mjs"), "export {};\n"),
      writeFile(join(root, "scripts/tracked.sh"), "echo tracked\n"),
      writeFile(join(root, "scripts/untracked.sh"), "echo untracked\n"),
      writeFile(join(root, "tracked.toml"), "key = 'tracked'\n"),
      writeFile(join(root, "visible.toml"), "key = 'visible'\n"),
    ]);

    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", ".gitignore", "scripts/tracked.sh", "tracked.toml"], {
      cwd: root,
      stdio: "ignore",
    });

    expect(collectRepoFiles(["."], ".toml", { cwd: root })).toEqual([
      "tracked.toml",
      "visible.toml",
    ]);
    expect(collectRepoFiles(["scripts"], ".sh", { cwd: root })).toEqual([
      "scripts/tracked.sh",
      "scripts/untracked.sh",
    ]);
    expect(collectRepoFiles(["scripts/untracked.sh"], ".sh", { cwd: root })).toEqual([
      "scripts/untracked.sh",
    ]);
    expect(collectRepoFiles(["scripts"], ".mjs", { cwd: root })).toEqual([]);
    expect(collectRepoFiles(["."], ".sh", { cwd: join(root, "scripts") })).toEqual([
      "tracked.sh",
      "untracked.sh",
    ]);
  });

  it("keeps local repository and Biome inventory in the shared file owner", () => {
    expect(LOCAL_BIOME_PATHS).toEqual([".claude/skills", ".claude/settings.local.json", ".vscode"]);
    expect(LOCAL_REPOSITORY_FILES).toEqual(
      expect.arrayContaining([".mcp.json", "biome.jsonc", "lsp-soleaux.json", "fastmcp.json"])
    );
    expect(LOCAL_REPOSITORY_PREFIXES).toEqual(
      expect.arrayContaining(["scripts/", "services/", ".claude/rules/"])
    );
    expect(REPOSITORY_DENY_SEGMENTS).toEqual(
      expect.objectContaining({ has: expect.any(Function) })
    );
    expect(REPOSITORY_DENY_SEGMENTS.has("node_modules")).toBe(true);
    expect(isRepositoryContextPath("scripts/stripe/config.mjs")).toBe(true);
    expect(isRepositoryContextPath("scripts/stripe/node_modules/pkg/index.js")).toBe(false);
    expect(isRepositoryContextPath(".private/config.json")).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "does not return a repository symlink that targets an external file",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "supaschema-formatter-symlink-root-"));
      const outside = await mkdtemp(join(tmpdir(), "supaschema-formatter-symlink-outside-"));
      temporaryRoots.push(root, outside);
      await mkdir(join(root, "scripts"), { recursive: true });
      await writeFile(join(outside, "outside.sh"), "echo outside\n");
      await symlink(join(outside, "outside.sh"), join(root, "scripts/escaped.sh"));
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });

      expect(collectRepoFiles(["scripts"], ".sh", { cwd: root })).toEqual([]);
      expect(() => validateFormatTargets(["scripts/escaped.sh"], root)).toThrow(
        "resolves outside the repository"
      );
    }
  );
});

describe("Ultracite runners", () => {
  it("accepts only read-only lint diagnostics arguments", () => {
    expect(parseLintArguments(["--reporter=github", "--max-diagnostics=25"])).toEqual({
      forwardedArgs: ["--reporter=github", "--max-diagnostics=25"],
      useGithubReporter: false,
    });
    for (const argument of [
      "--write",
      "--unsafe",
      "--skip=lint/correctness/noUnresolvedImports",
      "--config-path=other.jsonc",
      "--reporter-file=diagnostics.json",
      "--reporter=json",
    ]) {
      expect(() => parseLintArguments([argument])).toThrow("unsupported lint argument");
    }
    expect(() => parseLintArguments(["--ci", "--reporter=summary"])).toThrow(
      "--ci cannot be combined"
    );
  });

  it("executes visible and bounded local lint passes", () => {
    const calls: Array<{ args: string[]; label: string }> = [];
    const status = lintMain(["--max-diagnostics=25"], (args: string[], label: string) => {
      calls.push({ args, label });
      return 0;
    });

    expect(status).toBe(0);
    expect(calls).toEqual([
      {
        args: ["check", ".", "--max-diagnostics=25"],
        label: "Git-visible repository files",
      },
      {
        args: [
          "check",
          ...LOCAL_BIOME_PATHS,
          "--vcs-use-ignore-file=false",
          "--max-diagnostics=25",
        ],
        label: "ignored local repository files",
      },
    ]);
  });

  it("keeps the full format chain and scoped Ultracite mode behind one owner", async () => {
    const root = await mkdtemp(join(tmpdir(), "supaschema-format-targets-"));
    temporaryRoots.push(root);
    await writeFile(join(root, "target.ts"), "export {};\n");

    expect(validateFormatTargets(["--staged"], root)).toEqual(["--staged"]);
    expect(validateFormatTargets(["target.ts"], root)).toEqual(["target.ts"]);
    expect(() => validateFormatTargets(["--write"], root)).toThrow("repository-relative path");
    expect(() => validateFormatTargets([join(root, "target.ts")], root)).toThrow(
      "repository-relative path"
    );

    const calls: string[] = [];
    const status = formatMain([], {
      runNpmScript: (name: string) => {
        calls.push(`npm:${name}`);
        return 0;
      },
      runUltracite: (args: string[]) => {
        calls.push(`ultracite:${args.join(" ")}`);
        return 0;
      },
    });
    expect(status).toBe(0);
    expect(calls).toEqual([
      "npm:format:json",
      "ultracite:fix .",
      `ultracite:fix ${LOCAL_BIOME_PATHS.join(" ")} --vcs-use-ignore-file=false`,
      "npm:format:md",
      "npm:format:toml",
      "npm:format:sh",
      "npm:py:fix",
    ]);
  });
});
