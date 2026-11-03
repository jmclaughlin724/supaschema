#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { arrayOf, at, parseJson, stringAt } from "../lib/json.mts";

type CommandRunner = (args: string[], cwd: string) => string;

interface ToolStatus {
  available: boolean;
  reason: string;
  version: string;
}

interface ProjectFields {
  packageManager?: string;
}

interface WorkspaceOptions {
  packageManager: string;
  workspaceFile?: string;
  workspaces?: string[];
}

const ROOT = process.cwd();
const PACKAGE_NAME = "supaschema";

if (process.argv.length > 2) {
  fail(`unknown package-smoke arguments: ${process.argv.slice(2).join(" ")}`);
}

const packageJson = readJson(join(ROOT, "package.json"));
const packageVersion = at(packageJson, "version");
const nodeBinDir = dirname(process.execPath);
const bunTool = "bun@1.3.14";
const pnpmTool = "pnpm@11.1.2";
const yarnTool = "yarn@4.17.1";
const commandTimeoutMs = 300_000;
const corepackTools = new Map([
  ["pnpm", pnpmTool],
  ["yarn", yarnTool],
]);
const tarball = resolveTarball();
const tools = {
  bun: detectTool("bun", ["--version"], createProbe("bun", { packageManager: bunTool })),
  npm: detectTool("npm", ["--version"], ROOT),
  pnpm: detectTool("pnpm", ["--version"], createProbe("pnpm", { packageManager: pnpmTool })),
  yarn: detectTool("yarn", ["--version"], createProbe("yarn", { packageManager: yarnTool })),
};

const skipped: string[] = [];
const completed: string[] = [];

runLane("npm root install plus init", tools.npm, smokeNpmRoot);
runLane("npm workspace member install plus init", tools.npm, smokeNpmWorkspaceMember);
runLane("pnpm root install plus init", tools.pnpm, smokePnpmRoot);
runLane("pnpm workspace member install plus init", tools.pnpm, smokePnpmWorkspaceMember);
runLane("Yarn workspace member install plus init", tools.yarn, smokeYarnWorkspaceMember);
runLane("Bun root install plus init", tools.bun, smokeBunRoot);
runLane("Bun workspace member init recovery", tools.bun, smokeBunWorkspaceMember);

if (skipped.length > 0) {
  fail(`missing required package manager lanes: ${skipped.join(", ")}`);
}

console.log(`PACKAGE_SMOKE_OK completed=${completed.length} skipped=${skipped.length}`);

function smokeNpmRoot() {
  const consumer = createProject("supa-smoke-npm-root-", "supaschema-npm-root");
  runNpm(["install", tarball, "--prefer-offline", "--no-audit", "--no-fund"], consumer);
  assertNoScaffold(consumer, "npm root install should wait for explicit init");
  runNpm(["exec", "--", PACKAGE_NAME, "init"], consumer);
  assertGenericScaffold(consumer);
  assertVersion((args, cwd) => runNpm(["exec", "--", PACKAGE_NAME, ...args], cwd), consumer);
}

function smokeNpmWorkspaceMember() {
  const { member, root } = createWorkspace("supa-smoke-npm-workspace-", {
    packageManager: `npm@${tools.npm.version}`,
    workspaces: ["packages/*"],
  });
  runNpm(["install", tarball, "--prefer-offline", "--no-audit", "--no-fund"], member);
  assertNoRootScaffold(root);
  assertNoScaffold(member, "npm workspace member install should wait for explicit init");
  runNpm(["exec", "--", PACKAGE_NAME, "init"], member);
  assertNoRootScaffold(root);
  assertGenericScaffold(member);
  assertVersion((args, cwd) => runNpm(["exec", "--", PACKAGE_NAME, ...args], cwd), member);
}

function smokePnpmRoot() {
  const consumer = createProject("supa-smoke-pnpm-root-", "supaschema-pnpm-root", {
    packageManager: pnpmTool,
  });
  runTool("pnpm", ["add", tarball, "--config.minimumReleaseAge=0"], consumer);
  runTool("pnpm", ["exec", PACKAGE_NAME, "init"], consumer);
  assertGenericScaffold(consumer);
  assertVersion((args, cwd) => runTool("pnpm", ["exec", PACKAGE_NAME, ...args], cwd), consumer);
}

function smokePnpmWorkspaceMember() {
  const { member, root } = createWorkspace("supa-smoke-pnpm-workspace-", {
    packageManager: pnpmTool,
    workspaceFile: "packages:\n  - packages/*\n",
  });
  runTool("pnpm", ["add", tarball, "--config.minimumReleaseAge=0"], member);
  assertNoRootScaffold(root);
  assertNoScaffold(member, "pnpm workspace member should wait for explicit init");
  runTool("pnpm", ["exec", PACKAGE_NAME, "init"], member);
  assertNoRootScaffold(root);
  assertGenericScaffold(member);
  assertPnpmBuildApproval(root);
  assertVersion((args, cwd) => runTool("pnpm", ["exec", PACKAGE_NAME, ...args], cwd), member);
}

function smokeYarnWorkspaceMember() {
  const { member, root } = createWorkspace("supa-smoke-yarn-workspace-", {
    packageManager: yarnTool,
    workspaces: ["packages/*"],
  });
  runTool("yarn", ["add", tarball], member);
  assertNoRootScaffold(root);
  assertNoScaffold(member, "Yarn workspace member should wait for explicit init");
  runTool("yarn", ["exec", PACKAGE_NAME, "init"], member);
  assertNoRootScaffold(root);
  assertGenericScaffold(member);
  assertVersion((args, cwd) => runTool("yarn", ["exec", PACKAGE_NAME, ...args], cwd), member);
}

function smokeBunRoot() {
  const consumer = createProject("supa-smoke-bun-root-", "supaschema-bun-root", {
    packageManager: bunTool,
  });
  runTool("bun", ["add", tarball], consumer);
  runBunLocalBin(["init"], consumer);
  assertGenericScaffold(consumer);
  assertVersion(runBunLocalBin, consumer);
}

function smokeBunWorkspaceMember() {
  const { member, root } = createWorkspace("supa-smoke-bun-workspace-", {
    packageManager: bunTool,
    workspaces: ["packages/*"],
  });
  runTool("bun", ["add", tarball], member);
  assertNoRootScaffold(root);
  assertNoScaffold(member, "Bun workspace member should wait for explicit init");
  runBunLocalBin(["init"], member);
  assertNoRootScaffold(root);
  assertGenericScaffold(member);
  assertVersion(runBunLocalBin, member);
}

function runLane(name: string, tool: ToolStatus, lane: () => void): void {
  if (!tool.available) {
    skipped.push(`${name} (${tool.reason})`);
    console.log(`package-smoke: skip ${name}: ${tool.reason}`);
    return;
  }

  lane();
  completed.push(name);
  console.log(`package-smoke: ok ${name}`);
}

function assertVersion(runner: CommandRunner, cwd: string): void {
  const output = runner(["--version"], cwd).trim();
  const version = lastNonEmptyLine(output);
  assert(version === packageVersion, `expected ${PACKAGE_NAME} ${packageVersion}, got ${output}`);
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

function assertGenericScaffold(dir: string): void {
  assertExists(join(dir, "supaschema.config.json"));
  assertExists(join(dir, "database", "schemas"));
  assertExists(join(dir, "database", "migrations"));
  const config = readJson(join(dir, "supaschema.config.json"));
  assert(
    JSON.stringify(at(config, "schemaPaths")) === JSON.stringify(["database/schemas"]),
    `${dir} schemaPaths did not use generic layout`
  );
  assert(
    at(config, "migrationsDir") === "database/migrations",
    `${dir} migrationsDir did not use generic layout`
  );
}

function assertNoRootScaffold(root: string): void {
  assertNoScaffold(root, "workspace root must not be scaffolded");
}

function assertNoScaffold(dir: string, message: string): void {
  assert(!existsSync(join(dir, "supaschema.config.json")), `${message}: ${dir}`);
}

function assertPnpmBuildApproval(root: string): void {
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  assert(
    workspace.includes("allowBuilds:\n  supaschema: true\n"),
    "pnpm workspace must approve the supaschema build entry during init"
  );
  assert(
    !workspace.includes("set this to true or false"),
    "pnpm workspace must not keep the unresolved supaschema build entry"
  );
}

function createWorkspace(prefix: string, options: WorkspaceOptions) {
  const root = createTemp(prefix);
  const member = join(root, "packages", "db");
  mkdirSync(member, { recursive: true });
  writeJson(join(root, "package.json"), {
    name: `${prefix}root`,
    packageManager: options.packageManager,
    private: true,
    version: "0.0.0",
    workspaces: options.workspaces,
  });
  if (options.workspaceFile) {
    writeFileSync(join(root, "pnpm-workspace.yaml"), options.workspaceFile);
  }
  writeJson(join(member, "package.json"), {
    name: "db",
    private: true,
    version: "0.0.0",
  });
  return { member, root };
}

function createProject(prefix: string, name: string, extra: ProjectFields = {}): string {
  const dir = createTemp(prefix);
  writeJson(join(dir, "package.json"), {
    name,
    private: true,
    version: "0.0.0",
    ...extra,
  });
  return dir;
}

function createProbe(prefix: string, extra: ProjectFields = {}): string {
  return createProject(`supa-smoke-${prefix}-probe-`, `supaschema-${prefix}-probe`, extra);
}

function resolveTarball(): string {
  if (process.env.SUPASCHEMA_TARBALL) {
    const configured = resolve(process.env.SUPASCHEMA_TARBALL);
    assertExists(configured);
    return configured;
  }

  const packDir = createTemp("supa-smoke-pack-");
  const output = runNpm(
    ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
    ROOT
  );
  const filename = stringAt(arrayOf(parseJson(output))[0], "filename");
  assert(filename, "npm pack did not return a filename");
  const packedPath = join(packDir, filename);
  assertExists(packedPath);
  return packedPath;
}

function detectTool(name: string, args: string[], cwd: string): ToolStatus {
  try {
    const version = runTool(name, args, cwd).trim();
    if (name === "yarn" && !version.startsWith("4.")) {
      return {
        available: false,
        reason: `expected Yarn 4.x, found ${version}`,
        version,
      };
    }
    return { available: true, reason: "", version };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : String(error),
      version: "",
    };
  }
}

function runNpm(args: string[], cwd: string): string {
  const execpath = process.env.npm_execpath;
  return execpath
    ? runRaw(process.execPath, [execpath, ...args], cwd)
    : runRaw(commandName("npm"), args, cwd);
}

function runTool(name: string, args: string[], cwd: string): string {
  const corepackTool = corepackTools.get(name);
  return corepackTool === undefined
    ? runRaw(commandName(name), args, cwd)
    : runRaw(commandName("corepack"), [corepackTool, ...args], cwd);
}

function runRaw(file: string, args: string[], cwd: string): string {
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
    const stdout = String(at(error, "stdout") ?? "");
    const stderr = String(at(error, "stderr") ?? "");
    const detail = [stdout, stderr].filter(Boolean).join("\n").trim();
    const suffix = detail.length > 0 ? `\n${detail}` : "";
    const signal = at(error, "signal");
    const reason = signal ? ` signal=${signal}` : "";
    throw new Error(`command failed in ${cwd}: ${file} ${args.join(" ")}${reason}${suffix}`, {
      cause: error,
    });
  }
}

function runBunLocalBin(args: string[], cwd: string): string {
  const executable = process.platform === "win32" ? `${PACKAGE_NAME}.cmd` : PACKAGE_NAME;
  return runRaw(join(cwd, "node_modules", ".bin", executable), args, cwd);
}

function commandName(name: string): string {
  const executable = process.platform === "win32" ? `${name}.cmd` : name;
  const nodeShim = join(nodeBinDir, executable);
  return name === "npm" && existsSync(nodeShim) ? nodeShim : executable;
}

function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  env.INIT_CWD = undefined;
  return env;
}

function readJson(path: string): unknown {
  return parseJson(readFileSync(path, "utf8"));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createTemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function assertExists(path: string): void {
  assert(existsSync(path), `expected ${path} to exist`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}

function fail(message: string): never {
  console.error(`PACKAGE_SMOKE_FAILED ${message}`);
  process.exit(1);
}
