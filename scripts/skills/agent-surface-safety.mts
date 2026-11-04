import fs from "node:fs";
import path from "node:path";
import { errorCode } from "../lib/json.mts";
import { agentSurfaces } from "./agent-surface-manifest.mts";

const canonicalPathsModule = new URL("../../src/paths.ts", import.meta.url);
const { pathContainsOrEqual }: typeof import("../../src/paths.ts") = await import(
  canonicalPathsModule.href
);

type SurfaceKind = "directory" | "file";

interface SourceSpec {
  excludedDirectories?: Set<string>;
  excludeHiddenDirectories?: boolean;
  kind: SurfaceKind;
}

interface TargetPathCheck {
  absoluteTarget: string;
  relativeTarget: string;
  repositoryRealPath: string;
  repositoryRoot: string;
  targetKind: SurfaceKind;
}

interface SourcePathCheck {
  absoluteSource: string;
  relativeSource: string;
  repositoryRealPath: string;
  repositoryRoot: string;
  source: SourceSpec;
}

interface SourceTreeCheck {
  directory: string;
  repositoryRealPath: string;
  repositoryRoot: string;
  source: SourceSpec;
}

const DIRECTORY = "directory";
const FILE = "file";

export function agentSurfaceTargetPaths(): string[] {
  return agentSurfaceTargets().map(([target]) => target);
}

export function assertSafeAgentSurfaceTargets(root: string): void {
  const { repositoryRealPath, repositoryRoot } = resolveRepository(root);

  for (const [relativeTarget, targetKind] of agentSurfaceTargets()) {
    const absoluteTarget = resolveContainedPath(repositoryRoot, relativeTarget, "target");
    assertSafeTargetPath({
      absoluteTarget,
      relativeTarget,
      repositoryRealPath,
      repositoryRoot,
      targetKind,
    });
  }
}

export function assertSafeAgentSurfaceSources(root: string): void {
  const { repositoryRealPath, repositoryRoot } = resolveRepository(root);

  for (const [relativeSource, source] of agentSurfaceSources()) {
    const absoluteSource = resolveContainedPath(repositoryRoot, relativeSource, "source");
    assertSafeSourcePath({
      absoluteSource,
      relativeSource,
      repositoryRealPath,
      repositoryRoot,
      source,
    });
  }
}

function resolveRepository(root: string): { repositoryRealPath: string; repositoryRoot: string } {
  const repositoryRoot = path.resolve(root);
  const rootStats = fs.lstatSync(repositoryRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`agent-surface repository root must be a regular directory: ${repositoryRoot}`);
  }
  return {
    repositoryRealPath: fs.realpathSync(repositoryRoot),
    repositoryRoot,
  };
}

function agentSurfaceTargets(): [string, SurfaceKind][] {
  const targets = new Map<string, SurfaceKind>();
  for (const surface of agentSurfaces()) {
    if (typeof surface.targetFile === "string") {
      registerTarget(targets, surface.targetFile, FILE);
    }
    if (typeof surface.targetRoot === "string") {
      registerTarget(targets, surface.targetRoot, DIRECTORY);
    }
    if (Array.isArray(surface.targetRoots)) {
      for (const targetRoot of surface.targetRoots) {
        registerTarget(targets, targetRoot, DIRECTORY);
      }
    }
  }
  return [...targets].sort(([left], [right]) => left.localeCompare(right));
}

function agentSurfaceSources(): [string, SourceSpec][] {
  const sources = new Map<string, SourceSpec>();
  for (const surface of agentSurfaces()) {
    if (typeof surface.sourceFile === "string") {
      registerSource(sources, surface.sourceFile, { kind: FILE });
    }
    if (typeof surface.sourceRoot === "string") {
      registerSource(sources, surface.sourceRoot, {
        excludedDirectories: new Set(surface.excludedSourceDirectories ?? []),
        excludeHiddenDirectories: surface.excludeHiddenSourceDirectories === true,
        kind: DIRECTORY,
      });
    }
  }
  return [...sources].sort(([left], [right]) => left.localeCompare(right));
}

function registerSource(
  sources: Map<string, SourceSpec>,
  relativeSource: string,
  source: SourceSpec
): void {
  const existing = sources.get(relativeSource);
  if (existing && existing.kind !== source.kind) {
    throw new Error(`agent-surface source has conflicting kinds: ${relativeSource}`);
  }
  sources.set(relativeSource, existing ?? source);
}

function registerTarget(
  targets: Map<string, SurfaceKind>,
  relativeTarget: string,
  targetKind: SurfaceKind
): void {
  const existingKind = targets.get(relativeTarget);
  if (existingKind && existingKind !== targetKind) {
    throw new Error(`agent-surface target has conflicting kinds: ${relativeTarget}`);
  }
  targets.set(relativeTarget, targetKind);
}

function resolveContainedPath(
  repositoryRoot: string,
  relativePath: string,
  surfaceKind: string
): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error(`agent-surface ${surfaceKind} must be repository-relative: ${relativePath}`);
  }
  const absolutePath = path.resolve(repositoryRoot, relativePath);
  const lexicalRelativePath = path.relative(repositoryRoot, absolutePath);
  if (
    lexicalRelativePath.startsWith("..") ||
    path.isAbsolute(lexicalRelativePath) ||
    absolutePath === repositoryRoot
  ) {
    throw new Error(`agent-surface ${surfaceKind} escapes the repository: ${relativePath}`);
  }
  return absolutePath;
}

function assertSafeTargetPath({
  absoluteTarget,
  relativeTarget,
  repositoryRealPath,
  repositoryRoot,
  targetKind,
}: TargetPathCheck): void {
  const pathSegments = path.relative(repositoryRoot, absoluteTarget).split(path.sep);
  let currentPath = repositoryRoot;

  for (const [index, segment] of pathSegments.entries()) {
    currentPath = path.join(currentPath, segment);
    const stats = lstatIfExists(currentPath);
    if (!stats) {
      return;
    }
    const displayPath = display(repositoryRoot, currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error(
        `unsafe generated agent-surface target ${displayPath}: symbolic links are not allowed`
      );
    }
    assertRealPathContained(repositoryRealPath, currentPath, displayPath, "target");

    const isTarget = index === pathSegments.length - 1;
    if (!isTarget || targetKind === DIRECTORY) {
      if (!stats.isDirectory()) {
        throw new Error(
          `unsafe generated agent-surface target ${displayPath}: expected a directory`
        );
      }
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(
        `unsafe generated agent-surface target ${relativeTarget}: expected a regular file`
      );
    }
  }

  if (targetKind === DIRECTORY) {
    assertSafeTargetDirectoryTree(repositoryRoot, repositoryRealPath, absoluteTarget);
  }
}

function assertSafeSourcePath({
  absoluteSource,
  relativeSource,
  repositoryRealPath,
  repositoryRoot,
  source,
}: SourcePathCheck): void {
  const pathSegments = path.relative(repositoryRoot, absoluteSource).split(path.sep);
  let currentPath = repositoryRoot;

  for (const [index, segment] of pathSegments.entries()) {
    currentPath = path.join(currentPath, segment);
    const stats = lstatIfExists(currentPath);
    if (!stats) {
      return;
    }
    const displayPath = display(repositoryRoot, currentPath);
    if (stats.isSymbolicLink()) {
      throw new Error(`unsafe agent-surface source ${displayPath}: symbolic links are not allowed`);
    }
    assertRealPathContained(repositoryRealPath, currentPath, displayPath, "source");

    const isSource = index === pathSegments.length - 1;
    if (!isSource || source.kind === DIRECTORY) {
      if (!stats.isDirectory()) {
        throw new Error(`unsafe agent-surface source ${displayPath}: expected a directory`);
      }
      continue;
    }
    if (!stats.isFile()) {
      throw new Error(`unsafe agent-surface source ${relativeSource}: expected a regular file`);
    }
  }

  if (source.kind === DIRECTORY) {
    assertSafeSourceDirectoryTree({
      directory: absoluteSource,
      repositoryRealPath,
      repositoryRoot,
      source,
    });
  }
}

function assertSafeTargetDirectoryTree(
  repositoryRoot: string,
  repositoryRealPath: string,
  directory: string
): void {
  for (const entry of fs.readdirSync(directory)) {
    const childPath = path.join(directory, entry);
    const childStats = fs.lstatSync(childPath);
    const displayPath = display(repositoryRoot, childPath);
    if (childStats.isSymbolicLink()) {
      throw new Error(
        `unsafe generated agent-surface target ${displayPath}: symbolic links are not allowed`
      );
    }
    assertRealPathContained(repositoryRealPath, childPath, displayPath, "target");
    if (childStats.isDirectory()) {
      assertSafeTargetDirectoryTree(repositoryRoot, repositoryRealPath, childPath);
    } else if (!childStats.isFile()) {
      throw new Error(
        `unsafe generated agent-surface target ${displayPath}: expected a regular file or directory`
      );
    }
  }
}

function assertSafeSourceDirectoryTree({
  directory,
  repositoryRealPath,
  repositoryRoot,
  source,
}: SourceTreeCheck): void {
  for (const entry of fs.readdirSync(directory)) {
    const childPath = path.join(directory, entry);
    const childStats = fs.lstatSync(childPath);
    const displayPath = display(repositoryRoot, childPath);
    if (childStats.isSymbolicLink()) {
      throw new Error(`unsafe agent-surface source ${displayPath}: symbolic links are not allowed`);
    }
    assertRealPathContained(repositoryRealPath, childPath, displayPath, "source");
    if (childStats.isDirectory()) {
      if (
        source.excludedDirectories?.has(entry) ||
        (source.excludeHiddenDirectories && entry.startsWith("."))
      ) {
        continue;
      }
      assertSafeSourceDirectoryTree({
        directory: childPath,
        repositoryRealPath,
        repositoryRoot,
        source,
      });
    } else if (!childStats.isFile()) {
      throw new Error(
        `unsafe agent-surface source ${displayPath}: expected a regular file or directory`
      );
    }
  }
}

function assertRealPathContained(
  repositoryRealPath: string,
  targetPath: string,
  displayPath: string,
  surfaceKind: string
): void {
  const targetRealPath = fs.realpathSync(targetPath);
  if (!pathContainsOrEqual(repositoryRealPath, targetRealPath)) {
    throw new Error(
      `unsafe ${surfaceKind === "target" ? "generated agent-surface target" : "agent-surface source"} ${displayPath}: resolved path escapes the repository`
    );
  }
}

function lstatIfExists(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
}

function display(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}
