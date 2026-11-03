import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { bundleDocsFiles } from "../../scripts/skills/bundle-docs.mts";

const run = promisify(execFile);
const npmExec = (args: string[]): { file: string; args: string[] } => {
  const execpath = process.env.npm_execpath;
  return execpath
    ? { args: [execpath, ...args], file: process.execPath }
    : { args, file: process.platform === "win32" ? "npm.cmd" : "npm" };
};

function packageBinPath(): string {
  const manifest: unknown = JSON.parse(
    readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")
  );
  if (!manifest || typeof manifest !== "object") {
    throw new Error("package.json must be an object");
  }
  const bin = Reflect.get(manifest, "bin");
  if (!bin || typeof bin !== "object") {
    throw new Error("package.json must define bin");
  }
  const supaschema = Reflect.get(bin, "supaschema");
  if (typeof supaschema !== "string") {
    throw new Error("package.json must define bin.supaschema");
  }
  return supaschema;
}

describe("npm package contents", () => {
  it("publishes the compiled CLI as the package binary", () => {
    expect(packageBinPath()).toBe("dist/cli.js");
  });

  it("keeps the generated install-time config contract executable", async () => {
    const mirror = await import(
      pathToFileURL(resolve(import.meta.dirname, "../../bin/config-contract.mjs")).href
    );

    expect(mirror.configSchemaFileName).toBe("supaschema-config.schema.json");
    expect(mirror.createInstalledConfig()).toMatchObject({
      adapter: "auto",
      managedSchemas: [],
      schemaPaths: ["database/schemas"],
      sources: {
        from: "auto",
      },
    });
  });

  it("ships the necessary surface and no build-cache, source, or tooling leaks", {
    timeout: 60_000,
  }, async () => {
    const manifest = JSON.parse(
      readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8")
    );
    for (const script of ["install", "postinstall", "preinstall", "prepare"]) {
      expect(manifest.scripts).not.toHaveProperty(script);
    }

    const { file, args } = npmExec(["pack", "--dry-run", "--json", "--ignore-scripts"]);
    const { stdout } = await run(file, args, { maxBuffer: 32 * 1024 * 1024 });
    const [packed] = JSON.parse(stdout);
    const paths = packed.files.map((file) => file.path);
    const expectedDocs = [...bundleDocsFiles(resolve(import.meta.dirname, "../..")).keys()]
      .map((file) => `agent-bundle/${file}`)
      .sort((left, right) => left.localeCompare(right));
    expect(
      paths
        .filter((file) => file.startsWith("agent-bundle/docs/"))
        .sort((left, right) => left.localeCompare(right))
    ).toEqual(expectedDocs);
    const readmes = paths.filter((path) => path.endsWith("README.md")).sort();
    expect(readmes, "only the root README should ship").toEqual(["README.md"]);

    const required = [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/build-info.json",
      packageBinPath(),
      "bin/scaffold.mjs",
      "bin/config-contract.mjs",
      "supaschema-config.schema.json",
      "agent-bundle/INSTALL.md",
      "agent-bundle/skills-manifest.json",
      "agent-bundle/docs/coding-agents/index.mdx",
      "agent-bundle/docs/index.md",
      "agent-bundle/agents/prompts/supaschema-install.md",
      "agent-bundle/agents/skills/supaschema/references/diagnostics.md",
      "agent-bundle/agents/skills/supaschema/references/maintain.md",
      "agent-bundle/agents/skills/supaschema/references/migrate.md",
      "agent-bundle/agents/skills/supaschema/references/safety.md",
      "agent-bundle/agents/skills/supaschema/references/setup.md",
      "agent-bundle/agents/skills/supaschema/SKILL.md",
      "agent-bundle/claude/rules/supaschema.md",
      "agent-bundle/claude/settings.npm.json",
      "agent-bundle/claude/settings.pnpm.json",
      "agent-bundle/claude/skills/supaschema/references/diagnostics.md",
      "agent-bundle/claude/skills/supaschema/references/maintain.md",
      "agent-bundle/claude/skills/supaschema/references/migrate.md",
      "agent-bundle/claude/skills/supaschema/references/safety.md",
      "agent-bundle/claude/skills/supaschema/references/setup.md",
      "agent-bundle/claude/skills/supaschema/SKILL.md",
      "agent-bundle/codex/hooks.npm.json",
      "agent-bundle/codex/hooks.pnpm.json",
      "agent-bundle/codex/rules/supaschema.rules",
      "README.md",
      "LICENSE",
    ];
    for (const entry of required) {
      expect(paths, `missing required package file: ${entry}`).toContain(entry);
    }
    for (const sourceOnlyHook of [
      "agent-bundle/claude/hooks/sync-llm-on-claude-surface-change.mjs",
      "agent-bundle/claude/hooks/guards/bash-policy-checks.mjs",
      "agent-bundle/codex/hooks/sync-llm-on-claude-surface-change.mjs",
      "agent-bundle/codex/hooks/general-guard.mjs",
      "agent-bundle/codex/hooks/guards/bash-policy-checks.mjs",
    ]) {
      expect(paths, `source-only hook reached npm package: ${sourceOnlyHook}`).not.toContain(
        sourceOnlyHook
      );
    }
    expect(
      paths.filter((path) => path.startsWith("bin/")).sort(),
      "package bin directory should only ship install/config helpers"
    ).toEqual(["bin/config-contract.mjs", "bin/scaffold.mjs"]);
    expect(paths, "postinstall lifecycle setup must not ship").not.toContain("bin/postinstall.mjs");
    const forbiddenInternalAgentPrefixes = [
      ".claude/hooks/context-",
      ".codex/hooks/context-",
      "scripts/agent-hooks/",
    ];
    const internalAgentLeaks = paths.filter((path) =>
      forbiddenInternalAgentPrefixes.some((prefix) => path.startsWith(prefix))
    );
    expect(
      internalAgentLeaks,
      `internal repo-only agent files reached npm tarball: ${internalAgentLeaks.join(", ")}`
    ).toEqual([]);
    for (const activePath of [
      ".agents/prompts/supaschema-install.md",
      ".agents/skills/supaschema/SKILL.md",
      ".claude/rules/supaschema.md",
      ".claude/settings.json",
      ".claude/skills/supaschema/SKILL.md",
      ".codex/hooks.json",
      ".codex/rules/supaschema.rules",
    ]) {
      expect(paths, `active agent path must not ship directly: ${activePath}`).not.toContain(
        activePath
      );
    }
    expect(paths, "pack should include raw Codex hook registration").toContain(
      "agent-bundle/codex/hooks.npm.json"
    );
    const codexHookContents = readFileSync(
      resolve(import.meta.dirname, "../../agent-bundle/codex/hooks.npm.json"),
      "utf8"
    );
    expect(codexHookContents).not.toContain("context-");
    expect(codexHookContents).not.toContain("scripts/agent-hooks");
    expect(codexHookContents).not.toContain("general-guard.mjs");
    expect(codexHookContents).not.toContain("bash-policy-checks.mjs");
    expect(codexHookContents).toContain("supaschema hook generated-artifact-edit");
    expect(codexHookContents).toContain("supaschema hook schema-write");
    expect(codexHookContents).not.toContain("npx --no-install");
    expect(
      paths.filter((path) => path.startsWith(".codex/skills/")),
      "Codex skill duplicates must not ship"
    ).toEqual([]);
    expect(paths, "config-schema.json must not ship").not.toContain("config-schema.json");

    const forbiddenPrefixes = [
      "benchmarks/",
      "corpus/",
      "docs/",
      "examples/",
      "scripts/",
      "services/",
      "skills/",
      "src/",
      "tests/",
    ];
    const isLeak = (path: string): boolean =>
      path.endsWith(".tsbuildinfo") ||
      path.endsWith(".tgz") ||
      path === ".env" ||
      path.startsWith(".env.") ||
      forbiddenPrefixes.some((prefix) => path.startsWith(prefix)) ||
      path.startsWith("node_modules/");
    const leaks = paths.filter(isLeak);
    expect(leaks, `unexpected files in npm tarball: ${leaks.join(", ")}`).toEqual([]);
    const allowedRoots = [
      "agent-bundle/",
      "bin/",
      "dist/",
      "LICENSE",
      "README.md",
      "package.json",
      "supaschema-config.schema.json",
    ];
    const outsideSurface = paths.filter(
      (path) => !allowedRoots.some((root) => path === root || path.startsWith(root))
    );
    expect(
      outsideSurface,
      `files outside the declared publish surface: ${outsideSurface.join(", ")}`
    ).toEqual([]);
    expect(packed.unpackedSize, `npm tarball unpacked bytes: ${packed.unpackedSize}`).toBeLessThan(
      2_100_000
    );
  });
});
