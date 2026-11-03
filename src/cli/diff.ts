import { execFile } from "node:child_process";
import { realpathSync, watch } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Command } from "commander";
import type { SupaschemaConfig } from "../config/schema.js";
import {
  formatConfigValidationDiagnostics,
  pendingInstallPathConfirmationDiagnostic,
} from "../config/validate.js";
import { resolveDatabaseUrl } from "../database/url.js";
import { diagnostic, hasErrors } from "../diagnostics/diagnostics.js";
import { MODEL_FORMAT_VERSION } from "../hash.js";
import { defaultMigrationName, migrationFiles, nextMigrationFile } from "../migrations/files.js";
import { latestLineage, lineagePrefix, parseLineage } from "../migrations/lineage.js";
import { migrationFileVersion, migrationsStatus } from "../migrations/status.js";
import { pathContainsOrEqual } from "../paths.js";
import { buildSchemaDiffPlan } from "../pipeline/diff.js";
import { resolveGenerationSourceDefaults, type SchemaPlanningMode } from "../planner/context.js";
import { redactSecrets } from "../redaction.js";
import { renderMigrationSplit } from "../render/migration.js";
import { parseSchemaFilter } from "../source/extract.js";
import { resolveMigrationsDir } from "../source/resolve.js";
import type { Diagnostic, MigrationPlan } from "../types.js";
import type { SummaryTone } from "./tools.js";
import { colorizeSummaryLine } from "./tools.js";

const execFileAsync = promisify(execFile);

interface PlanCommandOptions {
  from?: string;
  migrationsDir?: string;
  schema?: string;
  timing?: boolean;
  to?: string;
}
type DiffOptions = PlanCommandOptions & {
  checkChain: boolean;
  databaseUrl?: string;
  dryRun?: boolean;
  failOnDiff?: boolean;
  json?: boolean;
  migrationsDir?: string;
  name?: string;
  out?: string;
  replace?: string;
  routinePrivilegeDatabaseUrl?: string;
  routinePrivilegeDrift?: boolean;
  summary?: boolean;
  watch?: boolean;
  writeHints?: string;
};

export interface DiffCommandContext {
  cliVersion: string;
  configPath: () => string | undefined;
  loadCliConfig: () => Promise<SupaschemaConfig>;
  printDiagnostics: (diagnostics: Diagnostic[]) => void;
  resolveCliDatabaseUrl: (explicit?: string) => Promise<string | undefined>;
}

export function registerDiffCommands(program: Command, context: DiffCommandContext): void {
  program
    .command("plan")
    .option("--from <source>", "source model before the change (default: config.sources.from)")
    .option("--to <target>", "source model after the change (default: config.schemaPaths)")
    .option("--schema <names>", "comma-separated schema filter")
    .option("--timing", "print extract/plan phase timings to stderr")
    .description("Print the planned object-level schema diff as JSON (use `diff` to render SQL).")
    .action(async (options: PlanCommandOptions) => {
      const config = await context.loadCliConfig();
      const resolved = await withSourceDefaults(options, config);
      if (printBlockingSourceDiagnostics(resolved, context)) {
        return;
      }
      const plan = await buildPlan(resolved, config);
      context.printDiagnostics(plan.diagnostics);
      process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      if (hasErrors(plan.diagnostics)) {
        process.exitCode = 2;
      }
    });

  program
    .command("diff")
    .option("--from <source>", "source model before the change (default: config.sources.from)")
    .option("--to <target>", "source model after the change (default: config.schemaPaths)")
    .option(
      "--out <file>",
      "output file path or stdout (default: <migrations-dir>/<UTC timestamp>_<name>.sql)"
    )
    .option("--name <snake_case>", "migration name (default: derived from the planned operations)")
    .option("--migrations-dir <dir>", "migrations directory (default: config.migrationsDir)")
    .option(
      "--replace <file>",
      "replace an unapplied generated migration in the migrations directory"
    )
    .option("--schema <names>", "comma-separated schema filter")
    .option("--dry-run", "print the migration and target path without writing")
    .option("--json", "print a JSON payload (fingerprint, operations, sql) instead of raw SQL")
    .option("--fail-on-diff", "exit with code 3 when the plan contains operations (CI drift gate)")
    .option(
      "--no-check-chain",
      "skip the lineage chain gate against pending supaschema migrations in the output directory"
    )
    .option(
      "--summary",
      "print a drift report (operation and diagnostic counts grouped by kind and schema) before any error exit"
    )
    .option(
      "--write-hints <file>",
      "write the gated destructive object keys as a hints.destructive skeleton for review (never overwrites)"
    )
    .option(
      "--routine-privilege-drift",
      "also plan declared routine REVOKEs whose grantee still holds EXECUTE in the applied database (reads the database catalog)"
    )
    .option(
      "--database-url <url>",
      "database read by --routine-privilege-drift (default: --env, SUPASCHEMA_DATABASE_URL, then the local Supabase stack from supabase/config.toml)"
    )
    .option("--timing", "print extract/plan/render phase timings to stderr")
    .option(
      "--watch",
      "re-print the drift summary whenever a dir: source changes (editor loop; implies --dry-run --summary)"
    )
    .description(
      "Render a replay-safe migration from the configured source diff (zero flags: config.sources -> migrations directory)."
    )
    .action(async (options: DiffOptions) => {
      const config = await context.loadCliConfig();
      if (isZeroSourceDiff(options)) {
        const pendingInstall = await pendingInstallPathConfirmationDiagnostic(
          process.cwd(),
          context.configPath()
        );
        if (pendingInstall) {
          process.stderr.write(formatConfigValidationDiagnostics([pendingInstall]));
          process.exitCode = 2;
          return;
        }
      }
      const routinePrivilegeDatabaseUrl = await resolveRoutinePrivilegeDatabaseUrl(
        options,
        context
      );
      const resolved = await withSourceDefaults(
        routinePrivilegeDatabaseUrl === undefined
          ? options
          : { ...options, routinePrivilegeDatabaseUrl },
        config
      );
      if (printBlockingSourceDiagnostics(resolved, context)) {
        return;
      }
      if (resolved.watch) {
        await watchDiff(resolved, config, context);
        return;
      }
      await runDiff(resolved, config, context);
    });
}

function isZeroSourceDiff(options: PlanCommandOptions): boolean {
  return options.from === undefined && options.to === undefined;
}

async function resolveRoutinePrivilegeDatabaseUrl(
  options: DiffOptions,
  context: Pick<DiffCommandContext, "resolveCliDatabaseUrl">
): Promise<string | undefined> {
  if (options.routinePrivilegeDrift !== true) {
    if (options.databaseUrl !== undefined) {
      throw new Error(
        "--database-url only selects the database that --routine-privilege-drift reads; add --routine-privilege-drift or remove --database-url"
      );
    }
    return;
  }
  const databaseUrl = await context.resolveCliDatabaseUrl(options.databaseUrl);
  if (databaseUrl === undefined) {
    throw new Error(
      "no database URL for --routine-privilege-drift: pass --database-url, --env, set SUPASCHEMA_DATABASE_URL, or run inside a project with supabase/config.toml"
    );
  }
  return databaseUrl;
}

type WithSources<T> = T & {
  from: string;
  mode: SchemaPlanningMode;
  sourceDiagnostics: Diagnostic[];
  to: string;
};

export function replacedMigrationFiles(replace: string | undefined): string[] | undefined {
  if (replace === undefined) {
    return;
  }
  const replacementPath = resolve(process.cwd(), replace);
  return [replacementPath, `${stripSqlExtension(replacementPath)}.concurrent.sql`];
}

async function withSourceDefaults<T extends PlanCommandOptions & { replace?: string }>(
  options: T,
  config: SupaschemaConfig
): Promise<WithSources<T>> {
  const mode = planningMode(options);
  const excludeMigrationFiles = replacedMigrationFiles(options.replace);
  const resolved = await resolveGenerationSourceDefaults(
    {
      ...options,
      ...(excludeMigrationFiles === undefined ? {} : { excludeMigrationFiles }),
      mode,
    },
    config
  );
  if (resolved.notice !== undefined) {
    process.stderr.write(resolved.notice);
  }
  return {
    ...options,
    from: resolved.from,
    mode,
    sourceDiagnostics: resolved.diagnostics,
    to: resolved.to,
  };
}

function planningMode(options: PlanCommandOptions): SchemaPlanningMode {
  return "failOnDiff" in options && options.failOnDiff === true ? "drift" : "generation";
}

function printBlockingSourceDiagnostics(
  options: WithSources<PlanCommandOptions>,
  context: Pick<DiffCommandContext, "printDiagnostics">
): boolean {
  if (options.sourceDiagnostics.length === 0) {
    return false;
  }
  context.printDiagnostics(options.sourceDiagnostics);
  if (hasErrors(options.sourceDiagnostics)) {
    process.exitCode = 2;
    return true;
  }
  return false;
}

async function runDiff(
  options: WithSources<DiffOptions>,
  config: SupaschemaConfig,
  context: DiffCommandContext
): Promise<void> {
  const preflightDiagnostics = await diffWorkspacePreflightDiagnostics(
    options,
    config,
    context.configPath()
  );
  if (preflightDiagnostics.length > 0) {
    context.printDiagnostics(preflightDiagnostics);
    if (hasErrors(preflightDiagnostics)) {
      process.exitCode = 2;
      return;
    }
  }
  const plan = await buildPlan(options, config);
  context.printDiagnostics(plan.diagnostics);
  printDiffSummary(options, plan);
  await writeDiffHints(options, plan);
  if (hasErrors(plan.diagnostics)) {
    process.exitCode = 2;
    return;
  }
  const output = await renderDiffOutput(options, plan, config, context.cliVersion);
  if (output.shouldSkipEmptyWrite) {
    process.stderr.write("no schema changes\n");
    return;
  }
  if (!(await validateReplacement(options, plan, config, context))) {
    return;
  }
  if (
    !(await validateLineageChain(
      output.outPath,
      plan,
      context,
      options.checkChain && options.replace === undefined
    ))
  ) {
    return;
  }
  if (output.shouldRefuseEmptyWrite) {
    context.printDiagnostics([
      diagnostic("SUPA_DIFF_EMPTY_PLAN", "error", "refusing to write an empty migration", {
        file: output.outPath,
        hint: "No schema operations were planned. Use a read-only output such as --dry-run, --json, or --out stdout to inspect an empty plan.",
      }),
    ]);
    process.exitCode = 2;
    return;
  }
  if (!(await writeOrPrintDiffOutput(options, output, context))) {
    return;
  }
  if (options.failOnDiff && plan.operations.length > 0) {
    process.exitCode = 3;
  }
}

function printDiffSummary(options: WithSources<DiffOptions>, plan: MigrationPlan): void {
  if (options.summary) {
    process.stdout.write(renderPlanSummary(plan));
  }
}

async function writeDiffHints(
  options: WithSources<DiffOptions>,
  plan: MigrationPlan
): Promise<void> {
  if (!options.writeHints) {
    return;
  }
  const keys = [
    ...new Set(
      plan.operations
        .filter((operation) => operation.blocked && operation.destructive)
        .map((operation) => operation.key)
    ),
  ].sort((left, right) => left.localeCompare(right));
  const hintsPath = resolve(process.cwd(), options.writeHints);
  await writeFile(hintsPath, `${JSON.stringify({ hints: { destructive: keys } }, null, 2)}\n`, {
    flag: "wx",
  });
  process.stderr.write(
    `wrote ${keys.length} gated object keys to ${hintsPath}; review each before merging into hints.destructive\n`
  );
}

interface DiffOutput {
  concurrentPath: string | undefined;
  outPath: string | undefined;
  payload: string;
  rendered: ReturnType<typeof renderMigrationSplit>;
  shouldRefuseEmptyWrite: boolean;
  shouldSkipEmptyWrite: boolean;
}

async function renderDiffOutput(
  options: WithSources<DiffOptions>,
  plan: MigrationPlan,
  config: SupaschemaConfig,
  cliVersion: string
): Promise<DiffOutput> {
  const renderStart = performance.now();
  const rendered = renderMigrationSplit(plan, { config, version: cliVersion });
  if (options.timing) {
    process.stderr.write(`timing: render ${Math.round(performance.now() - renderStart)}ms\n`);
  }
  const migrationsDir = resolveMigrationsDir(options.migrationsDir, config);
  const defaultedOut =
    options.name === undefined && options.out === undefined && options.replace === undefined;
  const outPath = await resolveDiffOutPath(options, plan, migrationsDir);
  const concurrentPath =
    rendered.concurrentSql !== undefined && outPath !== undefined
      ? `${stripSqlExtension(outPath)}.concurrent.sql`
      : undefined;
  return {
    concurrentPath,
    outPath,
    payload: renderDiffPayload(options, plan, rendered, outPath, concurrentPath),
    rendered,
    shouldRefuseEmptyWrite: shouldRefuseEmptyWrite(options, plan, outPath),
    shouldSkipEmptyWrite: defaultedOut && plan.operations.length === 0 && !options.json,
  };
}

function shouldRefuseEmptyWrite(
  options: WithSources<DiffOptions>,
  plan: MigrationPlan,
  outPath: string | undefined
): boolean {
  if (plan.operations.length > 0 || outPath === undefined || options.dryRun || options.json) {
    return false;
  }
  return (
    options.replace !== undefined ||
    options.name !== undefined ||
    (options.out !== undefined && options.out !== "stdout")
  );
}

function stripSqlExtension(value: string): string {
  return value.endsWith(".sql") ? value.slice(0, -4) : value;
}

async function validateLineageChain(
  outPath: string | undefined,
  plan: MigrationPlan,
  context: DiffCommandContext,
  checkChain: boolean
): Promise<boolean> {
  if (outPath === undefined || !checkChain) {
    return true;
  }
  const chainDiagnostics = await checkLineageChain(plan, dirname(outPath));
  if (chainDiagnostics.length === 0) {
    return true;
  }
  context.printDiagnostics(chainDiagnostics);
  if (hasErrors(chainDiagnostics)) {
    process.exitCode = 2;
    return false;
  }
  return true;
}

async function writeOrPrintDiffOutput(
  options: WithSources<DiffOptions>,
  output: DiffOutput,
  context: DiffCommandContext
): Promise<boolean> {
  if (options.dryRun || output.outPath === undefined) {
    printDryRunOutput(output);
    return true;
  }
  if (!(await writeDiffFiles(output, context, options.replace !== undefined))) {
    return false;
  }
  process.stdout.write(
    options.json
      ? output.payload
      : `${output.outPath}\n${output.concurrentPath === undefined ? "" : `${output.concurrentPath}\n`}`
  );
  return true;
}

function printDryRunOutput(output: DiffOutput): void {
  if (output.outPath !== undefined) {
    process.stderr.write(`dry-run: would write ${output.outPath}\n`);
  }
  process.stdout.write(output.payload);
}

async function writeDiffFiles(
  output: DiffOutput,
  context: DiffCommandContext,
  replace: boolean
): Promise<boolean> {
  if (output.outPath === undefined) {
    return true;
  }
  try {
    await mkdir(dirname(output.outPath), { recursive: true });
    await writeSqlFile(output.outPath, output.rendered.sql, replace);
    if (output.rendered.concurrentSql !== undefined && output.concurrentPath !== undefined) {
      await writeSqlFile(output.concurrentPath, output.rendered.concurrentSql, replace);
    } else if (replace) {
      await rm(`${stripSqlExtension(output.outPath)}.concurrent.sql`, { force: true });
    }
    return true;
  } catch (error) {
    return handleDiffWriteError(error, output.outPath, context);
  }
}

async function writeSqlFile(path: string, sql: string, replace: boolean): Promise<void> {
  if (!replace) {
    await writeFile(path, sql, { flag: "wx" });
    return;
  }
  const tmpPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, sql, { flag: "wx" });
  await rename(tmpPath, path);
}

function handleDiffWriteError(
  error: unknown,
  outPath: string,
  context: DiffCommandContext
): boolean {
  if (error instanceof Error && "code" in error && error.code === "EEXIST") {
    context.printDiagnostics([
      diagnostic(
        "SUPA_DIFF_OUTPUT_EXISTS",
        "error",
        "the output migration file already exists; supaschema does not overwrite migrations outside diff --replace",
        {
          file: outPath,
          hint: "Choose a new --out path or --name, or remove the stale file.",
        }
      ),
    ]);
    process.exitCode = 2;
    return false;
  }
  throw error;
}

async function watchDiff(
  options: WithSources<DiffOptions>,
  config: SupaschemaConfig,
  context: DiffCommandContext
): Promise<void> {
  const watchedDirs = [options.from, options.to]
    .filter((source) => source.startsWith("dir:"))
    .map((source) => resolve(process.cwd(), source.slice("dir:".length)));
  if (watchedDirs.length === 0) {
    process.stderr.write("--watch requires at least one dir: source to watch\n");
    process.exitCode = 1;
    return;
  }
  const watchedOptions: WithSources<DiffOptions> = {
    ...options,
    dryRun: true,
    summary: true,
    watch: false,
  };
  let running = false;
  let queued = false;
  const run = async () => {
    if (running) {
      queued = true;
      return;
    }
    running = true;
    try {
      const startedAt = new Date().toISOString();
      process.stdout.write(`\nwatch: diff at ${startedAt}\n`);
      await runDiff(watchedOptions, config, context);
      process.exitCode = 0;
    } catch (error) {
      process.stderr.write(
        `${redactSecrets(error instanceof Error ? error.message : String(error))}\n`
      );
    } finally {
      running = false;
      if (queued) {
        queued = false;
        await run();
      }
    }
  };
  await run();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleRun = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      run().catch((error: unknown) => {
        process.stderr.write(
          `${redactSecrets(error instanceof Error ? error.message : String(error))}\n`
        );
        process.exitCode = 2;
      });
    }, 250);
  };
  for (const dir of watchedDirs) {
    watch(dir, { recursive: true }, scheduleRun);
  }
  process.stdout.write(`watch: watching ${watchedDirs.join(", ")} (ctrl-c to exit)\n`);
  await new Promise(() => undefined);
}

function buildPlan(
  options: WithSources<PlanCommandOptions> & {
    migrationsDir?: string;
    replace?: string;
    routinePrivilegeDatabaseUrl?: string;
  },
  config: SupaschemaConfig
): Promise<MigrationPlan> {
  const excludeMigrationFiles = replacedMigrationFiles(options.replace);
  return buildSchemaDiffPlan({
    ...(options.replace === undefined ? {} : { checkMigrationBaseline: false }),
    config,
    ...(excludeMigrationFiles === undefined ? {} : { excludeMigrationFiles }),
    from: options.from,
    ...(options.migrationsDir === undefined ? {} : { migrationsDir: options.migrationsDir }),
    mode: options.mode,
    ...(options.routinePrivilegeDatabaseUrl === undefined
      ? {}
      : { routinePrivilegeDatabaseUrl: options.routinePrivilegeDatabaseUrl }),
    ...(options.schema === undefined ? {} : { schema: options.schema }),
    ...(options.timing === undefined ? {} : { timing: options.timing }),
    to: options.to,
  });
}

interface GitStatusEntry {
  indexStatus: string;
  originalPath?: string;
  path: string;
  worktreeStatus: string;
}

async function diffWorkspacePreflightDiagnostics(
  options: WithSources<DiffOptions>,
  config: SupaschemaConfig,
  configPath: string | undefined
): Promise<Diagnostic[]> {
  if (!options.to.startsWith("dir:")) {
    return [];
  }
  const toDir = normalizeGitPath(options.to.slice("dir:".length));
  const migrationsDir = normalizeGitPath(resolveMigrationsDir(options.migrationsDir, config));
  const generatedContractPaths = [config.typesFile, config.zodFile].map(normalizeGitPath);
  const normalizedConfigPath = normalizeGitPath(configPath ?? "supaschema.config.json");
  const entries = await gitStatusEntries([
    toDir,
    migrationsDir,
    ...generatedContractPaths,
    normalizedConfigPath,
  ]);
  const dirtyEntries = entries.filter(
    options.from === "git:INDEX" ? hasUnstagedGitState : hasDirtyGitState
  );
  if (dirtyEntries.length === 0) {
    return [];
  }

  const diagnostics: Diagnostic[] = [];
  const blockingMigrations =
    options.replace === undefined
      ? await dirtyClosureMigrations(dirtyEntries, migrationsDir, options.from, options.schema)
      : [];
  if (blockingMigrations.length > 0) {
    diagnostics.push(
      diagnostic(
        "SUPA_DIFF_MIGRATIONS_DIRTY",
        "error",
        "migration generation cannot run while the migrations directory has uncommitted files",
        {
          file: blockingMigrations[0]?.path,
          hint: `Close the existing migration closure before generating another one. Dirty migration files: ${formatPathList(entryPaths(blockingMigrations))}.`,
        }
      )
    );
  }

  const dirtyGeneratedContracts = dirtyEntries.filter((entry) =>
    generatedContractPaths.some((path) => entryTouchesPath(entry, path))
  );
  if (dirtyGeneratedContracts.length > 0) {
    diagnostics.push(
      diagnostic(
        "SUPA_DIFF_GENERATED_CONTRACT_DIRTY",
        "error",
        "generated contract outputs are dirty before migration generation",
        {
          file: dirtyGeneratedContracts[0]?.path,
          hint: `Generated TypeScript/Zod contracts must be refreshed after a migration closure, not before it. Dirty generated outputs: ${formatPathList(entryPaths(dirtyGeneratedContracts))}.`,
        }
      )
    );
  }

  if (
    options.schema !== undefined &&
    dirtyEntries.some((entry) => entryTouchesPath(entry, normalizedConfigPath))
  ) {
    diagnostics.push(
      diagnostic(
        "SUPA_DIFF_CONFIG_DIRTY",
        "error",
        "scoped migration generation cannot run while supaschema.config.json is dirty",
        {
          file: normalizedConfigPath,
          hint: "Close the config change with the migration it belongs to, or run an unscoped diff that owns the config change.",
        }
      )
    );
  }

  const outOfScopeSchemaPaths = scopedDirtySchemaPaths(dirtyEntries, toDir, options.schema);
  if (outOfScopeSchemaPaths.length > 0) {
    diagnostics.push(
      diagnostic(
        "SUPA_DIFF_SCOPED_DIRTY_SCHEMA",
        "error",
        "scoped migration generation cannot run while out-of-scope schema files are dirty",
        {
          file: outOfScopeSchemaPaths[0],
          hint: `The scoped diff requested schema(s) ${formatPathList([...parseSchemaFilter(options.schema)])}, but these schema files are dirty outside that scope: ${formatPathList(outOfScopeSchemaPaths)}.`,
        }
      )
    );
  }
  return diagnostics;
}

async function dirtyClosureMigrations(
  dirtyEntries: GitStatusEntry[],
  migrationsDir: string,
  from: string,
  schema: string | undefined
): Promise<GitStatusEntry[]> {
  const dirty = dirtyEntries.filter((entry) => entryTouchesPath(entry, migrationsDir));
  if (from.startsWith("git:")) {
    return dirty;
  }
  const blocking: GitStatusEntry[] = [];
  for (const entry of dirty) {
    if (schema !== undefined || (await hasLineageMarker(entry.path))) {
      blocking.push(entry);
    }
  }
  return blocking;
}

async function hasLineageMarker(path: string): Promise<boolean> {
  try {
    return (await readFile(path, "utf8")).includes(lineagePrefix);
  } catch {
    return true;
  }
}

async function gitStatusEntries(paths: string[]): Promise<GitStatusEntry[]> {
  const pathSpecs = [
    ...new Set(paths.filter((path) => path.length > 0 && !isOutsideWorkingDirectory(path))),
  ];
  if (pathSpecs.length === 0) {
    return [];
  }
  try {
    const result = await execFileAsync(
      "git",
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...pathSpecs],
      { maxBuffer: 1024 * 1024 }
    );
    return parseGitStatusPorcelain(result.stdout);
  } catch {
    return [];
  }
}

function parseGitStatusPorcelain(raw: string): GitStatusEntry[] {
  const tokens = raw.split("\0");
  const entries: GitStatusEntry[] = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    index += 1;
    if (!token || token.length < 4) {
      continue;
    }
    const entry: GitStatusEntry = {
      indexStatus: token[0] ?? " ",
      path: normalizeGitPath(token.slice(3)),
      worktreeStatus: token[1] ?? " ",
    };
    if (entry.indexStatus === "R" || entry.indexStatus === "C") {
      entry.originalPath = normalizeGitPath(tokens[index] ?? "");
      index += 1;
    }
    entries.push(entry);
  }
  return entries;
}

function hasDirtyGitState(entry: GitStatusEntry): boolean {
  return entry.indexStatus !== " " || entry.worktreeStatus !== " ";
}

function hasUnstagedGitState(entry: GitStatusEntry): boolean {
  return entry.worktreeStatus !== " ";
}

function scopedDirtySchemaPaths(
  entries: GitStatusEntry[],
  schemaRoot: string,
  schemaFilter: string | undefined
): string[] {
  const schemas = parseSchemaFilter(schemaFilter);
  if (schemas.size === 0) {
    return [];
  }
  return [
    ...new Set(
      entries.flatMap((entry) => {
        const affected = entryPaths([entry]).filter((path) => pathContains(schemaRoot, path));
        if (affected.length === 0) {
          return [];
        }
        return affected.every((path) => schemaPathMatchesScope(schemaRoot, path, schemas))
          ? []
          : affected;
      })
    ),
  ].sort((left, right) => left.localeCompare(right));
}

function schemaPathMatchesScope(
  schemaRoot: string,
  path: string,
  schemas: ReadonlySet<string>
): boolean {
  const schema = schemaFromPath(schemaRoot, path);
  return schema !== undefined && schemas.has(schema);
}

function schemaFromPath(schemaRoot: string, path: string): string | undefined {
  if (!pathContains(schemaRoot, path) || path === schemaRoot) {
    return;
  }
  const suffix = path.slice(schemaRoot.length + 1);
  const firstSegment = suffix.split("/").find(Boolean);
  if (!firstSegment) {
    return;
  }
  return firstSegment.endsWith(".sql")
    ? firstSegment.slice(0, -".sql".length).toLowerCase()
    : firstSegment.toLowerCase();
}

function entryTouchesPath(entry: GitStatusEntry, path: string): boolean {
  return entryPaths([entry]).some((entryPath) => pathContains(path, entryPath));
}

function entryPaths(entries: GitStatusEntry[]): string[] {
  return entries.flatMap((entry) =>
    [entry.path, entry.originalPath].filter((path): path is string => Boolean(path))
  );
}

function pathContains(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function normalizeGitPath(path: string): string {
  const relativePath = isAbsolute(path)
    ? relative(realPathOrSelf(process.cwd()), realPathOrSelf(path))
    : path;
  return relativePath.split(sep).join("/");
}

function realPathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function isOutsideWorkingDirectory(path: string): boolean {
  return path === ".." || path.startsWith("../");
}

function formatPathList(paths: string[], limit = 6): string {
  const values = [...new Set(paths.filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
  const visible = values.slice(0, limit).join(", ");
  return values.length > limit ? `${visible}, +${values.length - limit} more` : visible;
}

async function resolveDiffOutPath(
  options: WithSources<DiffOptions>,
  plan: MigrationPlan,
  migrationsDir: string
): Promise<string | undefined> {
  if (options.replace !== undefined) {
    return resolve(process.cwd(), options.replace);
  }
  if (options.out === "stdout") {
    return;
  }
  if (options.out !== undefined) {
    return resolve(process.cwd(), options.out);
  }
  return resolve(
    process.cwd(),
    await nextMigrationFile(migrationsDir, options.name ?? defaultMigrationName(plan))
  );
}

async function validateReplacement(
  options: WithSources<DiffOptions>,
  plan: MigrationPlan,
  config: SupaschemaConfig,
  context: DiffCommandContext
): Promise<boolean> {
  if (options.replace === undefined) {
    return true;
  }
  const migrationsDir = resolve(process.cwd(), resolveMigrationsDir(options.migrationsDir, config));
  const path = resolve(process.cwd(), options.replace);
  const diagnostics: Diagnostic[] = [];
  if (!pathContainsOrEqual(migrationsDir, path)) {
    diagnostics.push(
      diagnostic(
        "SUPA_DIFF_REPLACE_BASELINE_REQUIRED",
        "error",
        "replacement migration must be inside the configured migrations directory",
        { file: path, hint: `Use a migration under ${migrationsDir}.` }
      )
    );
  }
  const sql = await readFile(path, "utf8").catch((error: unknown) => {
    diagnostics.push(
      diagnostic(
        "SUPA_DIFF_REPLACE_BASELINE_REQUIRED",
        "error",
        error instanceof Error ? error.message : String(error),
        { file: path, hint: "Pass the generated migration file that should be replaced." }
      )
    );
  });
  const lineage = sql === undefined ? undefined : parseLineage(sql.slice(0, 4096));
  if (sql !== undefined && lineage === undefined) {
    diagnostics.push(
      diagnostic(
        "SUPA_DIFF_REPLACE_HAND_AUTHORED",
        "error",
        "diff --replace only replaces supaschema-generated migrations",
        { file: path, hint: "Create a forward migration for hand-authored SQL." }
      )
    );
  }
  if (
    lineage !== undefined &&
    plan.fromFingerprint !== lineage.from &&
    !lineageFormatDiffers(lineage)
  ) {
    diagnostics.push(
      diagnostic(
        "SUPA_DIFF_REPLACE_BASELINE_REQUIRED",
        "error",
        "replacement baseline does not match the generated migration lineage",
        {
          file: path,
          hint: `The replacement starts at ${plan.fromFingerprint.slice(0, 12)}..., but ${basename(path)} starts at ${lineage.from.slice(0, 12)}.... Use the source baseline that produced the original migration.`,
        }
      )
    );
  }
  if (
    lineage !== undefined &&
    plan.fromFingerprint !== lineage.from &&
    lineageFormatDiffers(lineage)
  ) {
    diagnostics.push(
      diagnostic(
        "SUPA_MIGRATION_BASELINE_FORMAT_DRIFT",
        "warning",
        "replacement migration lineage was produced by a different model format; continuing because the old and current fingerprints are not directly comparable",
        {
          file: path,
          hint: `${basename(path)} records model format ${lineage.modelFormatVersion ?? "legacy"}, while the current extractor uses model format ${MODEL_FORMAT_VERSION}. Applied-state checks still run before replacement.`,
        }
      )
    );
  }
  if (diagnostics.length === 0) {
    diagnostics.push(...(await replacementTipDiagnostics(path, migrationsDir)));
  }
  if (diagnostics.length === 0) {
    diagnostics.push(...(await replacementAppliedStateDiagnostics(path, migrationsDir, config)));
  }
  if (diagnostics.length > 0) {
    context.printDiagnostics(diagnostics);
    if (diagnostics.some((item) => item.severity === "error")) {
      process.exitCode = 2;
      return false;
    }
  }
  return true;
}

function lineageFormatDiffers(lineage: { modelFormatVersion?: number }): boolean {
  return (
    lineage.modelFormatVersion === undefined || lineage.modelFormatVersion !== MODEL_FORMAT_VERSION
  );
}

async function replacementTipDiagnostics(
  path: string,
  migrationsDir: string
): Promise<Diagnostic[]> {
  const latest = (await migrationFiles(migrationsDir))
    .filter((file) => migrationFileVersion(basename(file)) !== undefined)
    .filter((file) => !file.endsWith(".concurrent.sql"))
    .at(-1);
  if (latest === undefined || samePath(latest, path)) {
    return [];
  }
  return [
    diagnostic(
      "SUPA_DIFF_REPLACE_NOT_LATEST",
      "error",
      "diff --replace can only replace the latest migration in the configured migrations directory",
      {
        file: path,
        hint: `Replace or remove newer pending migrations first. Latest migration is ${basename(latest)}.`,
      }
    ),
  ];
}

function samePath(left: string, right: string): boolean {
  return pathContainsOrEqual(left, right) && pathContainsOrEqual(right, left);
}

async function replacementAppliedStateDiagnostics(
  path: string,
  migrationsDir: string,
  config: SupaschemaConfig
): Promise<Diagnostic[]> {
  const version = migrationFileVersion(basename(path));
  if (version === undefined) {
    return [
      diagnostic(
        "SUPA_DIFF_REPLACE_BASELINE_REQUIRED",
        "error",
        "replacement migration filename does not start with a migration version",
        { file: path }
      ),
    ];
  }
  const targets = replacementHistoryTargets(config);
  if (targets.length === 0) {
    return [
      diagnostic(
        "SUPA_DIFF_REPLACE_APPLIED_STATE_UNVERIFIED",
        "warning",
        "no database migration history target was available for replacement gating",
        {
          file: path,
          hint: "Supaschema can only prove unapplied state from a resolved database history table.",
        }
      ),
    ];
  }
  const diagnostics: Diagnostic[] = [];
  for (const target of targets) {
    const status = await migrationsStatus({
      allowMissingHistoryTable: true,
      databaseUrl: target.databaseUrl,
      directory: migrationsDir,
      historyTable: target.historyTable,
      targetLabel: target.label,
    });
    diagnostics.push(...status.diagnostics.filter((item) => item.severity === "error"));
    if (status.report.applied.some((file) => migrationFileVersion(file) === version)) {
      diagnostics.push(
        diagnostic(
          "SUPA_DIFF_REPLACE_APPLIED",
          "error",
          "refusing to replace a migration that is already applied on a configured target",
          {
            file: path,
            hint: `Version ${version} is recorded in ${target.label} (${target.historyTable}). Create a forward migration instead.`,
          }
        )
      );
    }
  }
  return diagnostics;
}

function replacementHistoryTargets(
  config: SupaschemaConfig
): { databaseUrl: string; historyTable: string; label: string }[] {
  const targets = new Map<string, { databaseUrl: string; historyTable: string; label: string }>();
  for (const [label, target] of Object.entries(config.sync.targets)) {
    const configured =
      target.databaseUrl ?? config.environments[target.environment ?? ""]?.databaseUrl;
    let databaseUrl: string | undefined;
    try {
      databaseUrl = resolveDatabaseUrl(configured);
    } catch {
      continue;
    }
    if (databaseUrl === undefined) {
      continue;
    }
    const key = `${databaseUrl}\n${target.historyTable}`;
    targets.set(key, { databaseUrl, historyTable: target.historyTable, label });
  }
  return [...targets.values()];
}

function renderDiffPayload(
  options: WithSources<DiffOptions>,
  plan: MigrationPlan,
  rendered: ReturnType<typeof renderMigrationSplit>,
  outPath: string | undefined,
  concurrentPath: string | undefined
): string {
  if (options.json) {
    return `${JSON.stringify(
      {
        concurrentOut: concurrentPath,
        concurrentSql: rendered.concurrentSql,
        fingerprint: plan.fingerprint,
        operations: plan.operations.map((operation) => ({
          blocked: operation.blocked,
          destructive: operation.destructive,
          key: operation.key,
          kind: operation.kind,
        })),
        out: outPath ?? "stdout",
        sql: rendered.sql,
      },
      null,
      2
    )}\n`;
  }
  if (rendered.concurrentSql !== undefined && outPath === undefined) {
    return renderCombinedSql(rendered.sql, rendered.concurrentSql);
  }
  return rendered.sql;
}

async function checkLineageChain(plan: MigrationPlan, directory: string): Promise<Diagnostic[]> {
  const latest = await latestLineage(directory);
  if (!latest) {
    return [];
  }
  if (latest.from === plan.fromFingerprint && latest.to === plan.toFingerprint) {
    return [
      diagnostic(
        "SUPA_DIFF_LINEAGE_DUPLICATE",
        "error",
        "a pending supaschema migration already covers this exact from/to transition",
        {
          file: latest.file,
          hint: "Apply or remove the pending migration, or pass --no-check-chain to bypass.",
        }
      ),
    ];
  }
  if (latest.to !== plan.fromFingerprint) {
    if (lineageFormatDiffers(latest)) {
      return [
        diagnostic(
          "SUPA_MIGRATION_BASELINE_FORMAT_DRIFT",
          "warning",
          "newest supaschema migration lineage was produced by a different model format; continuing because the old and current fingerprints are not directly comparable",
          {
            file: latest.file,
            hint: `${basename(latest.file)} records model format ${latest.modelFormatVersion ?? "legacy"}, while the current extractor uses model format ${MODEL_FORMAT_VERSION}. Same-format lineage gaps still block.`,
          }
        ),
      ];
    }
    return [
      diagnostic(
        "SUPA_DIFF_LINEAGE_BROKEN",
        "error",
        "the plan's from-state does not continue the newest pending supaschema migration",
        {
          file: latest.file,
          hint: `Pending migration ends at model ${latest.to.slice(0, 12)}… but this plan starts from ${plan.fromFingerprint.slice(0, 12)}…; resolve a source-backed post-migration baseline (for example git:<ref>, dir:<path>, dump:<file>, catalog:<snapshot>, or empty:) or pass --no-check-chain.`,
        }
      ),
    ];
  }
  return [];
}

export function renderPlanSummary(plan: MigrationPlan): string {
  const lines: string[] = ["plan summary:"];
  const operationCounts = new Map<string, { count: number; tone: SummaryTone }>();
  for (const operation of plan.operations) {
    const label = `${operation.kind} ${operation.ref.kind}${operation.blocked ? " (blocked)" : ""}`;
    const tone = summaryTone(operation);
    const entry = operationCounts.get(label) ?? { count: 0, tone };
    entry.count += 1;
    operationCounts.set(label, entry);
  }
  lines.push(`  operations: ${plan.operations.length}`);
  for (const [label, entry] of [...operationCounts.entries()].sort(compareEntryText)) {
    lines.push(colorizeSummaryLine(`    ${entry.count} ${label}`, entry.tone));
  }
  const diagnosticCounts = new Map<string, number>();
  for (const item of plan.diagnostics) {
    const scope = item.ref
      ? ` ${item.ref.kind}${item.ref.schema ? ` ${item.ref.schema}` : ""}`
      : "";
    const label = `${item.severity.toUpperCase()} ${item.code}${scope}`;
    diagnosticCounts.set(label, (diagnosticCounts.get(label) ?? 0) + 1);
  }
  lines.push(`  diagnostics: ${plan.diagnostics.length}`);
  for (const [label, count] of [...diagnosticCounts.entries()].sort(compareEntryText)) {
    lines.push(`    ${count} ${label}`);
  }
  return `${lines.join("\n")}\n`;
}

function compareEntryText(left: readonly unknown[], right: readonly unknown[]): number {
  const leftText = String(left);
  const rightText = String(right);
  return Number(leftText > rightText) - Number(leftText < rightText);
}

function renderCombinedSql(sql: string, concurrentSql: string): string {
  return `${sql}\n${concurrentSql}`;
}

function summaryTone(operation: MigrationPlan["operations"][number]): SummaryTone {
  if (operation.blocked) {
    return "blocked";
  }
  if (operation.kind === "drop") {
    return "drop";
  }
  if (operation.kind === "create") {
    return "create";
  }
  return "plain";
}
