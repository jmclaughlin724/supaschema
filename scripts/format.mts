#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existingLocalBiomePaths } from "./lib/repo-files.mts";

const canonicalPathsModule = new URL("../src/paths.ts", import.meta.url);
const { pathContainsOrEqual } = await import(canonicalPathsModule.href);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ultraciteBinary = resolve(repositoryRoot, "node_modules", "ultracite", "dist", "index.js");

function npmInvocation(args: string[]): { args: string[]; command: string } {
  const execpath = process.env.npm_execpath;
  return execpath
    ? { args: [execpath, ...args], command: process.execPath }
    : { args, command: process.platform === "win32" ? "npm.cmd" : "npm" };
}

function run(command: string, args: readonly string[], label: string): number {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`format: failed to run ${label}: ${result.error.message}`);
    return 1;
  }
  if (typeof result.status === "number") {
    return result.status;
  }
  console.error(`format: ${label} terminated by ${result.signal ?? "an unknown signal"}`);
  return 1;
}

function runNpmScript(name: string): number {
  const invocation = npmInvocation(["run", name]);
  return run(invocation.command, invocation.args, `npm run ${name}`);
}

function runUltracite(args: readonly string[], label: string): number {
  return run(process.execPath, [ultraciteBinary, ...args], label);
}

export function validateFormatTargets(
  targets: readonly string[],
  root = repositoryRoot
): readonly string[] {
  if (targets.length === 1 && targets[0] === "--staged") {
    return targets;
  }
  const canonicalRoot = realpathSync(root);
  for (const target of targets) {
    if (target.startsWith("-") || isAbsolute(target)) {
      throw new Error(`scoped format target must be a repository-relative path: ${target}`);
    }
    const absoluteTarget = resolve(canonicalRoot, target);
    if (!existsSync(absoluteTarget)) {
      throw new Error(`scoped format target does not exist: ${target}`);
    }
    if (!pathContainsOrEqual(canonicalRoot, realpathSync(absoluteTarget))) {
      throw new Error(`scoped format target resolves outside the repository: ${target}`);
    }
  }
  return targets;
}

export function main(
  args = process.argv.slice(2),
  dependencies = { runNpmScript, runUltracite },
  localPaths = existingLocalBiomePaths(repositoryRoot)
) {
  if (args.length > 0) {
    let targets: readonly string[];
    try {
      targets = validateFormatTargets(args);
    } catch (error) {
      console.error(`format: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    return dependencies.runUltracite(
      ["fix", ...targets, "--vcs-use-ignore-file=false"],
      "scoped Ultracite fix"
    );
  }
  const fullFormatSteps = [
    () => dependencies.runNpmScript("format:json"),
    () => dependencies.runUltracite(["fix", "."], "Git-visible Ultracite fix"),
    () =>
      localPaths.length === 0
        ? 0
        : dependencies.runUltracite(
            ["fix", ...localPaths, "--vcs-use-ignore-file=false"],
            "ignored local Ultracite fix"
          ),
    () => dependencies.runNpmScript("format:md"),
    () => dependencies.runNpmScript("format:toml"),
    () => dependencies.runNpmScript("format:sh"),
    () => dependencies.runNpmScript("py:fix"),
  ];

  for (const formatStep of fullFormatSteps) {
    const status = formatStep();
    if (status !== 0) {
      return status;
    }
  }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main();
}
