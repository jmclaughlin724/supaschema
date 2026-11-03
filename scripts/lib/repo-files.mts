import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

export const LOCAL_REPOSITORY_FILES = [
  "package.json",
  "package-lock.json",
  "pyproject.toml",
  "uv.lock",
  "fastmcp.json",
  "tsconfig.json",
  "tsconfig.src.json",
  "tsconfig.tools.json",
  "biome.jsonc",
  "supaschema.config.json",
  "wrangler.toml",
  "action.yml",
  "AGENTS.md",
  "CLAUDE.md",
  ".mcp.json",
  "lsp-soleaux.json",
  ".claude/settings.json",
  ".codex/config.toml",
  ".codex/hooks.json",
  "lefthook.yml",
];

export const LOCAL_REPOSITORY_PREFIXES = [
  "src/",
  "tests/",
  "scripts/",
  "docs/",
  "examples/",
  "corpus/",
  "benchmarks/",
  "bin/",
  "services/",
  ".github/workflows/",
  ".claude/rules/",
  ".claude/skills/fastmcp/",
  ".claude/skills/optimizer/",
  ".claude/skills/supaschema/",
  ".claude/skills/upstream/",
  ".claude/hooks/",
  ".codex/rules/",
  ".codex/hooks/",
  ".agents/skills/fastmcp/",
  ".agents/skills/optimizer/",
  ".agents/skills/supaschema/",
  ".agents/skills/upstream/",
];

export const REPOSITORY_DENY_SEGMENTS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".venv",
  "__pycache__",
  "dist",
  "build",
  "coverage",
  ".tmp",
  "plans",
]);

export const LOCAL_BIOME_PATHS = [".claude/skills", ".claude/settings.local.json", ".vscode"];

export function isRepositoryContextPath(file: string): boolean {
  if (LOCAL_REPOSITORY_FILES.includes(file)) {
    return true;
  }
  if (!LOCAL_REPOSITORY_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    return false;
  }
  return !file.split("/").some((segment) => REPOSITORY_DENY_SEGMENTS.has(segment));
}

function repositoryPathContainsOrEqual(root: string, file: string): boolean {
  return root === "" || file === root || file.startsWith(`${root}/`);
}

function isRegularWorkingTreeRecord(record: string): boolean {
  const metadataEnd = record.indexOf("\t");
  if (metadataEnd === -1) {
    return false;
  }
  const worktreeFieldStart = record.indexOf("w/");
  const worktreeValueStart = worktreeFieldStart + 2;
  return (
    worktreeFieldStart !== -1 &&
    worktreeValueStart < metadataEnd &&
    record[worktreeValueStart] !== " "
  );
}

function repositoryPathFromRecord(record: string): string {
  return record.slice(record.indexOf("\t") + 1);
}

export function collectRepoFiles(
  roots: readonly string[],
  extension: string,
  { cwd = process.cwd() }: { cwd?: string } = {}
): string[] {
  const requestedWorkingDirectory = realpathSync(cwd);
  const repoRoot = realpathSync(
    execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: requestedWorkingDirectory,
      encoding: "utf8",
    }).trim()
  );
  const workingDirectory = resolve(
    repoRoot,
    execFileSync("git", ["rev-parse", "--show-prefix"], {
      cwd: requestedWorkingDirectory,
      encoding: "utf8",
    }).trim()
  );
  const ownedRoots = roots.map((root) =>
    relative(repoRoot, resolve(workingDirectory, root)).split(sep).join("/")
  );
  const output = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--eol", "-z"],
    { cwd: repoRoot, encoding: "utf8" }
  );

  return output
    .split("\0")
    .filter(Boolean)
    .filter(isRegularWorkingTreeRecord)
    .map(repositoryPathFromRecord)
    .filter((file) => file.endsWith(extension))
    .filter((file) => ownedRoots.some((root) => repositoryPathContainsOrEqual(root, file)))
    .map((file) => relative(workingDirectory, resolve(repoRoot, file)).split(sep).join("/"))
    .sort();
}
