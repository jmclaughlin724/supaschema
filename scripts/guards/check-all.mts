#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { errorCode } from "../lib/json.mts";
import {
  agentSurfaceTargetPaths,
  assertSafeAgentSurfaceSources,
  assertSafeAgentSurfaceTargets,
} from "../skills/agent-surface-safety.mts";
import { assert, ok } from "./lib/assertions.mts";
import { run } from "./lib/process.mts";
import { gitFiles, gitTrackedFiles, ROOT } from "./lib/repository.mts";

interface SnapshotEntry {
  content: Buffer | undefined;
  tracked: boolean;
}

type Snapshot = Map<string, SnapshotEntry>;
type RunCommand = typeof run;

const guards: readonly (readonly [string, readonly string[]])[] = [
  ["node", ["scripts/guards/toolchain/check-tooling-stack.mts"]],
  ["node", ["scripts/guards/fastmcp/check-fastmcp-agent.mts"]],
  ["node", ["scripts/guards/repo-surface/check-public-repo-surface.mts"]],
  ["node", ["scripts/guards/toolchain/check-lsp-coverage.mts"]],
  ["node", ["scripts/guards/agent-surface/check-agent-hooks.mts"]],
  ["node", ["scripts/guards/ci-release/check-codex-execpolicy.mts"]],
  ["node", ["scripts/guards/code-shape/check-canonical-surfaces.mts"]],
  ["node", ["scripts/guards/code-shape/check-child-process-shell.mts"]],
  ["node", ["scripts/guards/code-shape/check-path-comparison.mts"]],
  ["node", ["scripts/guards/repo-surface/check-repo-layout.mts"]],
  ["node", ["scripts/guards/agent-surface/check-claude-agents.mts"]],
  ["node", ["scripts/guards/agent-surface/check-hook-import-graph.mts"]],
  ["node", ["scripts/guards/docs-config/check-schema.mts"]],
  ["node", ["scripts/guards/docs-config/check-config-standardization.mts"]],
  ["node", ["scripts/guards/docs-config/check-rule-citations.mts"]],
  ["node", ["scripts/guards/ci-release/check-ci-governance.mts"]],
  ["node", ["scripts/guards/ci-release/check-github-process.mts"]],
  ["node", ["scripts/guards/ci-release/check-release-version-surfaces.mts"]],
];

function isAgentSurfaceTarget(file: string, targets: readonly string[]): boolean {
  return targets.some((target) => file === target || file.startsWith(`${target}/`));
}

function readWorktreeFile(file: string, root: string): Buffer | undefined {
  try {
    return fs.readFileSync(path.join(root, file));
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
}

function filesystemTargetFiles(root: string, targets: readonly string[]): string[] {
  const files = new Set<string>();

  function visit(relativePath: string): void {
    const absolutePath = path.join(root, relativePath);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(absolutePath);
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        return;
      }
      throw error;
    }

    if (stats.isSymbolicLink()) {
      throw new Error(
        `unsafe generated agent-surface target ${relativePath}: symbolic links are not allowed`
      );
    }
    if (stats.isFile()) {
      files.add(relativePath);
      return;
    }
    if (!stats.isDirectory()) {
      throw new Error(
        `unsafe generated agent-surface target ${relativePath}: expected a regular file or directory`
      );
    }
    for (const entry of fs.readdirSync(absolutePath)) {
      visit(path.posix.join(relativePath, entry));
    }
  }

  for (const target of targets) {
    visit(target);
  }
  return [...files].sort((left, right) => left.localeCompare(right));
}

function agentSurfaceWorktreeSnapshot(root: string): Snapshot {
  assertSafeAgentSurfaceSources(root);
  assertSafeAgentSurfaceTargets(root);
  const targets = agentSurfaceTargetPaths();
  const tracked = new Set(
    gitTrackedFiles(root).filter((file) => isAgentSurfaceTarget(file, targets))
  );
  const visible = new Set(gitFiles(root).filter((file) => isAgentSurfaceTarget(file, targets)));
  for (const file of filesystemTargetFiles(root, targets)) {
    visible.add(file);
  }
  return new Map(
    [...visible]
      .sort((left, right) => left.localeCompare(right))
      .map((file): [string, SnapshotEntry] => [
        file,
        {
          content: readWorktreeFile(file, root),
          tracked: tracked.has(file),
        },
      ])
  );
}

function sameSnapshotEntry(
  left: SnapshotEntry | undefined,
  right: SnapshotEntry | undefined
): boolean {
  if (!(left && right) || left.tracked !== right.tracked) {
    return false;
  }
  if (left.content === undefined || right.content === undefined) {
    return left.content === right.content;
  }
  return left.content.equals(right.content);
}

function changedSnapshotPaths(before: Snapshot, after: Snapshot): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((file) => !sameSnapshotEntry(before.get(file), after.get(file)))
    .sort((left, right) => left.localeCompare(right));
}

function changeLabel(
  file: string,
  before: SnapshotEntry | undefined,
  after: SnapshotEntry | undefined
): string {
  if (before === undefined && after?.tracked === false) {
    return `${file} (new untracked projection)`;
  }
  if (before?.tracked === true || after?.tracked === true) {
    return `${file} (tracked projection changed)`;
  }
  return `${file} (untracked projection changed)`;
}

export function runAgentSurfaceSyncGuard(root = ROOT, runCommand: RunCommand = run): void {
  const before = agentSurfaceWorktreeSnapshot(root);
  runCommand("npm", ["run", "sync:llm"], { stdio: "inherit" }, root);
  const after = agentSurfaceWorktreeSnapshot(root);
  const changed = changedSnapshotPaths(before, after);
  assert(
    changed.length === 0,
    `npm run sync:llm changed generated agent surfaces; include the regenerated projections:\n${changed
      .map((file) => changeLabel(file, before.get(file), after.get(file)))
      .join("\n")}`
  );
}

export function check(root = ROOT, runCommand: RunCommand = run): string {
  runAgentSurfaceSyncGuard(root, runCommand);
  for (const [command, args] of guards) {
    runCommand(command, args, { stdio: "inherit" }, root);
  }
  return "ALL_GUARDS_OK";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  ok(check());
}
