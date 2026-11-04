import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  check,
  hookImportGraph,
  reachableHookDependencies,
} from "../../scripts/guards/agent-surface/check-hook-import-graph.mts";
import { sessionLifecycleEntrypoints } from "../../scripts/guards/agent-surface/hook-topology.mts";

describe("hook import graph", () => {
  it("keeps session lifecycle entrypoints isolated from the non-lifecycle runner", () => {
    const graph = hookImportGraph(process.cwd());
    for (const entrypoint of sessionLifecycleEntrypoints) {
      expect(graph).toContainEqual({
        file: entrypoint,
        kind: "relative",
        specifier: "../../scripts/agent-hooks/session-lifecycle.mts",
        target: "scripts/agent-hooks/session-lifecycle.mts",
      });
      expect(graph).not.toContainEqual(
        expect.objectContaining({
          file: entrypoint,
          target: "scripts/agent-hooks/runner.mts",
        })
      );
      expect(reachableHookDependencies(graph, entrypoint)).not.toContain(
        "scripts/agent-hooks/runner.mts"
      );
    }
  });

  it("rejects an indirect lifecycle dependency on the non-lifecycle runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-hook-import-lifecycle-"));
    await write(
      root,
      ".claude/hooks/context-session-start.mts",
      'import "../../scripts/agent-hooks/session-lifecycle.mts";\n'
    );
    await write(
      root,
      "scripts/agent-hooks/session-lifecycle.mts",
      'import "./lifecycle-bridge.mts";\n'
    );
    await write(root, "scripts/agent-hooks/lifecycle-bridge.mts", 'import "./runner.mts";\n');
    await write(root, "scripts/agent-hooks/runner.mts", "export {};\n");

    const graph = hookImportGraph(root);
    expect(reachableHookDependencies(graph, ".claude/hooks/context-session-start.mts")).toContain(
      "scripts/agent-hooks/runner.mts"
    );
    expect(() => check(root)).toThrow(
      ".claude/hooks/context-session-start.mts reaches non-lifecycle hook runtime"
    );
  });

  it("rejects process-spawning builtins from the lifecycle import closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-hook-import-lifecycle-builtin-"));
    await write(
      root,
      ".claude/hooks/context-session-start.mts",
      'import "../../scripts/agent-hooks/session-lifecycle.mts";\n'
    );
    await write(
      root,
      "scripts/agent-hooks/session-lifecycle.mts",
      'import "node:child_process";\n'
    );

    expect(() => check(root)).toThrow("node:child_process");
  });

  it("rejects bare packages from the lifecycle import closure", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-hook-import-lifecycle-package-"));
    await write(root, "package.json", '{"dependencies":{"zod":"1.0.0"}}\n');
    await write(
      root,
      ".claude/hooks/context-session-start.mts",
      'import "../../scripts/agent-hooks/session-lifecycle.mts";\n'
    );
    await write(root, "scripts/agent-hooks/session-lifecycle.mts", 'import "zod";\n');

    expect(() => check(root)).toThrow("scripts/agent-hooks/session-lifecycle.mts -> zod");
  });

  it("maps multiline imports, re-exports, literal dynamic imports, and builtins", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-hook-import-graph-"));
    await write(
      root,
      ".claude/hooks/example.mjs",
      [
        'import fs from "node:fs";',
        "import {",
        "  shared,",
        '} from "../../scripts/agent-hooks/shared.mjs";',
        'export { lazy } from "./lazy.mjs";',
        'await import("./dynamic.mjs");',
        "void fs;",
        "void shared;",
        "",
      ].join("\n")
    );
    await write(root, ".claude/hooks/lazy.mjs", "export const lazy = true;\n");
    await write(root, ".claude/hooks/dynamic.mjs", "export const dynamic = true;\n");
    await write(root, "scripts/agent-hooks/shared.mjs", "export const shared = true;\n");

    const graph = hookImportGraph(root);

    expect(graph).toHaveLength(4);
    expect(graph).toEqual(
      expect.arrayContaining([
        {
          file: ".claude/hooks/example.mjs",
          kind: "builtin",
          specifier: "node:fs",
        },
        {
          file: ".claude/hooks/example.mjs",
          kind: "relative",
          specifier: "../../scripts/agent-hooks/shared.mjs",
          target: "scripts/agent-hooks/shared.mjs",
        },
        {
          file: ".claude/hooks/example.mjs",
          kind: "relative",
          specifier: "./dynamic.mjs",
          target: ".claude/hooks/dynamic.mjs",
        },
        {
          file: ".claude/hooks/example.mjs",
          kind: "relative",
          specifier: "./lazy.mjs",
          target: ".claude/hooks/lazy.mjs",
        },
      ])
    );
    expect(() => check(root)).not.toThrow();
  });

  it("rejects missing relative and bare runtime dependencies", async () => {
    const missingRoot = await mkdtemp(join(tmpdir(), "supa-hook-import-missing-"));
    await write(missingRoot, ".claude/hooks/example.mjs", 'import "./missing.mjs";\n');
    expect(() => check(missingRoot)).toThrow(
      ".claude/hooks/example.mjs imports missing relative hook dependency ./missing.mjs"
    );

    const bareRoot = await mkdtemp(join(tmpdir(), "supa-hook-import-bare-"));
    await write(bareRoot, ".claude/hooks/example.mjs", 'import "zod";\n');
    expect(() => check(bareRoot)).toThrow(
      ".claude/hooks/example.mjs imports undeclared runtime module zod"
    );
  });

  it("inspects the first argument of dynamic imports with options", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-hook-import-options-"));
    await write(
      root,
      ".claude/hooks/example.mjs",
      'await import("./dynamic.mjs", { with: { type: "json" } });\n'
    );
    await write(root, ".claude/hooks/dynamic.mjs", "export const dynamic = true;\n");

    expect(hookImportGraph(root)).toContainEqual({
      file: ".claude/hooks/example.mjs",
      kind: "relative",
      specifier: "./dynamic.mjs",
      target: ".claude/hooks/dynamic.mjs",
    });
  });

  it("rejects fake node-prefixed builtin specifiers", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-hook-import-builtin-"));
    await write(root, ".claude/hooks/example.mjs", 'import "node:not-a-real-builtin";\n');

    expect(() => check(root)).toThrow(
      ".claude/hooks/example.mjs imports unknown Node builtin node:not-a-real-builtin"
    );
  });

  it("transitively inspects reachable helpers outside hook roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-hook-import-transitive-"));
    await write(root, ".claude/hooks/example.mjs", 'import "../../shared/helper.mjs";\n');
    await write(root, "shared/helper.mjs", 'import "zod";\n');

    expect(() => check(root)).toThrow("shared/helper.mjs imports undeclared runtime module zod");
  });

  it("terminates on cycles in the reachable helper graph", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-hook-import-cycle-"));
    await write(root, ".claude/hooks/example.mjs", 'import "../../shared/helper.mjs";\n');
    await write(root, "shared/helper.mjs", 'import "../.claude/hooks/example.mjs";\n');

    expect(hookImportGraph(root)).toHaveLength(2);
    expect(() => check(root)).not.toThrow();
  });
});

async function write(root: string, relativePath: string, content: string): Promise<void> {
  const file = join(root, relativePath);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}
