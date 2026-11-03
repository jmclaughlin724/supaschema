import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseJson } from "../../lib/json.mts";
import { run } from "./process.mts";

export const ROOT = path.resolve(resolveRoot());

export function readJson(file: string, root: string): unknown {
  return parseJson(fs.readFileSync(path.join(root, file), "utf8"));
}

export function readText(file: string, root: string): string {
  return fs.readFileSync(path.join(root, file), "utf8");
}

export function exists(file: string, root: string): boolean {
  return fs.existsSync(path.join(root, file));
}

export function gitFiles(root: string): string[] {
  const result = run(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    {},
    root
  );
  return result.stdout.split("\0").filter(Boolean).sort();
}

export function gitTrackedFiles(root: string): string[] {
  const result = run("git", ["ls-files", "-z", "--cached"], {}, root);
  return result.stdout.split("\0").filter(Boolean).sort();
}

function resolveRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  if (result.status === 0) {
    const root = result.stdout.trim();
    if (root.length > 0) {
      return root;
    }
  }
  return process.cwd();
}
