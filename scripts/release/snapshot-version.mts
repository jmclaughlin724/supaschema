#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { at, isRecord, type JsonRecord, parseJson, stringAt } from "../lib/json.mts";

export function computeSnapshotVersion(baseVersion: string, sha: string): string {
  const parts = baseVersion.split(".");
  const isStable =
    parts.length === 3 && parts.every((part) => part.length > 0 && [...part].every(isDigit));
  if (!isStable) {
    throw new Error(`snapshot versions require a stable X.Y.Z base version, found ${baseVersion}`);
  }
  const [major, minor, patch] = parts.map(Number);
  const identifier = [...sha].every(isDigit) ? `g${sha}` : sha;
  return `${major}.${minor}.${patch + 1}-dev.${identifier}`;
}

export function snapshotCommitSha(version: unknown): string | null {
  if (typeof version !== "string") {
    return null;
  }
  const marker = "-dev.";
  const markerIndex = version.lastIndexOf(marker);
  if (markerIndex === -1) {
    return null;
  }
  const identifier = version.slice(markerIndex + marker.length);
  const sha =
    identifier.startsWith("g") && identifier.length > 1 && [...identifier.slice(1)].every(isDigit)
      ? identifier.slice(1)
      : identifier;
  return sha.length > 0 && [...sha].every(isHexDigit) ? sha : null;
}

export function stampVersion(
  packageJson: JsonRecord,
  packageJsonPath: string,
  lockfilePath: string,
  version: string
): void {
  packageJson.version = version;
  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);

  const lockfile = readJsonRecord(lockfilePath);
  lockfile.version = version;
  const rootPackage = at(lockfile, "packages", "");
  if (isRecord(rootPackage)) {
    rootPackage.version = version;
  }
  writeFileSync(lockfilePath, `${JSON.stringify(lockfile, null, 2)}\n`);
}

export function probePublished(spec: string, cwd: string): boolean {
  try {
    return (
      execFileSync("npm", ["view", spec, "version"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim() === spec.slice(spec.lastIndexOf("@") + 1)
    );
  } catch (error) {
    const detail = `${String(at(error, "stderr") ?? "")}${stringAt(error, "message") ?? ""}`;
    if (detail.includes("E404")) {
      return false;
    }
    throw error;
  }
}

function readJsonRecord(path: string): JsonRecord {
  const value = parseJson(readFileSync(path, "utf8"));
  if (!isRecord(value)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  return value;
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isHexDigit(char: string): boolean {
  return isDigit(char) || (char >= "a" && char <= "f");
}

function main(): void {
  const ROOT = process.cwd();
  const packageJsonPath = join(ROOT, "package.json");
  const lockfilePath = join(ROOT, "package-lock.json");

  const packageJson = readJsonRecord(packageJsonPath);
  const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
  const version = computeSnapshotVersion(stringAt(packageJson, "version") ?? "", sha);
  const spec = `${packageJson.name}@${version}`;

  const published = probePublished(spec, ROOT);

  stampVersion(packageJson, packageJsonPath, lockfilePath, version);

  console.log(`version=${version}`);
  console.log(`published=${published}`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
