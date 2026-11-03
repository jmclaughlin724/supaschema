#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { at, isRecord, parseJson, recordOf } from "../lib/json.mts";

const ROOT = process.cwd();
const { values } = parseArgs({
  options: {
    "pack-destination": { type: "string" },
    tarball: { type: "string" },
  },
});

const sourceTarball = values.tarball === undefined ? undefined : resolve(values.tarball);
if (!(sourceTarball && existsSync(sourceTarball))) {
  fail("--tarball must point to an existing npm tarball");
}

const packageJson = readJson(join(ROOT, "package.json"));
const repo = repositorySlug(packageJson);
const [owner] = repo.split("/");
const scopedName = `@${owner.toLowerCase()}/${unscopedPackageName(at(packageJson, "name")).toLowerCase()}`;
const packDestination = resolve(values["pack-destination"] ?? dirname(sourceTarball));
const workDir = mkdtempSync(join(tmpdir(), "supaschema-github-package-"));

try {
  execFileSync("tar", ["-xzf", sourceTarball, "-C", workDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const packageDir = join(workDir, "package");
  const manifestPath = join(packageDir, "package.json");
  const manifest = readJson(manifestPath);
  if (!isRecord(manifest)) {
    fail(`${manifestPath} must contain a JSON object`);
  }
  manifest.name = scopedName;
  manifest.publishConfig = {
    ...recordOf(manifest.publishConfig),
    registry: "https://npm.pkg.github.com",
  };
  writeJson(manifestPath, manifest);

  const filename = execFileSync(
    "npm",
    ["pack", packageDir, "--ignore-scripts", "--pack-destination", packDestination, "--silent"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  ).trim();
  const outputPath = resolve(packDestination, filename);
  if (!existsSync(outputPath)) {
    fail(`npm pack did not create ${outputPath}`);
  }
  console.log(outputPath);
} finally {
  rmSync(workDir, { force: true, recursive: true });
}

function repositorySlug(manifest: unknown): string {
  const repositoryField = at(manifest, "repository");
  const repository =
    typeof repositoryField === "string" ? repositoryField : at(repositoryField, "url");
  if (typeof repository !== "string") {
    fail("package.json repository.url is required to derive the GitHub Packages scope");
  }
  const marker = "github.com";
  const markerIndex = repository.lastIndexOf(marker);
  if (markerIndex === -1) {
    fail(`package.json repository.url must point at GitHub: ${repository}`);
  }
  let slug = repository.slice(markerIndex + marker.length);
  if (slug.startsWith(":") || slug.startsWith("/")) {
    slug = slug.slice(1);
  }
  if (slug.endsWith(".git")) {
    slug = slug.slice(0, -4);
  }
  const parts = slug.split("/").filter(Boolean);
  if (parts.length < 2) {
    fail(`package.json repository.url must include owner and repo: ${repository}`);
  }
  return `${parts[0]}/${parts.slice(1).join("/")}`;
}

function unscopedPackageName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) {
    fail("package.json must include a package name");
  }
  if (!name.startsWith("@")) {
    return name;
  }
  const slash = name.indexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

function readJson(path: string): unknown {
  return parseJson(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  console.error(`GITHUB_PACKAGE_TARBALL_FAILED ${message}`);
  process.exit(1);
}
