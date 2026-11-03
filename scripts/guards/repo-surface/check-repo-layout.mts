#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, ok } from "../lib/assertions.mts";
import { exists, gitFiles, ROOT } from "../lib/repository.mts";

const dumpTerms = ["shared", "utils", "helpers", "common", "misc"];
const privateDirectoryException = "supabase/functions/_shared";

function forbiddenDirName(name: string, pathName: string): boolean {
  if (pathName === privateDirectoryException) {
    return false;
  }
  return dumpTerms.includes(name.toLowerCase()) || name.startsWith("_");
}

function forbiddenFileConcept(concept: string, ancestors: readonly string[]): boolean {
  if (
    dumpTerms.includes(concept) ||
    concept === "payload" ||
    concept.endsWith("-payload") ||
    concept.startsWith("query-") ||
    concept.endsWith("-utils") ||
    concept.endsWith("-helpers")
  ) {
    return true;
  }
  return ancestors.some((ancestor) => concept.startsWith(`${ancestor.toLowerCase()}-`));
}

export function check(root = ROOT): void {
  const files = gitFiles(root).filter((file) => exists(file, root));
  const directories = populatedDirectories(files);
  const violations = new Set(
    [".claude/rules/00-supaschema.md", ".codex/rules/00-supaschema.rules"].filter((file) =>
      files.includes(file)
    )
  );
  for (const file of files) {
    for (const violation of fileLayoutViolations(file, directories)) {
      violations.add(violation);
    }
  }
  assert(
    violations.size === 0,
    `authored paths must have one owner, one path context, canonical concept names, and paired client/server boundaries:\n${[...violations].join("\n")}`
  );
}

function populatedDirectories(files: readonly string[]): Set<string> {
  const directories = new Set<string>();
  for (const file of files) {
    let current = "";
    for (const segment of file.split("/").slice(0, -1)) {
      current = current ? `${current}/${segment}` : segment;
      directories.add(current);
    }
  }
  return directories;
}

function fileLayoutViolations(file: string, directories: ReadonlySet<string>): string[] {
  const segments = file.split("/");
  const filename = segments.pop() ?? "";
  const violations = directoryViolations(segments, directories);
  const firstDot = filename.indexOf(".");
  const concept = (firstDot === -1 ? filename : filename.slice(0, firstDot)).toLowerCase();
  return forbiddenFileConcept(concept, segments) ? [...violations, file] : violations;
}

function directoryViolations(
  segments: readonly string[],
  directories: ReadonlySet<string>
): string[] {
  const violations: string[] = [];
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (forbiddenDirName(segment, current)) {
      violations.push(current);
    }
    if (segment === "server" && !directories.has(siblingClient(current))) {
      violations.push(current);
    }
  }
  return violations;
}

function siblingClient(server: string): string {
  const slash = server.lastIndexOf("/");
  return slash === -1 ? "client" : `${server.slice(0, slash)}/client`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  check();
  ok("REPO_LAYOUT_OK");
}
