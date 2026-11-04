#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { at, parseJson } from "../../lib/json.mts";
import { assert, ok } from "../lib/assertions.mts";
import { run } from "../lib/process.mts";
import { exists, ROOT } from "../lib/repository.mts";

const privatePaths = parseJson(
  readFileSync(new URL("./private-paths.json", import.meta.url), "utf8")
);
const heldPrivate = at(privatePaths, "heldPrivate");
const agentPrivate = at(privatePaths, "agentPrivate");
assert(
  isTrailingSlashPrefixes(heldPrivate) && isTrailingSlashPrefixes(agentPrivate),
  "private-paths.json must define heldPrivate and agentPrivate arrays of trailing-slash prefixes"
);
const privatePrefixes = [...heldPrivate, ...agentPrivate];

function isTrailingSlashPrefixes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((prefix) => typeof prefix === "string" && prefix.endsWith("/"))
  );
}

const wiredPrefixes = ["scripts/stripe/", "services/agent-mcp/", "services/license-worker/"];
const wiredArtifactDirs = new Set([
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".venv",
  "coverage",
  "dist",
  "node_modules",
]);
const wiredExact = new Set([
  ".codex/config.toml",
  ".github/workflows/python.yml",
  ".mcp.json",
  "fastmcp.json",
  "pyproject.toml",
  "uv.lock",
  "wrangler.toml",
]);
function gitPaths(args: readonly string[], root: string): string[] {
  const separator = args.indexOf("--");
  const argv =
    separator === -1
      ? [...args, "-z"]
      : [...args.slice(0, separator), "-z", ...args.slice(separator)];
  return run("git", argv, {}, root).stdout.split("\0").filter(Boolean).sort();
}

function isPrivateSurface(file: string): boolean {
  return privatePrefixes.some((prefix) => file.startsWith(prefix));
}

function bulletList(files: readonly string[]): string {
  return files.map((file) => `- ${file}`).join("\n");
}

function untrackedWiredSurfaces(
  tracked: readonly string[],
  stageable: readonly string[],
  ignored: readonly string[],
  root: string
): string[] {
  const missing: string[] = [];
  for (const file of wiredExact) {
    if (exists(file, root) && !tracked.includes(file)) {
      missing.push(file);
    }
  }
  for (const prefix of wiredPrefixes) {
    if (exists(prefix, root)) {
      missing.push(...untrackedUnderPrefix(prefix, tracked, stageable, ignored));
    }
  }
  return missing;
}

function untrackedUnderPrefix(
  prefix: string,
  tracked: readonly string[],
  stageable: readonly string[],
  ignored: readonly string[]
): string[] {
  const missing = [
    ...stageable.filter((file) => file.startsWith(prefix)),
    ...ignored.filter((file) => file.startsWith(prefix) && isWiredSource(prefix, file)),
  ];
  if (
    !(
      tracked.some((file) => file.startsWith(prefix)) ||
      missing.some((file) => file.startsWith(prefix))
    )
  ) {
    missing.push(prefix);
  }
  return missing;
}

function isWiredSource(prefix: string, file: string): boolean {
  return !file
    .slice(prefix.length)
    .split("/")
    .some((segment) => wiredArtifactDirs.has(segment));
}

function failureMessage({
  trackedPrivate,
  stageablePrivate,
  untrackedWired,
}: {
  stageablePrivate: readonly string[];
  trackedPrivate: readonly string[];
  untrackedWired: readonly string[];
}): string {
  const sections: string[] = [];
  if (trackedPrivate.length > 0 || stageablePrivate.length > 0) {
    sections.push("private surfaces must stay local-only");
    if (trackedPrivate.length > 0) {
      sections.push(`tracked public GitHub exposure:\n${bulletList(trackedPrivate)}`);
    }
    if (stageablePrivate.length > 0) {
      sections.push(`unignored local files that could be staged:\n${bulletList(stageablePrivate)}`);
    }
    sections.push(
      [
        "FIX BY:",
        "- keep the local files on disk",
        "- add or repair .gitignore coverage for unignored private paths",
        "- remove tracked private paths with git rm --cached -- <path>",
        "- do not delete local skills, agents, rules, or hooks to satisfy this guard",
      ].join("\n")
    );
  }
  if (untrackedWired.length > 0) {
    sections.push("wired maintainer tooling must be tracked, never ignored or untracked");
    sections.push(`present but not tracked:\n${bulletList(untrackedWired)}`);
    sections.push(
      [
        "FIX BY:",
        "- git add the path: tracked files reference it, so tracking keeps agents",
        "  and fresh clones working; do not hide wired surfaces in .gitignore",
        "- or remove every tracked reference to the path in the same change",
      ].join("\n")
    );
  }
  return sections.join("\n\n");
}

export function check(root = ROOT): void {
  const tracked = gitPaths(["ls-files", "--cached"], root);
  const stageable = gitPaths(["ls-files", "--others", "--exclude-standard"], root).filter((file) =>
    exists(file, root)
  );
  const ignored = gitPaths(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--", ...wiredPrefixes],
    root
  );

  const trackedPrivate = tracked.filter(isPrivateSurface);
  const stageablePrivate = stageable.filter(isPrivateSurface);
  const untrackedWired = untrackedWiredSurfaces(tracked, stageable, ignored, root);

  assert(
    trackedPrivate.length === 0 && stageablePrivate.length === 0 && untrackedWired.length === 0,
    failureMessage({ trackedPrivate, stageablePrivate, untrackedWired })
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  check();
  ok("PUBLIC_REPO_SURFACE_OK");
}
