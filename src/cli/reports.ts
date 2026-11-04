import { rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { auditModel, renderAuditReport } from "../audit.js";
import {
  CHECK_REPORTER_DISPLAY,
  type CheckReporter,
  parseCheckReporter,
  renderCheckReport,
} from "../check/report.js";
import {
  formatConfigValidationDiagnostics,
  pendingInstallPathConfirmationDiagnostic,
} from "../config/validate.js";
import { resolveVerificationDatabaseUrl } from "../database/url.js";
import { diagnostic, hasErrors } from "../diagnostics/diagnostics.js";
import { stageGeneratedMigrations } from "../migrations/stage.js";
import {
  type MigrationsStatusOptions,
  type MigrationsStatusReport,
  migrationsStatus,
  renderMigrationsStatus,
} from "../migrations/status.js";
import { scanSchemaSafety } from "../pipeline/deploy-safety.js";
import { evaluateTypeContract } from "../pipeline/type-safety.js";
import { redactSecrets } from "../redaction.js";
import { scanGeneratedContractUsage } from "../scan/generated-contracts.js";
import { renderScan, scanDiagnostics, scoreGrade } from "../scan/model.js";
import {
  buildReadinessReport,
  classifyMigrationSystems,
  renderReadiness,
} from "../scan/onboard.js";
import { extractSourceModel } from "../source/extract.js";
import { currentBaselineFingerprints, defaultTreeSource } from "../source/resolve.js";
import type { Diagnostic, SupaschemaConfig } from "../types.js";
import { renderCorpusReport, runCorpus } from "../verify/corpus.js";
import { type RebaselineResult, rebaselineMigrations } from "../workflow/rebaseline.js";
import { syncMigrations } from "../workflow/sync.js";

export interface ReportCommandContext {
  cliVersion: string;
  configPath: () => string | undefined;
  globalEnvName: () => string | undefined;
  loadCliConfig: () => Promise<SupaschemaConfig>;
  printDiagnostics: (diagnostics: Diagnostic[]) => void;
  resolveCliDatabaseUrl: (explicit?: string) => Promise<string | undefined>;
}

interface SyncCommandOptions {
  databaseUrl?: string;
  diff?: boolean;
  ensureEnvironment?: boolean;
  from?: string;
  migrationsDir?: string;
  runner?: string;
  target?: string;
  to?: string;
}
interface ApplyCommandOptions {
  databaseUrl?: string;
  ensureEnvironment?: boolean;
  from?: string;
  migrationsDir?: string;
  runner?: string;
  target?: string;
  to?: string;
}
interface StageCommandOptions {
  dryRun?: boolean;
  migrationsDir?: string;
}

function describeLocation(diagnostic: Diagnostic): string {
  const ref = diagnostic.ref;
  if (ref === undefined) {
    return diagnostic.file ?? "the schema";
  }
  const qualified = ref.schema === undefined ? ref.name : `${ref.schema}.${ref.name}`;
  return `${ref.kind} ${qualified}`;
}

export function remediationPrompt(diagnostic: Diagnostic): string {
  const lines = [
    "You are a PostgreSQL migration-safety assistant. Propose a minimal, safe fix.",
    `Finding [${diagnostic.code}] (${diagnostic.severity}): ${diagnostic.message}`,
    diagnostic.hint === undefined ? "" : `Guidance: ${diagnostic.hint}`,
    `Location: ${describeLocation(diagnostic)}`,
    "Respond with: (1) the corrected SQL, (2) a one-line rationale. Change nothing unrelated.",
  ];
  return lines.filter((line) => line.length > 0).join("\n");
}

export function remediationCacheKey(diagnostic: Diagnostic): string {
  const ref = diagnostic.ref;
  const target =
    ref === undefined ? (diagnostic.file ?? "") : `${ref.kind}:${ref.schema ?? ""}.${ref.name}`;
  return `${diagnostic.code}|${target}`;
}

export interface RemediationStep {
  diagnostic: Diagnostic;
  order: number;
  prompt: string;
}

function severityRank(severity: string): number {
  if (severity === "error") {
    return 0;
  }
  return severity === "warning" ? 1 : 2;
}

export function buildRemediationPlan(diagnostics: Diagnostic[]): RemediationStep[] {
  return [...diagnostics]
    .sort((a, b) => severityRank(a.severity) - severityRank(b.severity))
    .map((diagnostic, index) => ({
      diagnostic,
      order: index + 1,
      prompt: remediationPrompt(diagnostic),
    }));
}

function resolveReporter(value: string | undefined): CheckReporter | null {
  const reporter = parseCheckReporter(value);
  if (reporter === undefined) {
    process.stderr.write(
      `supaschema: unknown --reporter "${value}" (use ${CHECK_REPORTER_DISPLAY})\n`
    );
    return null;
  }
  return reporter;
}

export function registerReportCommands(program: Command, context: ReportCommandContext): void {
  program
    .command("audit")
    .requiredOption("--from <source>", "source to audit against the support matrix")
    .option("--json", "print the report as JSON")
    .description(
      "Report support-matrix coverage: modeled objects and statements outside the contract."
    )
    .action(async (options: { from: string; json?: boolean }) => {
      const config = await context.loadCliConfig();
      const model = await extractSourceModel(options.from, { config });
      const report = auditModel(model);
      process.stdout.write(
        options.json === true ? `${JSON.stringify(report, null, 2)}\n` : renderAuditReport(report)
      );
      if (!report.supported) {
        process.exitCode = 2;
      }
    });

  program
    .command("scan")
    .option(
      "--contract-usage <dir>",
      "also scan TypeScript generated-contract usage under a directory"
    )
    .option("--from <source>", "source to scan (defaults to the declarative tree)")
    .option("--reporter <reporter>", "text | json | github | sarif", "text")
    .description(
      "Scan the declarative schema and optional generated-contract usage with the rule packs."
    )
    .action(
      async (options: { contractUsage?: string; from?: string; reporter?: CheckReporter }) => {
        const config = await context.loadCliConfig();
        const reporter = resolveReporter(options.reporter);
        if (reporter === null) {
          process.exitCode = 2;
          return;
        }
        const { result, source } = await scanSchemaSafety(config, options.from);
        const contractDiagnostics =
          options.contractUsage === undefined
            ? []
            : await scanGeneratedContractUsage({
                config,
                root: options.contractUsage,
              });
        const combined =
          contractDiagnostics.length === 0
            ? result
            : scanDiagnostics([...result.diagnostics, ...contractDiagnostics]);
        const reportSource =
          options.contractUsage === undefined ? source : `${source} + ${options.contractUsage}`;
        if (reporter === "text") {
          process.stdout.write(
            `Postgres safety score: ${combined.score}/100 (${scoreGrade(combined.score)})\n`
          );
          const body = renderScan(combined, "text", reportSource);
          if (body.length > 0) {
            process.stdout.write(redactSecrets(body));
          }
        } else {
          process.stdout.write(redactSecrets(renderScan(combined, reporter, reportSource)));
        }
        if (combined.errorCount > 0) {
          process.exitCode = 2;
        }
      }
    );

  program
    .command("onboard")
    .option("--from <source>", "schema source to score (defaults to the declarative tree)")
    .description("Detect the current migration system and report onboarding readiness.")
    .action(async (options: { from?: string }) => {
      const config = await context.loadCliConfig();
      const systems = classifyMigrationSystems(process.cwd());
      const { result } = await scanSchemaSafety(config, options.from);
      const readiness = buildReadinessReport(systems, result, scoreGrade(result.score));
      process.stdout.write(`${renderReadiness(readiness)}\n`);
      if (!readiness.ready && result.diagnostics.length > 0) {
        const steps = buildRemediationPlan(result.diagnostics)
          .map((step) => `  ${step.order}. ${step.diagnostic.code}`)
          .join("\n");
        process.stdout.write(`Remediate in order:\n${redactSecrets(steps)}\n`);
      }
    });

  program
    .command("type-contract")
    .option("--from <source>", "previous schema source (default git:HEAD)")
    .option("--to <source>", "new schema source (defaults to the declarative tree)")
    .option("--reporter <reporter>", "text | json | github | sarif", "text")
    .option("--enforce", "fail (exit 2) on breaking changes")
    .description("Gate breaking changes in the generated type contract between two schema sources.")
    .action(
      async (options: {
        enforce?: boolean;
        from?: string;
        reporter?: CheckReporter;
        to?: string;
      }) => {
        const config = await context.loadCliConfig();
        const reporter = resolveReporter(options.reporter);
        if (reporter === null) {
          process.exitCode = 2;
          return;
        }
        const fromSource = options.from ?? "git:HEAD";
        const toSource = options.to ?? defaultTreeSource(config);
        const contract = await evaluateTypeContract({ config, fromSource, toSource });
        const report = renderCheckReport(
          reporter,
          [
            { diagnostics: contract.beforeDiagnostics, file: fromSource },
            { diagnostics: contract.afterDiagnostics, file: toSource },
            { diagnostics: contract.diagnostics, file: toSource },
          ].filter((entry) => entry.diagnostics.length > 0)
        );
        process.stdout.write(redactSecrets(report));
        if (contract.sourceDiagnostics.some((item) => item.severity === "error")) {
          process.exitCode = 2;
          return;
        }
        if (
          !contract.diagnostics.some((item) => item.severity === "error") ||
          options.enforce !== true
        ) {
          return;
        }
        process.exitCode = 2;
      }
    );

  program
    .command("migrations")
    .option("--migrations-dir <dir>", "migration files directory")
    .option(
      "--database-url <url>",
      "target whose applied history to compare (default: SUPASCHEMA_DATABASE_URL, then the local Supabase stack); run once per target to compare local and remote"
    )
    .option("--history-table <schema.table>", "migration history table", undefined)
    .option("--json", "print the report as JSON")
    .option(
      "--prune-stale",
      "delete pending supaschema-generated migrations whose lineage end-state is not reproducible from git:HEAD or the current tree"
    )
    .option("--force", "allow --prune-stale without a target history check")
    .description("Reconcile migration files on disk against a target's applied history.")
    .action(
      async (options: {
        databaseUrl?: string;
        force?: boolean;
        historyTable?: string;
        json?: boolean;
        migrationsDir?: string;
        pruneStale?: boolean;
      }) => {
        const config = await context.loadCliConfig();
        const databaseUrl = await context.resolveCliDatabaseUrl(options.databaseUrl);
        const directory = resolve(process.cwd(), options.migrationsDir ?? config.migrationsDir);
        const statusOptions = {
          currentFingerprints: await currentBaselineFingerprints(config),
          directory,
          ...(databaseUrl === undefined ? {} : { databaseUrl }),
          ...(options.historyTable === undefined ? {} : { historyTable: options.historyTable }),
        };
        let status = await migrationsStatus(statusOptions);
        let prunedStaleBaseline: string[] = [];
        if (options.pruneStale === true) {
          const pruned = await pruneStaleMigrations(status, statusOptions, {
            databaseUrl,
            directory,
            force: options.force === true,
          });
          status = pruned.status;
          prunedStaleBaseline = pruned.prunedStaleBaseline;
        }
        writeMigrationsReport(context, status, prunedStaleBaseline, options.json === true);
      }
    );

  program
    .command("rebaseline")
    .option("--migrations-dir <dir>", "migration files directory")
    .option(
      "--database-url <url>",
      "disposable verification database (default: SUPASCHEMA_DATABASE_URL, then the local Supabase stack)"
    )
    .option("--ensure-environment", "stub Supabase-provisioned surfaces during verification")
    .option("--no-ensure-environment", "disable Supabase environment stubs during verification")
    .option("--ensure-roles", "create missing NOLOGIN roles on the verification server")
    .option(
      "--retain <file...>",
      "retain reviewed operational migration file(s) that the declarative tree cannot own"
    )
    .option("--write", "replace migration history after verification (default: dry run)")
    .option("--json", "print the result as JSON")
    .description(
      "Plan or write one verified baseline from empty: to the configured declarative schema tree."
    )
    .action(
      async (options: {
        databaseUrl?: string;
        ensureEnvironment?: boolean;
        ensureRoles?: boolean;
        json?: boolean;
        migrationsDir?: string;
        retain?: string[];
        write?: boolean;
      }) => {
        const config = await context.loadCliConfig();
        const databaseUrl = resolveVerificationDatabaseUrl(options.databaseUrl, process.cwd());
        const configPath = context.configPath();
        const result = await rebaselineMigrations({
          cliVersion: context.cliVersion,
          config,
          ...(configPath === undefined ? {} : { configPath }),
          ...(databaseUrl === undefined ? {} : { databaseUrl }),
          directory: resolve(process.cwd(), options.migrationsDir ?? config.migrationsDir),
          ...(options.ensureEnvironment === undefined
            ? {}
            : { ensureEnvironment: options.ensureEnvironment }),
          ...(options.ensureRoles === undefined ? {} : { ensureRoles: options.ensureRoles }),
          ...(options.retain === undefined
            ? {}
            : { retainFiles: options.retain.map((file) => resolve(process.cwd(), file)) }),
          write: options.write === true,
        });
        writeRebaselineReport(context, result, options.json === true);
      }
    );

  program
    .command("corpus")
    .option("--corpus-dir <dir>", "corpus directory", "corpus/supabase-style")
    .option(
      "--database-url <url>",
      "admin URL for disposable corpus databases (default: SUPASCHEMA_DATABASE_URL, then the local Supabase stack)"
    )
    .option("--json", "print the report as JSON")
    .description(
      "Run the corpus oracle: replay the dirty-real migrations corpus, diff against its tree, apply the reconciliation twice, and require reconvergence to zero."
    )
    .action(async (options: { corpusDir: string; databaseUrl?: string; json?: boolean }) => {
      const databaseUrl = await context.resolveCliDatabaseUrl(options.databaseUrl);
      if (databaseUrl === undefined) {
        process.stdout.write("corpus: skipped (no database URL resolved)\n");
        return;
      }
      const { diagnostics, report } = await runCorpus({
        corpusDir: resolve(process.cwd(), options.corpusDir),
        databaseUrl,
      });
      context.printDiagnostics(diagnostics);
      process.stdout.write(
        options.json === true ? `${JSON.stringify(report, null, 2)}\n` : renderCorpusReport(report)
      );
      if (hasErrors(diagnostics)) {
        process.exitCode = 2;
      }
    });

  program
    .command("stage")
    .option("--migrations-dir <dir>", "migration files directory")
    .option("--dry-run", "print generated migration files that would be ensured staged")
    .description("Git-stage changed supaschema-generated migration SQL files.")
    .action((options: StageCommandOptions) => runStageCommand(options, context));

  program
    .command("apply")
    .option("--from <source>", "before-state source override for safety and verification")
    .option("--to <source>", "target schema source override for safety and verification")
    .option("--migrations-dir <dir>", "migration files directory")
    .option("--database-url <url>", "explicit target whose applied history gates direct apply")
    .option("--target <name>", "operator override for one configured sync target")
    .option("--runner <runner>", "operator override: direct | supabase-cli")
    .option("--ensure-environment", "stub Supabase-provisioned surfaces during verify")
    .option("--no-ensure-environment", "disable Supabase environment stubs during verify")
    .description(
      "Apply pending generated migrations through the configured runner without generating a new diff."
    )
    .action((options: ApplyCommandOptions) => runApplyCommand(options, context));

  program
    .command("sync")
    .option("--from <source>", "before-state source override for generation and verification")
    .option("--to <source>", "target schema source override for generation and verification")
    .option("--migrations-dir <dir>", "migration files directory")
    .option("--database-url <url>", "explicit target whose applied history gates the sync")
    .option("--target <name>", "operator override for one configured sync target")
    .option("--runner <runner>", "operator override: direct | supabase-cli")
    .option("--ensure-environment", "stub Supabase-provisioned surfaces during verify")
    .option("--no-ensure-environment", "disable Supabase environment stubs during verify")
    .option("--no-diff", "skip schema diff generation")
    .description(
      "Run the full sync pipeline: schema diff, replay-safety check, generated contracts, schema closure staging, source safety gates, selected runner apply/deploy, and final reconciliation."
    )
    .action((options: SyncCommandOptions) => runSyncCommand(options, context));
}

interface MigrationsCommandStatus {
  diagnostics: Diagnostic[];
  report: MigrationsStatusReport;
}

async function pruneStaleMigrations(
  status: MigrationsCommandStatus,
  statusOptions: MigrationsStatusOptions,
  options: { databaseUrl: string | undefined; directory: string; force: boolean }
): Promise<{ prunedStaleBaseline: string[]; status: MigrationsCommandStatus }> {
  if (options.databaseUrl === undefined && !options.force) {
    status.diagnostics.push(
      diagnostic(
        "SUPA_MIGRATIONS_NO_TARGET",
        "error",
        "cannot prune stale generated migrations without a target history check",
        {
          hint: "Pass --database-url or set SUPASCHEMA_DATABASE_URL so supaschema can confirm the stale files are pending, not applied.",
        }
      )
    );
  }
  if (hasErrors(status.diagnostics)) {
    return { prunedStaleBaseline: [], status };
  }
  const prunedStaleBaseline = [...status.report.staleBaseline];
  for (const file of prunedStaleBaseline) {
    await rm(join(options.directory, file));
  }
  return {
    prunedStaleBaseline,
    status: prunedStaleBaseline.length > 0 ? await migrationsStatus(statusOptions) : status,
  };
}

function writeMigrationsReport(
  context: ReportCommandContext,
  status: MigrationsCommandStatus,
  prunedStaleBaseline: string[],
  json: boolean
): void {
  context.printDiagnostics(status.diagnostics);
  if (json) {
    process.stdout.write(`${JSON.stringify({ ...status.report, prunedStaleBaseline }, null, 2)}\n`);
  } else {
    process.stdout.write(renderMigrationsStatus(status.report));
    for (const file of prunedStaleBaseline) {
      process.stdout.write(`  pruned-stale: ${file}\n`);
    }
  }
  if (hasErrors(status.diagnostics)) {
    process.exitCode = 2;
  }
}

function writeRebaselineReport(
  context: ReportCommandContext,
  result: RebaselineResult,
  json: boolean
): void {
  context.printDiagnostics(result.diagnostics);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (result.alreadyConverged) {
    process.stdout.write(`rebaseline: already converged on ${result.baselinePath}\n`);
  } else {
    writeRebaselineText(result);
  }
  if (hasErrors(result.diagnostics)) {
    process.exitCode = 2;
  }
}

function writeRebaselineText(result: RebaselineResult): void {
  process.stdout.write(
    `rebaseline: ${result.written ? "write" : "dry run"}: ${result.operationCount} operation(s), ${result.removedFiles.length} old migration file(s), ${result.discardedOperations.length} discarded operation(s), ${result.retainedFiles.length} retained file(s)\n`
  );
  for (const file of result.retainedFiles) {
    process.stdout.write(`  retain: ${file}\n`);
  }
  for (const file of result.removedFiles.slice(0, 20)) {
    process.stdout.write(`  remove: ${file}\n`);
  }
  if (result.removedFiles.length > 20) {
    process.stdout.write(`  remove: +${result.removedFiles.length - 20} more\n`);
  }
  for (const operation of result.discardedOperations.slice(0, 20)) {
    process.stdout.write(
      `  discard: ${operation.kind} ${operation.file}${operation.key === undefined ? "" : ` (${operation.key})`}\n`
    );
  }
  if (result.discardedOperations.length > 20) {
    process.stdout.write(`  discard: +${result.discardedOperations.length - 20} more\n`);
  }
  for (const file of result.generatedMigrationPaths) {
    process.stdout.write(`  baseline: ${file}\n`);
  }
  for (const file of result.writtenContractPaths) {
    process.stdout.write(`  types: wrote ${file}\n`);
  }
  for (const file of result.staged) {
    process.stdout.write(`  staged: ${file}\n`);
  }
}

function resolveSyncRunner(value: string | undefined): "direct" | "supabase-cli" | undefined {
  if (value === undefined) {
    return;
  }
  return value === "direct" || value === "supabase-cli" ? value : undefined;
}

async function runSyncCommand(
  options: SyncCommandOptions,
  context: ReportCommandContext
): Promise<void> {
  const config = await context.loadCliConfig();
  const pendingInstall = await pendingInstallPathConfirmationDiagnostic(
    process.cwd(),
    context.configPath()
  );
  if (pendingInstall) {
    process.stderr.write(formatConfigValidationDiagnostics([pendingInstall]));
    process.exitCode = 2;
    return;
  }
  const runner = resolveSyncRunner(options.runner);
  if (runner === undefined && options.runner !== undefined) {
    process.stderr.write(
      `supaschema: unknown --runner "${options.runner}" (use direct|supabase-cli)\n`
    );
    process.exitCode = 2;
    return;
  }
  const envName = context.globalEnvName();
  const databaseUrl =
    options.databaseUrl !== undefined || envName !== undefined
      ? await context.resolveCliDatabaseUrl(options.databaseUrl)
      : undefined;
  const configPath = context.configPath();
  const result = await syncMigrations({
    cliVersion: context.cliVersion,
    config,
    ...(configPath === undefined ? {} : { configPath }),
    directory: resolve(process.cwd(), options.migrationsDir ?? config.migrationsDir),
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(envName === undefined ? {} : { envName }),
    ...(options.ensureEnvironment === undefined
      ? {}
      : { ensureEnvironment: options.ensureEnvironment }),
    ...(options.from === undefined ? {} : { from: options.from }),
    pipeline: true,
    ...(runner === undefined ? {} : { runner }),
    skipDiff: options.diff === false,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.to === undefined ? {} : { to: options.to }),
  });
  context.printDiagnostics(result.diagnostics);
  process.stdout.write(result.report);
  if (hasErrors(result.diagnostics)) {
    process.exitCode = 2;
  }
}

async function runApplyCommand(
  options: ApplyCommandOptions,
  context: ReportCommandContext
): Promise<void> {
  const config = await context.loadCliConfig();
  const pendingInstall = await pendingInstallPathConfirmationDiagnostic(
    process.cwd(),
    context.configPath()
  );
  if (pendingInstall) {
    process.stderr.write(formatConfigValidationDiagnostics([pendingInstall]));
    process.exitCode = 2;
    return;
  }
  const runner = resolveSyncRunner(options.runner);
  if (runner === undefined && options.runner !== undefined) {
    process.stderr.write(
      `supaschema: unknown --runner "${options.runner}" (use direct|supabase-cli)\n`
    );
    process.exitCode = 2;
    return;
  }
  const envName = context.globalEnvName();
  const databaseUrl =
    options.databaseUrl !== undefined || envName !== undefined
      ? await context.resolveCliDatabaseUrl(options.databaseUrl)
      : undefined;
  const configPath = context.configPath();
  const result = await syncMigrations({
    cliVersion: context.cliVersion,
    config,
    ...(configPath === undefined ? {} : { configPath }),
    directory: resolve(process.cwd(), options.migrationsDir ?? config.migrationsDir),
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    ...(envName === undefined ? {} : { envName }),
    ...(options.ensureEnvironment === undefined
      ? {}
      : { ensureEnvironment: options.ensureEnvironment }),
    ...(options.from === undefined ? {} : { from: options.from }),
    operation: "apply",
    pipeline: true,
    ...(runner === undefined ? {} : { runner }),
    skipDiff: true,
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(options.to === undefined ? {} : { to: options.to }),
  });
  context.printDiagnostics(result.diagnostics);
  process.stdout.write(result.report);
  if (hasErrors(result.diagnostics)) {
    process.exitCode = 2;
  }
}

async function runStageCommand(
  options: StageCommandOptions,
  context: ReportCommandContext
): Promise<void> {
  const config = await context.loadCliConfig();
  const directory = resolve(process.cwd(), options.migrationsDir ?? config.migrationsDir);
  const result = await stageGeneratedMigrations({
    directory,
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
    requireGit: true,
  });
  if (result.staged.length === 0 && result.wouldStage.length === 0) {
    process.stdout.write("no generated migration files to stage\n");
    return;
  }
  if (options.dryRun === true) {
    for (const file of result.wouldStage) {
      process.stdout.write(`would ensure staged: ${file}\n`);
    }
    return;
  }
  for (const file of result.staged) {
    process.stdout.write(`staged: ${file}\n`);
  }
}
