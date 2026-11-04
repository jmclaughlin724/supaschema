#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { list, parseFrontmatter, scalar } from "../../lib/frontmatter.mts";
import { assert, ok } from "../lib/assertions.mts";
import { gitTrackedFiles, ROOT } from "../lib/repository.mts";

const forbiddenFragments = ["Anilize", "anilize", "@anilize"];
const permissionModes = new Set([
  "default",
  "acceptEdits",
  "auto",
  "dontAsk",
  "bypassPermissions",
  "plan",
]);

function isKebabName(value: string): boolean {
  return value.length > 0 && isLowercaseAscii(value[0] ?? "") && [...value].every(isKebabChar);
}

function isKebabChar(char: string): boolean {
  return isLowercaseAscii(char) || isDigit(char) || char === "-";
}

function isLowercaseAscii(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 97 && code <= 122;
}

function isDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

export function check(root = ROOT): string {
  const agentDir = path.join(root, ".claude/agents");
  const skillDir = path.join(root, ".claude/skills");
  const trackedFiles = gitTrackedFiles(root);
  const agentFiles = trackedFiles
    .filter((file) => file.startsWith(".claude/agents/") && file.endsWith(".md"))
    .sort((left, right) => Number(left > right) - Number(left < right));
  if (agentFiles.length === 0 || !fs.existsSync(path.join(root, ".claude/settings.json"))) {
    return "CLAUDE_AGENTS_SKIPPED_PRIVATE_SURFACE";
  }
  const availableSkills = new Set(listDirectories(skillDir, root, trackedFiles));
  const names = new Map<string, string>();

  assert(fs.existsSync(agentDir), ".claude/agents must exist");

  for (const relativePath of agentFiles) {
    const text = fs.readFileSync(path.join(root, relativePath), "utf8");
    for (const fragment of forbiddenFragments) {
      assert(!text.includes(fragment), `${relativePath} must not reference ${fragment}`);
    }

    const frontmatter = parseFrontmatter(text, relativePath).frontmatter;
    const name = scalar(frontmatter, "name");
    const description = scalar(frontmatter, "description");
    const permissionMode = scalar(frontmatter, "permissionMode");
    assert(name !== undefined, `${relativePath} missing required name`);
    assert(description !== undefined, `${relativePath} missing required description`);
    assert(isKebabName(name ?? ""), `${relativePath} name must be lowercase kebab-case`);
    assert(
      permissionMode === undefined || permissionModes.has(permissionMode),
      `${relativePath} permissionMode must be one of ${[...permissionModes].join(", ")}`
    );
    assert(
      !names.has(name),
      `${relativePath} duplicates agent name ${name} from ${names.get(name)}`
    );
    names.set(name, relativePath);

    for (const skill of list(frontmatter, "skills")) {
      assert(availableSkills.has(skill), `${relativePath} references missing skill ${skill}`);
    }
  }

  return "CLAUDE_AGENTS_OK";
}

function listDirectories(dir: string, root: string, trackedFiles: readonly string[]): string[] {
  const relativeRoot = path.relative(root, dir);
  return trackedFiles
    .filter((file) => file.startsWith(`${relativeRoot}/`) && path.basename(file) === "SKILL.md")
    .map((file) => path.relative(relativeRoot, path.dirname(file)))
    .filter((name) => !name.includes(path.sep))
    .sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  ok(check());
}
