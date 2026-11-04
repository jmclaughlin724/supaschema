#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { at, parseJson } from "../lib/json.mts";

type CommandRunner = (args: string[], cwd: string) => string;

interface RunOptions {
  throwOnError?: boolean;
}

interface InstallAttempt {
  attempt: number;
  throwOnError: boolean;
}

interface ProjectFields {
  packageManager?: string;
}

const ROOT = process.cwd();
const packageJson = parseJson(readFileSync(join(ROOT, "package.json"), "utf8"));
const manifestName = at(packageJson, "name");
const packageVersion = at(packageJson, "version");
const spec = process.env.SUPASCHEMA_REGISTRY_SMOKE_SPEC ?? `${manifestName}@${packageVersion}`;
const nodeBinDir = dirname(process.execPath);
const pnpmTool = "pnpm@11.1.2";
const bunTool = "bun@1.3.14";
const commandTimeoutMs = 300_000;
const installAttempts = positiveIntegerEnv("SUPASCHEMA_REGISTRY_SMOKE_INSTALL_ATTEMPTS", 12);
const installRetryDelayMs = positiveIntegerEnv("SUPASCHEMA_REGISTRY_SMOKE_RETRY_DELAY_MS", 5000);
const expectedVersion =
  process.env.SUPASCHEMA_REGISTRY_SMOKE_SPEC === undefined
    ? packageVersion
    : resolveSpecVersionWithRetry(spec);

if (typeof manifestName !== "string" || manifestName.length === 0) {
  fail("package.json must include a package name");
}
if (typeof packageVersion !== "string" || packageVersion.length === 0) {
  fail("package.json must include a package version");
}
const packageName = manifestName;

smokeNpm();
smokePnpm();
smokeBun();

console.log(`REGISTRY_SMOKE_OK ${spec}`);

function smokeNpm(): void {
  const consumer = createProject("supa-registry-npm-", "supaschema-registry-npm");
  installWithRegistryRetry("npm install", ({ attempt, throwOnError }) =>
    runNpm(
      [
        "install",
        spec,
        "--no-audit",
        "--no-fund",
        "--prefer-online",
        "--cache",
        join(consumer, `.npm-cache-${attempt}`),
      ],
      consumer,
      { throwOnError }
    )
  );
  assertVersion((args, cwd) => runNpm(["exec", "--", packageName, ...args], cwd), consumer);
}

function smokePnpm(): void {
  const consumer = createProject("supa-registry-pnpm-", "supaschema-registry-pnpm", {
    packageManager: pnpmTool,
  });
  installWithRegistryRetry("pnpm add", (options) =>
    runTool("corepack", [pnpmTool, "add", spec, "--config.minimumReleaseAge=0"], consumer, options)
  );
  assertVersion(
    (args, cwd) => runTool("corepack", [pnpmTool, "exec", packageName, ...args], cwd),
    consumer
  );
}

function smokeBun(): void {
  const consumer = createProject("supa-registry-bun-", "supaschema-registry-bun", {
    packageManager: bunTool,
  });
  installWithRegistryRetry("bun add", (options) =>
    runTool("bun", ["add", spec], consumer, options)
  );
  const executable = process.platform === "win32" ? `${packageName}.cmd` : packageName;
  assertVersion(
    (args, cwd) => runRaw(join(cwd, "node_modules", ".bin", executable), args, cwd),
    consumer
  );
}

function assertVersion(runner: CommandRunner, cwd: string): void {
  const output = runner(["--version"], cwd).trim();
  const version = lastNonEmptyLine(output);
  if (version !== expectedVersion) {
    fail(`expected ${packageName} ${expectedVersion}, got ${output}`);
  }
}

function resolveSpecVersionWithRetry(spec: string): string {
  let lastError: unknown;
  for (let attempt = 1; attempt <= installAttempts; attempt += 1) {
    try {
      const output = execFileSync("npm", ["view", spec, "version"], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      const version = lastNonEmptyLine(output);
      if (version.length > 0) {
        return version;
      }
      lastError = new Error(`npm view returned no version for ${spec}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < installAttempts) {
      console.error(
        `REGISTRY_SMOKE_RETRY npm view ${spec} attempt=${attempt} nextAttempt=${attempt + 1} delayMs=${installRetryDelayMs}`
      );
      sleep(installRetryDelayMs);
    }
  }
  fail(
    `npm view could not resolve a version for ${spec} after ${installAttempts} attempts\n${String(at(lastError, "message") ?? lastError)}`
  );
}

function lastNonEmptyLine(output: string): string {
  return (
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

function createProject(prefix: string, name: string, extra: ProjectFields = {}): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeJson(join(dir, "package.json"), {
    name,
    private: true,
    version: "0.0.0",
    ...extra,
  });
  return dir;
}

function installWithRegistryRetry(
  label: string,
  install: (attempt: InstallAttempt) => string
): string {
  let lastError: unknown;
  for (let attempt = 1; attempt <= installAttempts; attempt += 1) {
    try {
      return install({ attempt, throwOnError: true });
    } catch (error) {
      lastError = error;
      if (attempt === installAttempts) {
        break;
      }
      console.error(
        `REGISTRY_SMOKE_RETRY ${label} ${spec} attempt=${attempt} nextAttempt=${
          attempt + 1
        } delayMs=${installRetryDelayMs}`
      );
      sleep(installRetryDelayMs);
    }
  }

  fail(
    `${label} could not install ${spec} after ${installAttempts} attempts\n${String(
      at(lastError, "message") ?? lastError
    )}`
  );
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail(`${name} must be a positive integer`);
  }
  return parsed;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function runNpm(args: string[], cwd: string, options?: RunOptions): string {
  const execpath = process.env.npm_execpath;
  return execpath
    ? runRaw(process.execPath, [execpath, ...args], cwd, options)
    : runRaw(commandName("npm"), args, cwd, options);
}

function runTool(name: string, args: string[], cwd: string, options?: RunOptions): string {
  return runRaw(commandName(name), args, cwd, options);
}

function runRaw(file: string, args: string[], cwd: string, options: RunOptions = {}): string {
  try {
    return execFileSync(file, args, {
      cwd,
      encoding: "utf8",
      env: childEnv(),
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: commandTimeoutMs,
    });
  } catch (error) {
    const message = commandFailureMessage(file, args, cwd, error);
    if (options.throwOnError) {
      throw new Error(message, { cause: error });
    }
    fail(message);
  }
}

function commandFailureMessage(file: string, args: string[], cwd: string, error: unknown): string {
  const stdout = String(at(error, "stdout") ?? "");
  const stderr = String(at(error, "stderr") ?? "");
  const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
  const suffix = detail.length > 0 ? `\n${detail}` : "";
  const signal = at(error, "signal");
  const reason = signal ? ` signal=${signal}` : "";
  return `command failed in ${cwd}: ${file} ${args.join(" ")}${reason}${suffix}`;
}

function commandName(name: string): string {
  const executable = process.platform === "win32" ? `${name}.cmd` : name;
  const nodeShim = join(nodeBinDir, executable);
  return existsSync(nodeShim) ? nodeShim : executable;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.INIT_CWD = undefined;
  return env;
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  console.error(`REGISTRY_SMOKE_FAILED ${message}`);
  process.exit(1);
}
