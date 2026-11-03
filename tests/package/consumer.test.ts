import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { beforeAll, describe, expect, it, test } from "vitest";
import {
  expectedHeaderFragments,
  expectedMigrationFragments,
  expectedTypesFragments,
  expectedZodFragments,
} from "../examples/expectations.js";
import {
  activeAgentFiles,
  excludedMaintainerFiles,
  expectedInstalledConfig,
  expectedSupaschemaScripts,
  managedSchemas,
  rawAgentBundleFiles,
} from "./install-expectations.js";

const run = promisify(execFile);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const bunCommand = process.platform === "win32" ? "bun.exe" : "bun";
const pnpm11Available = (() => {
  try {
    const version = execFileSync(pnpmCommand, ["--version"], { encoding: "utf8" }).trim();
    return version.startsWith("11.");
  } catch {
    return false;
  }
})();
const bunAvailable = (() => {
  try {
    execFileSync(bunCommand, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

interface Spawn {
  args: string[];
  file: string;
}
interface CaptureResult {
  code: number;
  stderr: string;
  stdout: string;
}

function npmExec(args: string[]): Spawn {
  const execpath = process.env.npm_execpath;
  return execpath
    ? { args: [execpath, ...args], file: process.execPath }
    : { args, file: process.platform === "win32" ? "npm.cmd" : "npm" };
}

function installedPackageBinPath(project: string): string {
  const manifest: unknown = JSON.parse(
    readFileSync(join(project, "node_modules", "supaschema", "package.json"), "utf8")
  );
  if (!manifest || typeof manifest !== "object") {
    throw new Error("installed supaschema package.json must be an object");
  }
  const bin = Reflect.get(manifest, "bin");
  if (!bin || typeof bin !== "object") {
    throw new Error("installed supaschema package.json must define bin");
  }
  const supaschema = Reflect.get(bin, "supaschema");
  if (typeof supaschema !== "string") {
    throw new Error("installed supaschema package.json must define bin.supaschema");
  }
  return join(project, "node_modules", "supaschema", supaschema);
}

async function capture(file: string, args: string[], cwd: string): Promise<CaptureResult> {
  try {
    const { stdout, stderr } = await run(file, args, { cwd, maxBuffer: 64 * 1024 * 1024 });
    return { code: 0, stderr, stdout };
  } catch (error) {
    const failure = error;
    return {
      code: typeof failure.code === "number" ? failure.code : 1,
      stderr: failure.stderr ?? "",
      stdout: failure.stdout ?? "",
    };
  }
}

function lastNonEmptyLine(value: string): string | undefined {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .at(-1);
}

async function copySqlTree(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(targetDir, { recursive: true });
  for (const entry of await readdir(sourceDir)) {
    if (entry.endsWith(".sql")) {
      await cp(join(sourceDir, entry), join(targetDir, entry));
    }
  }
}

const repoVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

const fixtureFrom = "tests/fixtures/sample-project/supabase/schemas";
const fixtureTo = "tests/fixtures/sample-project/supabase/schemas-next";

let consumer = "";
let consumerScaffoldBeforeInit = true;
let binPath = "";

let consumer2 = "";
let binPath2 = "";
let tarballPath = "";

beforeAll(async () => {
  const packDir = await mkdtemp(join(tmpdir(), "supa-pack-"));
  const pack = npmExec(["pack", "--json", "--ignore-scripts", "--pack-destination", packDir]);
  const { stdout } = await run(pack.file, pack.args, { maxBuffer: 32 * 1024 * 1024 });
  const [packed] = JSON.parse(stdout);
  const tarball = join(packDir, packed.filename);
  tarballPath = tarball;

  consumer = await mkdtemp(join(tmpdir(), "supa-consumer-"));
  await writeFile(
    join(consumer, "package.json"),
    `${JSON.stringify({ name: "supaschema-consumer-fixture", private: true, version: "0.0.0" })}\n`
  );

  await mkdir(join(consumer, "supabase"), { recursive: true });
  await writeFile(join(consumer, "supabase", "config.toml"), "[db]\nport = 54322\n");

  const install = npmExec(["install", tarball, "--prefer-offline", "--no-audit", "--no-fund"]);
  await run(install.file, install.args, { cwd: consumer, maxBuffer: 64 * 1024 * 1024 });

  binPath = installedPackageBinPath(consumer);
  consumerScaffoldBeforeInit = existsSync(join(consumer, "supaschema.config.json"));
  await run(process.execPath, [binPath, "init"], {
    cwd: consumer,
    maxBuffer: 64 * 1024 * 1024,
  });

  consumer2 = await mkdtemp(join(tmpdir(), "supa-consumer-init-"));
  await writeFile(
    join(consumer2, "package.json"),
    `${JSON.stringify({ name: "supaschema-init-fixture", private: true, version: "0.0.0" })}\n`
  );
  const installOnly = npmExec(["install", tarball, "--prefer-offline", "--no-audit", "--no-fund"]);
  await run(installOnly.file, installOnly.args, {
    cwd: consumer2,
    maxBuffer: 64 * 1024 * 1024,
  });
  binPath2 = installedPackageBinPath(consumer2);
}, 300_000);

describe("consumer lifecycle: install then use the published package", () => {
  it("npm install ships the package and explicit init scaffolds the project", () => {
    expect(consumerScaffoldBeforeInit).toBe(false);
    expect(existsSync(join(consumer, "supaschema.config.json"))).toBe(true);
    expect(existsSync(join(consumer, "supabase", "schemas"))).toBe(true);
    expect(existsSync(join(consumer, "supabase", "migrations"))).toBe(true);

    expect(binPath).toBe(join(consumer, "node_modules", "supaschema", "dist", "cli.js"));
    expect(existsSync(binPath)).toBe(true);

    const config = JSON.parse(readFileSync(join(consumer, "supaschema.config.json"), "utf8"));
    expect(config.schemaPaths).toEqual(["supabase/schemas"]);
    expect(config.migrationsDir).toBe("supabase/migrations");
    const manifest = JSON.parse(readFileSync(join(consumer, "package.json"), "utf8"));
    expect(manifest.scripts).toMatchObject(expectedSupaschemaScripts);
  });

  it("runs --version from the installed binary", async () => {
    const result = await capture(process.execPath, [binPath, "--version"], consumer);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe(repoVersion);
  });

  it("turns a schema edit into an accurate migration and generated types via the installed CLI", async () => {
    await copySqlTree(fixtureFrom, join(consumer, "baseline", "schemas"));
    await copySqlTree(fixtureTo, join(consumer, "supabase", "schemas"));

    const configPath = join(consumer, "supaschema.config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    config.sources = {
      from: "dir:baseline/schemas",
    };
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

    const diff = await capture(process.execPath, [binPath, "diff"], consumer);
    expect(diff.code, diff.stderr).toBe(0);

    const migrations = (await readdir(join(consumer, "supabase", "migrations"))).filter((entry) =>
      entry.endsWith(".sql")
    );
    expect(migrations).toHaveLength(1);
    const migrationSql = await readFile(
      join(consumer, "supabase", "migrations", migrations[0] ?? ""),
      "utf8"
    );
    for (const fragment of expectedMigrationFragments) {
      expect(migrationSql, fragment).toContain(fragment);
    }

    expect(migrationSql).toContain("-- supaschema: lineage");

    const check = await capture(process.execPath, [binPath, "check"], consumer);
    expect(check.code, check.stderr).toBe(0);

    const types = await capture(process.execPath, [binPath, "types"], consumer);
    expect(types.code, types.stderr).toBe(0);

    const typesFile = await readFile(join(consumer, "database.types.ts"), "utf8");
    for (const fragment of [...expectedHeaderFragments, ...expectedTypesFragments]) {
      expect(typesFile, fragment).toContain(fragment);
    }
    const zodFile = await readFile(join(consumer, "database.zod.ts"), "utf8");
    for (const fragment of [...expectedHeaderFragments, ...expectedZodFragments]) {
      expect(zodFile, fragment).toContain(fragment);
    }
  }, 300_000);
});

describe("consumer lifecycle: workspace member install from member directory", () => {
  it("npm install from the owning workspace member plus init scaffolds that member, not the root", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "supa-npm-workspace-"));
    const member = join(workspace, "packages", "db");
    await mkdir(member, { recursive: true });
    await writeFile(
      join(workspace, "package.json"),
      `${JSON.stringify({
        name: "supaschema-npm-workspace-root",
        private: true,
        version: "0.0.0",
        workspaces: ["packages/*"],
      })}\n`
    );
    await writeFile(
      join(member, "package.json"),
      `${JSON.stringify({ name: "db", private: true, version: "0.0.0" })}\n`
    );

    const install = npmExec([
      "install",
      tarballPath,
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
    ]);
    await run(install.file, install.args, { cwd: member, maxBuffer: 64 * 1024 * 1024 });

    expect(existsSync(join(workspace, "supaschema.config.json"))).toBe(false);
    expect(existsSync(join(member, "supaschema.config.json"))).toBe(false);

    const init = await capture(
      npmExec(["exec", "--", "supaschema", "init"]).file,
      npmExec(["exec", "--", "supaschema", "init"]).args,
      member
    );
    expect(init.code, init.stderr).toBe(0);

    expect(existsSync(join(workspace, "supaschema.config.json"))).toBe(false);
    expect(existsSync(join(member, "supaschema.config.json"))).toBe(true);
    expect(existsSync(join(member, "database", "schemas"))).toBe(true);
    expect(existsSync(join(member, "database", "migrations"))).toBe(true);
  }, 300_000);
});

describe.skipIf(!pnpm11Available)("consumer lifecycle: pnpm install and recovery lanes", () => {
  test("pnpm add plus explicit init scaffolds the project", async () => {
    const pnpmConsumer = await mkdtemp(join(tmpdir(), "supa-pnpm-consumer-"));
    await writeFile(
      join(pnpmConsumer, "package.json"),
      `${JSON.stringify({
        name: "supaschema-pnpm-consumer-fixture",
        packageManager: "pnpm@11.1.2",
        private: true,
        version: "0.0.0",
      })}\n`
    );

    await run(pnpmCommand, ["add", tarballPath, "--config.minimumReleaseAge=0"], {
      cwd: pnpmConsumer,
      maxBuffer: 64 * 1024 * 1024,
    });

    expect(existsSync(join(pnpmConsumer, "supaschema.config.json"))).toBe(false);
    expect(existsSync(installedPackageBinPath(pnpmConsumer))).toBe(true);

    const init = await capture(pnpmCommand, ["exec", "supaschema", "init"], pnpmConsumer);
    expect(init.code, init.stderr).toBe(0);
    expect(existsSync(join(pnpmConsumer, "supaschema.config.json"))).toBe(true);
    expect(existsSync(join(pnpmConsumer, "database", "schemas"))).toBe(true);
    expect(existsSync(join(pnpmConsumer, "database", "migrations"))).toBe(true);

    const version = await capture(pnpmCommand, ["exec", "supaschema", "--version"], pnpmConsumer);
    expect(version.code, version.stderr).toBe(0);
    expect(lastNonEmptyLine(version.stdout)).toBe(repoVersion);
  }, 300_000);

  test("pnpm add without setup can recover through pnpm exec supaschema init", async () => {
    const pnpmConsumer = await mkdtemp(join(tmpdir(), "supa-pnpm-init-"));
    await writeFile(
      join(pnpmConsumer, "package.json"),
      `${JSON.stringify({
        name: "supaschema-pnpm-init-fixture",
        packageManager: "pnpm@11.1.2",
        private: true,
        version: "0.0.0",
      })}\n`
    );

    await run(pnpmCommand, ["add", tarballPath, "--config.minimumReleaseAge=0"], {
      cwd: pnpmConsumer,
      maxBuffer: 64 * 1024 * 1024,
    });

    expect(existsSync(join(pnpmConsumer, "supaschema.config.json"))).toBe(false);
    expect(existsSync(installedPackageBinPath(pnpmConsumer))).toBe(true);

    const init = await capture(pnpmCommand, ["exec", "supaschema", "init"], pnpmConsumer);
    expect(init.code, init.stderr).toBe(0);

    const config = JSON.parse(readFileSync(join(pnpmConsumer, "supaschema.config.json"), "utf8"));
    expect(config).toEqual(expectedInstalledConfig("database/schemas", "database/migrations"));
    const manifest = JSON.parse(readFileSync(join(pnpmConsumer, "package.json"), "utf8"));
    expect(manifest.scripts).toMatchObject(expectedSupaschemaScripts);
    for (const file of activeAgentFiles) {
      expect(existsSync(join(pnpmConsumer, file)), file).toBe(true);
    }
    for (const file of rawAgentBundleFiles) {
      expect(existsSync(join(pnpmConsumer, file)), file).toBe(true);
    }
    expect(existsSync(join(pnpmConsumer, ".supaschema"))).toBe(false);
  }, 300_000);

  test("pnpm workspace member install uses explicit init from the member", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "supa-pnpm-workspace-"));
    const member = join(workspace, "packages", "db");
    await mkdir(member, { recursive: true });
    await writeFile(
      join(workspace, "package.json"),
      `${JSON.stringify({
        name: "supaschema-pnpm-workspace-root",
        packageManager: "pnpm@11.1.2",
        private: true,
        version: "0.0.0",
      })}\n`
    );
    await writeFile(join(workspace, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    await writeFile(
      join(member, "package.json"),
      `${JSON.stringify({ name: "db", private: true, version: "0.0.0" })}\n`
    );

    await run(pnpmCommand, ["add", tarballPath, "--config.minimumReleaseAge=0"], {
      cwd: member,
      maxBuffer: 64 * 1024 * 1024,
    });

    expect(existsSync(join(workspace, "supaschema.config.json"))).toBe(false);
    expect(existsSync(join(member, "supaschema.config.json"))).toBe(false);

    const init = await capture(pnpmCommand, ["exec", "supaschema", "init"], member);
    expect(init.code, init.stderr).toBe(0);

    expect(existsSync(join(workspace, "supaschema.config.json"))).toBe(false);
    expect(existsSync(join(member, "supaschema.config.json"))).toBe(true);
    expect(existsSync(join(member, "database", "schemas"))).toBe(true);
    expect(existsSync(join(member, "database", "migrations"))).toBe(true);

    const version = await capture(pnpmCommand, ["exec", "supaschema", "--version"], member);
    expect(version.code, version.stderr).toBe(0);
    expect(lastNonEmptyLine(version.stdout)).toBe(repoVersion);
  }, 300_000);
});

describe.skipIf(!bunAvailable)("consumer lifecycle: Bun workspace member setup", () => {
  test("bun workspace member install uses untrusted add then explicit init from the member", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "supa-bun-workspace-"));
    const member = join(workspace, "packages", "db");
    await mkdir(member, { recursive: true });
    await writeFile(
      join(workspace, "package.json"),
      `${JSON.stringify({
        name: "supaschema-bun-workspace-root",
        private: true,
        version: "0.0.0",
        workspaces: ["packages/*"],
      })}\n`
    );
    await writeFile(
      join(member, "package.json"),
      `${JSON.stringify({ name: "db", private: true, version: "0.0.0" })}\n`
    );

    await run(bunCommand, ["add", tarballPath], {
      cwd: member,
      maxBuffer: 64 * 1024 * 1024,
    });

    expect(existsSync(join(workspace, "supaschema.config.json"))).toBe(false);
    expect(existsSync(join(member, "supaschema.config.json"))).toBe(false);

    const bunBin = join(
      member,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "supaschema.cmd" : "supaschema"
    );
    const init = await capture(bunBin, ["init"], member);
    expect(init.code, init.stderr).toBe(0);

    expect(existsSync(join(workspace, "supaschema.config.json"))).toBe(false);
    expect(existsSync(join(member, "supaschema.config.json"))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(member, "package.json"), "utf8"));
    expect(manifest.scripts).toMatchObject(expectedSupaschemaScripts);
    expect(existsSync(join(member, "database", "schemas"))).toBe(true);
    expect(existsSync(join(member, "database", "migrations"))).toBe(true);
  }, 300_000);
});

describe("consumer lifecycle: package install then supaschema init reaches config setup", () => {
  it("package install does not scaffold but still ships the CLI and shared scaffolder", () => {
    expect(existsSync(join(consumer2, "supaschema.config.json"))).toBe(false);
    expect(existsSync(join(consumer2, ".supaschema", "install.json"))).toBe(false);
    expect(existsSync(join(consumer2, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(consumer2, "database", "schemas"))).toBe(false);

    expect(existsSync(binPath2)).toBe(true);
    expect(existsSync(join(consumer2, "node_modules", "supaschema", "dist", "cli.js"))).toBe(true);
    expect(existsSync(join(consumer2, "node_modules", "supaschema", "bin", "scaffold.mjs"))).toBe(
      true
    );
    expect(
      existsSync(
        join(
          consumer2,
          "node_modules",
          "supaschema",
          "agent-bundle",
          "docs",
          "coding-agents",
          "index.mdx"
        )
      )
    ).toBe(true);
    expect(
      existsSync(join(consumer2, "node_modules", "supaschema", "agent-bundle", "docs", "index.md"))
    ).toBe(true);
    expect(existsSync(join(consumer2, "agent-bundle", "docs"))).toBe(false);
    expect(existsSync(join(consumer2, ".agents", "docs"))).toBe(false);
  });

  it("supaschema init scaffolds config and active agent enforcement by default", async () => {
    const first = await capture(process.execPath, [binPath2, "init"], consumer2);
    expect(first.code, first.stderr).toBe(0);

    const config = JSON.parse(readFileSync(join(consumer2, "supaschema.config.json"), "utf8"));
    expect(config).toEqual(expectedInstalledConfig("database/schemas", "database/migrations"));
    const manifest = JSON.parse(readFileSync(join(consumer2, "package.json"), "utf8"));
    expect(manifest.scripts).toMatchObject(expectedSupaschemaScripts);
    expect(existsSync(join(consumer2, "database", "schemas"))).toBe(true);
    expect(existsSync(join(consumer2, "database", "migrations"))).toBe(true);
    for (const file of activeAgentFiles) {
      expect(existsSync(join(consumer2, file)), file).toBe(true);
    }
    for (const file of rawAgentBundleFiles) {
      expect(existsSync(join(consumer2, file)), file).toBe(true);
    }
    for (const file of excludedMaintainerFiles) {
      expect(existsSync(join(consumer2, file)), file).toBe(false);
    }
    expect(existsSync(join(consumer2, "agent-bundle", "docs"))).toBe(false);
    expect(existsSync(join(consumer2, ".agents", "docs"))).toBe(false);
    expect(existsSync(join(consumer2, ".supaschema"))).toBe(false);
    expect(existsSync(join(consumer2, "AGENTS.md"))).toBe(false);
    expect(first.stdout).toContain("agent bundle");

    const second = await capture(process.execPath, [binPath2, "init"], consumer2);
    expect(second.code, second.stderr).toBe(0);
    expect(existsSync(join(consumer2, "AGENTS.md"))).toBe(false);
  });

  it("supaschema init completes a Supabase inventory project without pending path setup", async () => {
    const project = await mkdtemp(join(tmpdir(), "supa-inventory-consumer-"));
    await writeFile(
      join(project, "package.json"),
      `${JSON.stringify({
        name: "supaschema-inventory-consumer-fixture",
        private: true,
        version: "0.0.0",
      })}\n`
    );
    await mkdir(join(project, "supabase", "schemas", "_bootstrap"), { recursive: true });
    await mkdir(join(project, "supabase", "migrations"), { recursive: true });
    await writeFile(join(project, "supabase", "config.toml"), "[db]\nport = 54322\n");
    await writeFile(
      join(project, "supabase", "AGENTS.md"),
      "`supabase/schemas/**` is the existing schema-source and contract-inventory surface while it remains in the repo; it is not the routine migration generator input.\n"
    );
    await writeFile(
      join(project, "supabase", "schemas", "_bootstrap", "00_roles.sql"),
      "create schema if not exists app;\n"
    );

    const install = npmExec([
      "install",
      tarballPath,
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
    ]);
    await run(install.file, install.args, { cwd: project, maxBuffer: 64 * 1024 * 1024 });

    const bin = installedPackageBinPath(project);
    const init = await capture(process.execPath, [bin, "init"], project);
    expect(init.code, init.stderr).toBe(0);

    expect(existsSync(join(project, ".supaschema", "install.json"))).toBe(false);
    const config = JSON.parse(readFileSync(join(project, "supaschema.config.json"), "utf8"));
    expect(config).toEqual(
      expectedInstalledConfig("supabase/schemas", "supabase/migrations", {
        workflow: { migration_sync: "manual", schema_diff: "manual" },
      })
    );

    const validate = await capture(
      process.execPath,
      [bin, "config", "validate", "--json"],
      project
    );
    expect(validate.code, validate.stderr).toBe(0);
    expect(JSON.parse(validate.stdout)).toEqual({ diagnostics: [], ok: true });
  }, 300_000);

  it("supaschema init repairs existing Supabase managed-schema excludes", async () => {
    const project = await mkdtemp(join(tmpdir(), "supa-managed-repair-"));
    await writeFile(
      join(project, "package.json"),
      `${JSON.stringify({
        name: "supaschema-managed-repair-fixture",
        private: true,
        version: "0.0.0",
      })}\n`
    );
    await mkdir(join(project, "supabase", "schemas"), { recursive: true });
    await mkdir(join(project, "supabase", "migrations"), { recursive: true });
    await writeFile(join(project, "supabase", "config.toml"), "[db]\nport = 54322\n");

    const existing = expectedInstalledConfig("supabase/schemas", "supabase/migrations");
    existing.schemas = { exclude: [], include: [] };
    await writeFile(
      join(project, "supaschema.config.json"),
      `${JSON.stringify(existing, null, 2)}\n`
    );

    const install = npmExec([
      "install",
      tarballPath,
      "--prefer-offline",
      "--no-audit",
      "--no-fund",
    ]);
    await run(install.file, install.args, { cwd: project, maxBuffer: 64 * 1024 * 1024 });

    const bin = installedPackageBinPath(project);
    const init = await capture(process.execPath, [bin, "init", "--repair"], project);
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toContain("config repair");

    const config = JSON.parse(readFileSync(join(project, "supaschema.config.json"), "utf8"));
    expect(config.schemas.exclude).toEqual(managedSchemas);
  }, 300_000);

  it("supaschema init rejects the removed --agent-bundle auto-install path", async () => {
    const help = await capture(process.execPath, [binPath2, "init", "--help"], consumer2);
    expect(help.code, help.stderr).toBe(0);
    expect(help.stdout).not.toContain("--agent-bundle");

    const result = await capture(process.execPath, [binPath2, "init", "--agent-bundle"], consumer2);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unknown option");

    for (const file of activeAgentFiles) {
      expect(existsSync(join(consumer2, file)), file).toBe(true);
    }
    for (const file of rawAgentBundleFiles) {
      expect(existsSync(join(consumer2, file)), file).toBe(true);
    }
    expect(existsSync(join(consumer2, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(consumer2, "CLAUDE.md"))).toBe(false);
  });

  it("generates an accurate migration and types after init, via the installed CLI", {
    timeout: 30_000,
  }, async () => {
    await copySqlTree(fixtureFrom, join(consumer2, "baseline", "schemas"));
    await copySqlTree(fixtureTo, join(consumer2, "database", "schemas"));

    const diff = await capture(
      process.execPath,
      [binPath2, "diff", "--from", "dir:baseline/schemas", "--name", "add_account_status"],
      consumer2
    );
    expect(diff.code, diff.stderr).toBe(0);

    const migrations = (await readdir(join(consumer2, "database", "migrations"))).filter((entry) =>
      entry.endsWith(".sql")
    );
    expect(migrations).toHaveLength(1);
    const migrationSql = await readFile(
      join(consumer2, "database", "migrations", migrations[0] ?? ""),
      "utf8"
    );
    for (const fragment of expectedMigrationFragments) {
      expect(migrationSql, fragment).toContain(fragment);
    }
    expect(migrationSql).toContain("-- supaschema: lineage");

    const check = await capture(process.execPath, [binPath2, "check"], consumer2);
    expect(check.code, check.stderr).toBe(0);

    const types = await capture(process.execPath, [binPath2, "types"], consumer2);
    expect(types.code, types.stderr).toBe(0);
    const typesFile = await readFile(join(consumer2, "database.types.ts"), "utf8");
    for (const fragment of [...expectedHeaderFragments, ...expectedTypesFragments]) {
      expect(typesFile, fragment).toContain(fragment);
    }
    const zodFile = await readFile(join(consumer2, "database.zod.ts"), "utf8");
    for (const fragment of [...expectedHeaderFragments, ...expectedZodFragments]) {
      expect(zodFile, fragment).toContain(fragment);
    }
  });
});
