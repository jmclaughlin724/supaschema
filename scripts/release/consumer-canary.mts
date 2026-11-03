#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { recordOf } from "../lib/json.mts";

const DEFAULT_GATES = ["config validate", "types --check", "check"];

type PackageManager = "npm" | "pnpm";

interface CanaryOptions {
  gates: string[];
  ref: string;
  repo: string;
  spec: string;
}

interface GateResult {
  gate: string;
  ok: boolean;
}

export function parseCanaryArgs(argv: readonly string[]): CanaryOptions {
  const gates: string[] = [];
  let repo: string | undefined;
  let ref = "main";
  let spec = "next";
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined || !flag.startsWith("--")) {
      throw new Error(`missing value for ${flag}`);
    }
    if (flag === "--repo") {
      repo = value;
    } else if (flag === "--ref") {
      ref = value;
    } else if (flag === "--spec") {
      spec = value;
    } else if (flag === "--gate") {
      gates.push(value);
    } else {
      throw new Error(`unknown argument ${flag}`);
    }
    index += 1;
  }
  if (repo === undefined) {
    throw new Error("--repo is required (owner/name or a git URL)");
  }
  return { gates: gates.length === 0 ? DEFAULT_GATES : gates, ref, repo, spec };
}

export function detectPackageManager(consumerRoot: string): PackageManager {
  if (existsSync(join(consumerRoot, "pnpm-workspace.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(consumerRoot, "package-lock.json"))) {
    return "npm";
  }
  throw new Error(
    "consumer has neither pnpm-workspace.yaml nor package-lock.json; unsupported package manager"
  );
}

export function isTarballSpec(spec: string): boolean {
  return spec.endsWith(".tgz");
}

export function isExactVersionSpec(spec: string): boolean {
  return spec.length > 0 && spec[0] >= "0" && spec[0] <= "9";
}

export function resolveSpec(spec: string, cwd: string): string {
  if (isTarballSpec(spec) || isExactVersionSpec(spec)) {
    return spec;
  }
  const resolved = execFileSync("npm", ["view", `supaschema@${spec}`, "version"], {
    cwd,
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .at(-1);
  if (resolved === undefined || resolved.length === 0) {
    throw new Error(`npm view could not resolve supaschema@${spec}`);
  }
  return resolved;
}

export function pnpmOverrideValue(spec: string): string {
  return isTarballSpec(spec) ? `file:${spec}` : spec;
}

export function applyPnpmOverride(workspaceYamlPath: string, spec: string): void {
  const parsed: unknown = parseYaml(readFileSync(workspaceYamlPath, "utf8"));
  const doc = recordOf(parsed);
  doc.overrides = { ...recordOf(doc.overrides), supaschema: pnpmOverrideValue(spec) };
  writeFileSync(workspaceYamlPath, stringifyYaml(doc));
}

export function npmInstallArgs(spec: string): string[] {
  const target = isTarballSpec(spec) ? spec : `supaschema@${spec}`;
  return ["install", target, "--no-save", "--no-audit", "--no-fund"];
}

export function pnpmInstallArgs(): string[] {
  return ["pnpm", "install", "--no-frozen-lockfile"];
}

export function gateArgv(gate: string): string[] {
  return gate.split(" ").filter((part) => part.length > 0);
}

export function cloneTarget(repo: string) {
  const url =
    repo.startsWith("https://") || repo.startsWith("git@") || repo.startsWith("file:")
      ? repo
      : `https://github.com/${repo}.git`;
  if (!url.startsWith("https://")) {
    return { authenticated: false, url };
  }
  try {
    const parsed = new URL(url);
    return {
      authenticated:
        parsed.hostname === "github.com" &&
        parsed.port === "" &&
        parsed.username === "" &&
        parsed.password === "",
      url,
    };
  } catch {
    return { authenticated: false, url };
  }
}

function writeAskpass(): string {
  const script = join(mkdtempSync(join(tmpdir(), "supa-canary-askpass-")), "askpass.sh");
  writeFileSync(
    script,
    '#!/bin/sh\ncase "$1" in\n*Username*) echo x-access-token ;;\n*) printf \'%s\\n\' "$CONSUMER_CANARY_TOKEN" ;;\nesac\n',
    { mode: 0o700 }
  );
  return script;
}

export function cloneConfiguration(
  repo: string,
  token: string | undefined,
  sourceEnv: NodeJS.ProcessEnv = process.env,
  askpass: () => string = writeAskpass
) {
  const target = cloneTarget(repo);
  const { CONSUMER_CANARY_TOKEN: _canaryToken, ...processEnv } = sourceEnv;
  const env: NodeJS.ProcessEnv = { ...processEnv, GIT_TERMINAL_PROMPT: "0" };
  if (token !== undefined && target.authenticated) {
    env.CONSUMER_CANARY_TOKEN = token;
    env.GIT_ASKPASS = askpass();
  }
  return { env, target };
}

function cloneConsumer(
  repo: string,
  ref: string,
  destination: string,
  token: string | undefined
): void {
  const { env, target } = cloneConfiguration(repo, token);
  execFileSync("git", ["clone", "--depth", "1", "--branch", ref, target.url, destination], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runGates(
  consumerRoot: string,
  manager: PackageManager,
  gates: readonly string[],
  env: NodeJS.ProcessEnv
): GateResult[] {
  const results: GateResult[] = [];
  for (const gate of gates) {
    const argv = gateArgv(gate);
    const [command, args] =
      manager === "pnpm"
        ? ["corepack", ["pnpm", "exec", "supaschema", ...argv]]
        : ["npx", ["--yes", "supaschema", ...argv]];
    try {
      execFileSync(command, args, { cwd: consumerRoot, env, stdio: ["ignore", "pipe", "pipe"] });
      results.push({ gate, ok: true });
    } catch {
      results.push({ gate, ok: false });
    }
  }
  return results;
}

function main(): void {
  const options = parseCanaryArgs(process.argv.slice(2));
  const workRoot = mkdtempSync(join(tmpdir(), "supa-canary-"));
  const consumerRoot = join(workRoot, "consumer");
  const token = process.env.CONSUMER_CANARY_TOKEN;
  const spec = isTarballSpec(options.spec)
    ? resolve(options.spec)
    : resolveSpec(options.spec, workRoot);

  cloneConsumer(options.repo, options.ref, consumerRoot, token);
  const { CONSUMER_CANARY_TOKEN: _canaryToken, ...consumerEnv } = process.env;
  const manager = detectPackageManager(consumerRoot);
  if (manager === "pnpm") {
    applyPnpmOverride(join(consumerRoot, "pnpm-workspace.yaml"), spec);
    execFileSync("corepack", pnpmInstallArgs(), {
      cwd: consumerRoot,
      env: consumerEnv,
      stdio: "inherit",
    });
  } else {
    execFileSync("npm", npmInstallArgs(spec), {
      cwd: consumerRoot,
      env: consumerEnv,
      stdio: "inherit",
    });
  }

  const results = runGates(consumerRoot, manager, options.gates, consumerEnv);
  for (const result of results) {
    console.log(`${result.ok ? "PASS" : "FAIL"} ${result.gate}`);
  }
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    console.log(`CONSUMER_CANARY_FAIL ${options.repo}@${options.ref} spec=${spec}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    `CONSUMER_CANARY_OK ${options.repo}@${options.ref} spec=${spec} gates=${results.length}`
  );
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
