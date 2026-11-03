#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generatedFiles = ["supaschema-config.schema.json", "bin/config-contract.mjs"];

function npmInvocation(args: string[]): { args: string[]; command: string } {
  const execpath = process.env.npm_execpath;
  return execpath
    ? { args: [execpath, ...args], command: process.execPath }
    : { args, command: process.platform === "win32" ? "npm.cmd" : "npm" };
}

function run(command: string, args: string[], label: string): number {
  const result = spawnSync(command, args, {
    cwd: packageRoot,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`check:schema: failed to run ${label}: ${result.error.message}`);
    process.exit(1);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    return result.status;
  }
  return 0;
}

function readGeneratedFiles(): Map<string, string | undefined> {
  return new Map(
    generatedFiles.map((file): [string, string | undefined] => {
      const path = resolve(packageRoot, file);
      return [file, existsSync(path) ? readFileSync(path, "utf8") : undefined];
    })
  );
}

const before = readGeneratedFiles();
const build = npmInvocation(["run", "build"]);
const buildStatus = run(build.command, build.args, "npm run build");
if (buildStatus !== 0) {
  console.error("check:schema: build failed; cannot regenerate config schema.");
  process.exit(buildStatus);
}

const after = readGeneratedFiles();
const drifted = generatedFiles.filter((file) => before.get(file) !== after.get(file));
if (drifted.length > 0) {
  console.error(
    `\ncheck:schema: generated config contract files are out of date. Run \`npm run build\` and commit ${drifted.join(", ")}.`
  );
  process.exit(1);
}

console.log(`check:schema: ${generatedFiles.join(", ")} are up to date.`);
