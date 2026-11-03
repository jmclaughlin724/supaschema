#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCAL_BIOME_PATHS } from "./lib/repo-files.mts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ultraciteBinary = resolve(repositoryRoot, "node_modules", "ultracite", "dist", "index.js");
const maxDiagnosticsPrefix = "--max-diagnostics=";
const reporterArguments = new Set(["--reporter=github", "--reporter=summary"]);

interface LintArguments {
  forwardedArgs: string[];
  useGithubReporter: boolean;
}

function isAsciiDigit(value: string): boolean {
  return value >= "0" && value <= "9";
}

function isMaxDiagnosticsArgument(argument: string): boolean {
  if (!argument.startsWith(maxDiagnosticsPrefix)) {
    return false;
  }
  const count = argument.slice(maxDiagnosticsPrefix.length);
  return count.length > 0 && [...count].every(isAsciiDigit);
}

function isReporterArgument(argument: string): boolean {
  return reporterArguments.has(argument);
}

function runUltracite(args: readonly string[], label: string): number {
  const result = spawnSync(process.execPath, [ultraciteBinary, ...args], {
    cwd: repositoryRoot,
    shell: false,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`lint: failed to run ${label}: ${result.error.message}`);
    return 1;
  }
  if (typeof result.status === "number") {
    return result.status;
  }
  console.error(`lint: ${label} terminated by ${result.signal ?? "an unknown signal"}`);
  return 1;
}

export function parseLintArguments(args: readonly string[]): LintArguments {
  let useGithubReporter = false;
  const forwardedArgs: string[] = [];
  for (const arg of args) {
    if (arg === "--ci") {
      useGithubReporter = true;
      continue;
    }
    if (isMaxDiagnosticsArgument(arg) || isReporterArgument(arg)) {
      forwardedArgs.push(arg);
      continue;
    }
    throw new Error(
      `unsupported lint argument ${JSON.stringify(arg)}; only --ci, --reporter=github|summary, and --max-diagnostics=<count> are allowed`
    );
  }
  if (useGithubReporter && forwardedArgs.some(isReporterArgument)) {
    throw new Error("--ci cannot be combined with a separate --reporter argument");
  }
  return { forwardedArgs, useGithubReporter };
}

export function main(args = process.argv.slice(2), run = runUltracite) {
  let parsed: LintArguments;
  try {
    parsed = parseLintArguments(args);
  } catch (error) {
    console.error(`lint: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const reporterArgs = parsed.useGithubReporter ? ["--reporter=github"] : [];
  const visibleStatus = run(
    ["check", ".", ...reporterArgs, ...parsed.forwardedArgs],
    "Git-visible repository files"
  );
  const localStatus = run(
    [
      "check",
      ...LOCAL_BIOME_PATHS,
      "--vcs-use-ignore-file=false",
      ...reporterArgs,
      ...parsed.forwardedArgs,
    ],
    "ignored local repository files"
  );
  return [visibleStatus, localStatus].find((status) => status !== 0) ?? 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main();
}
