import { execFile } from "node:child_process";
import {
  access,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { checkMigrationSql } from "../check/migration.js";
import { resolveConfig } from "../config/schema.js";
import { diagnostic, hasErrors } from "../diagnostics/diagnostics.js";
import { readMigrationContext } from "../migrations/context.js";
import { migrationFiles, nextMigrationFile } from "../migrations/files.js";
import { migrationFileVersion } from "../migrations/status.js";
import { buildSchemaDiffPlan } from "../pipeline/diff.js";
import { renderMigrationSplit } from "../render/migration.js";
import { defaultTreeSource } from "../source/resolve.js";
import { generateTypeContracts } from "../typegen/contracts.js";
import type {
  Diagnostic,
  MigrationContext,
  MigrationCorpusOperation,
  SupaschemaConfig,
} from "../types.js";
import { bootstrapInventorySql, verifyMigrationChain } from "../verify/migration.js";

const execFileAsync = promisify(execFile);

export interface RebaselineOptions {
  cliVersion?: string;
  config?: Partial<SupaschemaConfig>;
  configPath?: string;
  cwd?: string;
  databaseUrl?: string;
  directory: string;
  ensureEnvironment?: boolean;
  ensureRoles?: boolean;
  retainFiles?: readonly string[];
  write?: boolean;
}

export interface RebaselineResult {
  alreadyConverged: boolean;
  baselinePath?: string;
  diagnostics: Diagnostic[];
  discardedOperations: MigrationCorpusOperation[];
  generatedMigrationPaths: string[];
  operationCount: number;
  removedFiles: string[];
  retainedFiles: string[];
  staged: string[];
  targetRebuildRequired: boolean;
  written: boolean;
  writtenContractPaths: string[];
}

interface RebaselineState {
  alreadyConverged: boolean;
  baselinePath?: string;
  diagnostics: Diagnostic[];
  discardedOperations: MigrationCorpusOperation[];
  generatedMigrationPaths: string[];
  operationCount: number;
  removedFiles: string[];
  retainedFiles: string[];
  staged: string[];
  targetRebuildRequired: boolean;
  written: boolean;
  writtenContractPaths: string[];
}

export async function rebaselineMigrations(options: RebaselineOptions): Promise<RebaselineResult> {
  const cwd = options.cwd ?? process.cwd();
  const config = resolveConfig(options.config);
  const directory = resolve(cwd, options.directory);
  const to = defaultTreeSource(config);
  const context = await readMigrationContext(directory, { cwd });
  const requestedRetainedNames = new Set((options.retainFiles ?? []).map(migrationName));
  const retainedPaths = new Set(
    context.files.filter((file) => requestedRetainedNames.has(migrationName(file)))
  );
  const retainedFiles = context.files.filter((file) => retainedPaths.has(file));
  const removedFiles = [...context.files];
  const state: RebaselineState = {
    alreadyConverged: false,
    diagnostics: [],
    discardedOperations: context.corpus.operations.filter(
      (operation) => !retainedPaths.has(operation.file)
    ),
    generatedMigrationPaths: [],
    operationCount: 0,
    removedFiles,
    retainedFiles,
    staged: [],
    targetRebuildRequired: false,
    written: false,
    writtenContractPaths: [],
  };
  const corpusNames = new Set(context.files.map(migrationName));
  const unknownRetainedFiles = (options.retainFiles ?? []).filter(
    (file) => !corpusNames.has(migrationName(file))
  );
  if (unknownRetainedFiles.length > 0) {
    state.diagnostics.push(
      diagnostic(
        "SUPA_REBASELINE_RETAIN_UNKNOWN",
        "error",
        `retained migration file(s) are not in the configured corpus: ${unknownRetainedFiles.join(", ")}`,
        {
          hint: "Pass exact paths from the dry-run inventory. Retain only reviewed operational migrations that the declarative tree cannot own.",
        }
      )
    );
    return state;
  }
  const plan = await buildSchemaDiffPlan({
    checkMigrationBaseline: false,
    config,
    cwd,
    from: "empty:",
    migrationsDir: directory,
    to,
  });
  state.diagnostics.push(...plan.diagnostics);
  state.operationCount = plan.operations.length;
  if (hasErrors(state.diagnostics)) {
    return state;
  }
  const bootstrapSql = await bootstrapInventorySql(config, cwd, true);
  const existingBaseline = await convergedBaselinePath(
    context,
    plan.toFingerprint,
    retainedPaths,
    bootstrapSql
  );
  if (existingBaseline !== undefined) {
    state.alreadyConverged = true;
    state.baselinePath = existingBaseline;
    state.generatedMigrationPaths = context.files.filter((file) => !retainedPaths.has(file));
    state.discardedOperations = [];
    state.removedFiles = [];
    return state;
  }
  if (plan.operations.length === 0) {
    if (options.write === true) {
      state.diagnostics.push(
        diagnostic("SUPA_DIFF_EMPTY_PLAN", "error", "rebaseline planned no schema operations", {
          hint: "The configured declarative tree is empty. Add schema objects or review the configured schemaPaths before writing a baseline.",
        })
      );
    }
    return state;
  }

  const baselinePath = await nextMigrationFile(directory, "baseline");
  const rendered = renderMigrationSplit(plan, {
    config,
    version: options.cliVersion ?? "library",
  });
  state.baselinePath = baselinePath;
  state.generatedMigrationPaths = [baselinePath];
  const baselineSql =
    bootstrapSql.trim().length === 0 ? rendered.sql : `${bootstrapSql}\n${rendered.sql}`;
  const renderedUnits = [{ path: baselinePath, sql: baselineSql }];
  if (rendered.concurrentSql !== undefined) {
    const concurrentPath = `${baselinePath.slice(0, -".sql".length)}.concurrent.sql`;
    renderedUnits.push({ path: concurrentPath, sql: rendered.concurrentSql });
    state.generatedMigrationPaths.push(concurrentPath);
  }
  for (const unit of renderedUnits) {
    state.diagnostics.push(...(await checkMigrationSql(unit.sql, { config, cwd })));
  }
  if (hasErrors(state.diagnostics) || options.write !== true) {
    return state;
  }
  if (options.databaseUrl === undefined) {
    state.diagnostics.push(
      diagnostic(
        "SUPA_REBASELINE_VERIFY_REQUIRED",
        "error",
        "rebaseline --write requires a disposable verification database",
        {
          hint: "Pass --database-url or resolve the local Supabase verification database before replacing migration history.",
        }
      )
    );
    return state;
  }

  return writeRebaselineArtifacts({
    config,
    cwd,
    databaseUrl: options.databaseUrl,
    directory,
    options,
    removedFiles,
    renderedUnits,
    state,
    to,
  });
}

async function writeRebaselineArtifacts(input: {
  config: SupaschemaConfig;
  cwd: string;
  databaseUrl: string;
  directory: string;
  options: RebaselineOptions;
  removedFiles: string[];
  renderedUnits: { path: string; sql: string }[];
  state: RebaselineState;
  to: string;
}): Promise<RebaselineResult> {
  const { config, cwd, databaseUrl, directory, options, removedFiles, renderedUnits, state, to } =
    input;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "supaschema-rebaseline-"));
  try {
    const temporaryUnits: string[] = [];
    for (const unit of renderedUnits) {
      const temporaryPath = join(temporaryRoot, basename(unit.path));
      await writeFile(temporaryPath, unit.sql, { flag: "wx" });
      temporaryUnits.push(temporaryPath);
    }
    const retainedSourceFiles = [...state.retainedFiles];
    state.retainedFiles = [];
    for (const source of retainedSourceFiles) {
      const retainedName = migrationName(source);
      const temporaryPath = await nextMigrationFile(
        temporaryRoot,
        retainedName.endsWith(".sql") ? retainedName.slice(0, -".sql".length) : retainedName
      );
      await writeFile(temporaryPath, await readFile(source), { flag: "wx" });
      temporaryUnits.push(temporaryPath);
      state.retainedFiles.push(join(directory, basename(temporaryPath)));
    }
    state.diagnostics.push(
      ...(await verifyMigrationChain({
        config,
        cwd,
        databaseUrl,
        ...(options.ensureEnvironment === undefined
          ? {}
          : { ensureEnvironment: options.ensureEnvironment }),
        ...(options.ensureRoles === undefined ? {} : { ensureRoles: options.ensureRoles }),
        from: "empty:",
        migrationPaths: temporaryUnits,
        to,
      }))
    );
    if (hasErrors(state.diagnostics)) {
      return state;
    }

    const replacement = await replaceRebaselineArtifacts({
      config,
      cwd,
      directory,
      generatedMigrationPaths: [...state.generatedMigrationPaths, ...state.retainedFiles],
      removedFiles,
      temporaryRoot,
      temporaryUnits,
      to,
    });
    state.diagnostics.push(...replacement.diagnostics);
    state.writtenContractPaths = replacement.writtenContractPaths;
    if (hasErrors(replacement.diagnostics)) {
      return state;
    }
    state.written = true;
    state.targetRebuildRequired = removedFiles.length > 0;
    try {
      state.staged = await stageRebaselineClosure({
        config,
        ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
        cwd,
        migrationPaths: [...removedFiles, ...state.generatedMigrationPaths, ...state.retainedFiles],
      });
    } catch (error) {
      state.diagnostics.push(
        diagnostic(
          "SUPA_REBASELINE_STAGE_FAILED",
          "error",
          error instanceof Error ? error.message : String(error),
          {
            hint: "The new baseline is written. Resolve the Git path or staging failure, then stage the migration deletions and generated closure explicitly.",
          }
        )
      );
    }
    if (state.targetRebuildRequired) {
      state.diagnostics.push(
        diagnostic(
          "SUPA_REBASELINE_TARGET_REBUILD_REQUIRED",
          "warning",
          "migration history was replaced; applied target history is unchanged",
          {
            hint: "Rebuild or reconcile each affected target through a separately authorized target operation before running sync. Rebaseline does not apply to or repair target databases.",
          }
        )
      );
    }
    return state;
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

function migrationName(file: string): string {
  const name = basename(file);
  const version = migrationFileVersion(name);
  const unversioned = version === undefined ? name : name.slice(version.length);
  return unversioned.startsWith("_") ? unversioned.slice(1) : unversioned;
}

async function convergedBaselinePath(
  context: MigrationContext,
  targetFingerprint: string,
  retainedPaths: ReadonlySet<string>,
  bootstrapSql: string
): Promise<string | undefined> {
  const baselineFiles = context.files.filter(
    (file) => !(retainedPaths.has(file) || file.endsWith(".concurrent.sql"))
  );
  if (
    baselineFiles.length !== 1 ||
    context.unprovenBaselineFiles.some((file) => !retainedPaths.has(file)) ||
    context.latestGeneratedBaseline?.fingerprint !== targetFingerprint
  ) {
    return;
  }
  const baseline = baselineFiles[0];
  if (baseline === undefined) {
    return;
  }
  const orderedAfterBaseline = [...retainedPaths].every(
    (file) => basename(file).localeCompare(basename(baseline)) > 0
  );
  if (!orderedAfterBaseline) {
    return;
  }
  if (bootstrapSql.trim().length > 0) {
    const existingSql = await readFile(baseline, "utf8").catch(() => "");
    if (!existingSql.startsWith(bootstrapSql.trim())) {
      return;
    }
  }
  return baseline;
}

async function replaceRebaselineArtifacts(options: {
  config: SupaschemaConfig;
  cwd: string;
  directory: string;
  generatedMigrationPaths: string[];
  removedFiles: string[];
  temporaryRoot: string;
  temporaryUnits: string[];
  to: string;
}): Promise<{ diagnostics: Diagnostic[]; writtenContractPaths: string[] }> {
  const diagnostics: Diagnostic[] = [];
  const writtenContractPaths: string[] = [];
  const contractPaths = [
    resolve(options.cwd, options.config.typesFile),
    resolve(options.cwd, options.config.zodFile),
  ];
  const backupRoot = join(options.temporaryRoot, "backup");
  const backups = await backupFiles([...options.removedFiles, ...contractPaths], backupRoot);
  try {
    for (const file of options.removedFiles) {
      await rm(file);
    }
    for (let index = 0; index < options.generatedMigrationPaths.length; index += 1) {
      const target = options.generatedMigrationPaths[index];
      const source = options.temporaryUnits[index];
      if (target === undefined || source === undefined) {
        throw new Error("rebaseline generated migration units are inconsistent");
      }
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, await readFile(source), { flag: "wx" });
    }
    const contractConfig = {
      ...options.config,
      typesFile: contractPaths[0] ?? options.config.typesFile,
      zodFile: contractPaths[1] ?? options.config.zodFile,
    };
    const source = options.to.startsWith("dir:")
      ? `dir:${resolve(options.cwd, options.to.slice("dir:".length))}`
      : options.to;
    const contracts = await generateTypeContracts({
      config: contractConfig,
      honorWorkflowPolicy: true,
      source,
    });
    diagnostics.push(...contracts.diagnostics);
    writtenContractPaths.push(...contracts.written);
    if (hasErrors(diagnostics)) {
      throw new Error("generated contract refresh failed");
    }
    return { diagnostics, writtenContractPaths };
  } catch (error) {
    const rollbackError = await restoreFiles(backups, options.directory).catch(
      (rollbackFailure: unknown) => rollbackFailure
    );
    diagnostics.push(
      diagnostic(
        "SUPA_REBASELINE_REPLACEMENT_FAILED",
        "error",
        error instanceof Error ? error.message : String(error),
        {
          hint:
            rollbackError === undefined
              ? "The previous migration history and generated contracts were restored."
              : `Rollback also failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        }
      )
    );
    return { diagnostics, writtenContractPaths: [] };
  }
}

interface FileBackup {
  backup: string;
  exists: boolean;
  original: string;
}

async function backupFiles(files: string[], backupRoot: string) {
  const backups: FileBackup[] = [];
  await mkdir(backupRoot, { recursive: true });
  for (let index = 0; index < files.length; index += 1) {
    const original = files[index];
    if (original === undefined) {
      continue;
    }
    const backup = join(backupRoot, String(index));
    const exists = await pathExists(original);
    if (exists) {
      await copyFile(original, backup);
    }
    backups.push({ backup, exists, original });
  }
  return backups;
}

async function restoreFiles(backups: FileBackup[], directory: string): Promise<void> {
  for (const file of await migrationFiles(directory)) {
    await rm(file, { force: true });
  }
  for (const entry of backups) {
    if (entry.exists) {
      await copyFile(entry.backup, entry.original);
    } else if (await pathExists(entry.original)) {
      await rm(entry.original, { force: true });
    }
  }
}

async function stageRebaselineClosure(options: {
  config: SupaschemaConfig;
  configPath?: string;
  cwd: string;
  migrationPaths: string[];
}): Promise<string[]> {
  const { stdout } = await execFileAsync("git", [
    "-C",
    options.cwd,
    "rev-parse",
    "--show-toplevel",
  ]);
  const root = await realpath(stdout.trim());
  const migrationPaths = await Promise.all(options.migrationPaths.map(canonicalPath));
  const tracked = await execFileAsync("git", [
    "-C",
    root,
    "ls-files",
    "-z",
    "--",
    ...migrationPaths,
  ]);
  const paths = new Set<string>(tracked.stdout.split("\0").filter((path) => path.length > 0));
  for (const path of migrationPaths) {
    if (await pathExists(path)) {
      paths.add(path);
    }
  }
  const candidates = [
    ...options.config.schemaPaths.map((path) => resolve(options.cwd, path)),
    resolve(options.cwd, options.config.typesFile),
    resolve(options.cwd, options.config.zodFile),
    resolve(options.cwd, options.configPath ?? "supaschema.config.json"),
  ];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      paths.add(await canonicalPath(candidate));
    }
  }
  const selected = [...paths];
  await execFileAsync("git", ["-C", root, "add", "-A", "--", ...selected]);
  const staged = await execFileAsync("git", [
    "-C",
    root,
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--",
    ...selected,
  ]);
  return staged.stdout.split("\0").filter((path) => path.length > 0);
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(await realpath(dirname(path)), basename(path));
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
