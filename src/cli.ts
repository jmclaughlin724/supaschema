#!/usr/bin/env node
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command } from "commander";
import { emitBuildWarnings, readBuildInfo } from "./build-info.js";
import { selfCheckCatalog } from "./catalog/selfcheck.js";
import { type CheckCommandOptions, runCheckCommand } from "./cli/check-selection.js";
import { registerDiffCommands } from "./cli/diff.js";
import { registerReportCommands } from "./cli/reports.js";
import {
  configureCliShared,
  currentConfigPath,
  loadCliConfig,
  printDiagnostics,
  readPackageVersion,
  readStdin,
  redactJson,
  redactRawError,
  resolveCliDatabaseUrl,
  resolveCliDatabaseUrlInfo,
  resolveCliVerificationDatabaseUrl,
  runHookFailOpen,
} from "./cli/runtime.js";
import { registerToolCommands } from "./cli/tools.js";
import { formatConfigValidationDiagnostics, validateConfig } from "./config/validate.js";
import { type DiagnosticDefinition, diagnosticDefinitions } from "./diagnostics/catalog.js";
import { hasErrors } from "./diagnostics/diagnostics.js";
import {
  type AgentHookOutput,
  generatedArtifactEditHookOutput,
  generatedArtifactGuardFailureOutput,
  schemaWriteHookOutput,
} from "./hooks/output.js";
import { latestMigrationFile } from "./migrations/files.js";
import { filterModel } from "./pipeline/diff.js";
import { extractSourceModel } from "./source/extract.js";
import {
  defaultTreeSource,
  resolveMigrationsDir,
  resolveSourceDefaults,
} from "./source/resolve.js";
import { verifyMigration } from "./verify/migration.js";

interface GlobalOptions {
  config?: string;
  env?: string;
  quiet?: boolean;
}
interface InitOptions {
  dryRun?: boolean;
  json?: boolean;
  repair?: boolean;
}
interface InspectCommandOptions {
  from?: string;
  schema?: string;
}
interface VerifyCommandOptions {
  databaseUrl?: string;
  ensureEnvironment?: boolean;
  ensureRoles?: boolean;
  from?: string;
  keepDatabases?: boolean;
  migration?: string;
  migrationsDir?: string;
  to?: string;
}

const program = new Command();
configureCliShared(program);
const cliVersion = await readPackageVersion();
await emitBuildWarnings(await readBuildInfo(cliVersion));
program
  .name("supaschema")
  .description("Generate deterministic, replay-safe PostgreSQL/Supabase migrations from SQL trees.")
  .option("--config <path>", "explicit JSON config file path")
  .option("--env <name>", "named environment from config.environments for the database URL")
  .option("--quiet", "suppress diagnostic output on stderr")
  .version(cliVersion)
  .addHelpText(
    "after",
    `
Exit codes:
  0  success
  1  runtime error (bad arguments, unreadable input, crash)
  2  diagnostics contained at least one error
  3  --fail-on-diff was set and the plan contained operations
`
  );

program
  .command("init")
  .description(
    "Scaffold supaschema config, schema/migration directories, and active AI-agent enforcement files in the current directory."
  )
  .option("--dry-run", "print the scaffold/repair plan without writing files")
  .option("--json", "print the init result as redacted JSON")
  .option("--repair", "rewrite supaschema.config.json from the canonical contract when needed")
  .action(async (options: InitOptions) => {
    const packageRoot = fileURLToPath(new URL("../", import.meta.url));
    const packageVersion = await readPackageVersion();
    const { scaffoldProject } = await import(
      pathToFileURL(join(packageRoot, "bin", "scaffold.mjs")).href
    );
    const result = await scaffoldProject({
      dryRun: options.dryRun === true,
      interactive: true,
      packageRoot,
      packageVersion,
      repair: options.repair === true,
      targetDir: process.cwd(),
    });
    if (options.json === true) {
      process.stdout.write(`${JSON.stringify(redactJson(result), null, 2)}\n`);
      return;
    }
    const { agentBundle, installed, pathConfirmationNeeded, preserved = [], skipped } = result;
    const verb = options.dryRun === true ? "would install" : "installed";
    const details = [
      preserved.length > 0 ? `preserved existing ${preserved.join(", ")}` : undefined,
      skipped.length > 0 ? `skipped ${skipped.join(", ")}` : undefined,
    ].filter((detail): detail is string => detail !== undefined);
    const suffix = details.length > 0 ? `; ${details.join("; ")}` : "";
    let status = options.dryRun === true ? "would make no changes" : "no changes";
    if (installed.length > 0) {
      status = `${verb} ${installed.join(", ")}`;
    }
    process.stdout.write(`supaschema: ${status}${suffix}\n`);
    if (agentBundle?.installed === false) {
      process.stdout.write(
        `supaschema: agent bundle installation incomplete; resolve skipped files, then review ${agentBundle?.instructions ?? "node_modules/supaschema/agent-bundle/INSTALL.md"}\n`
      );
    }
    if (pathConfirmationNeeded) {
      process.stdout.write(
        "supaschema: confirm detected schema/migration paths in .supaschema/install.json before the first diff\n"
      );
    }
  });

const configCommand = program.command("config").description("Inspect and validate configuration.");

configCommand
  .command("validate")
  .option("--json", "print validation diagnostics as JSON")
  .description("Validate supaschema.config.json paths, sources, and credential references.")
  .action(async (options: { json?: boolean }) => {
    const config = await loadCliConfig();
    const configPath = currentConfigPath();
    const diagnostics = await validateConfig(config, process.cwd(), {
      ...(configPath === undefined ? {} : { configPath }),
      includeInstallState: true,
    });
    const hasErrorDiagnostics = diagnostics.some((item) => item.severity === "error");
    if (options.json === true) {
      process.stdout.write(
        `${JSON.stringify({ diagnostics, ok: !hasErrorDiagnostics }, null, 2)}\n`
      );
    } else if (diagnostics.length === 0) {
      process.stdout.write("config ok\n");
    } else {
      process.stdout.write(formatConfigValidationDiagnostics(diagnostics));
    }
    if (hasErrorDiagnostics) {
      process.exitCode = 2;
    }
  });

program
  .command("inspect")
  .option("--from <source>", "source to inspect (default: the config schema tree)")
  .option("--schema <names>", "comma-separated schema filter")
  .description("Extract and print a deterministic schema model.")
  .action(async (options: InspectCommandOptions) => {
    const config = await loadCliConfig();
    const source = options.from ?? defaultTreeSource(config);
    const model = filterModel(await extractSourceModel(source, { config }), options.schema);
    printDiagnostics(model.diagnostics);
    process.stdout.write(`${JSON.stringify(redactJson(model), null, 2)}\n`);
    if (hasErrors(model.diagnostics)) {
      process.exitCode = 2;
    }
  });

registerDiffCommands(program, {
  cliVersion,
  configPath: currentConfigPath,
  loadCliConfig,
  printDiagnostics,
  resolveCliDatabaseUrl,
});
registerReportCommands(program, {
  cliVersion,
  configPath: currentConfigPath,
  globalEnvName: () => program.opts<GlobalOptions>().env,
  loadCliConfig,
  printDiagnostics,
  resolveCliDatabaseUrl,
});
registerToolCommands(program, {
  configPath: currentConfigPath,
  loadCliConfig,
  printDiagnostics,
  resolveCliDatabaseUrl,
  resolveCliDatabaseUrlInfo,
});

program
  .command("check")
  .argument("[migrations...]", "migration files (default: every .sql in config.migrationsDir)")
  .option("--allow-empty", "exit 0 when config.migrationsDir contains no .sql files")
  .option("--changed", "check changed migration files in the working tree and index")
  .option("--staged", "check staged migration files")
  .option("--base <ref>", "check migration files changed against a base ref")
  .option("--since <ref>", "check migration files changed since a ref")
  .option("--reporter <name>", "text | github | sarif | json", "text")
  .description(
    "Validate replay-safety and parser diagnostics for migration files (shell globs expand to a directory gate; `-` reads stdin; zero args checks the migrations directory)."
  )
  .action((migrationArgs: string[], options: CheckCommandOptions) =>
    runCheckCommand(migrationArgs, options)
  );

program
  .command("verify")
  .option("--from <source>", "source model before the change (default: config.sources.from)")
  .option("--to <target>", "source model after the change (default: config.schemaPaths)")
  .option(
    "--migration <file>",
    "migration SQL file to apply twice (default: newest .sql in config.migrationsDir)"
  )
  .option("--migrations-dir <dir>", "migrations directory (default: config.migrationsDir)")
  .option(
    "--database-url <url>",
    "PostgreSQL URL whose role can create temporary databases (default: SUPASCHEMA_DATABASE_URL, then the local Supabase stack from supabase/config.toml)"
  )
  .option(
    "--ensure-roles",
    "create missing NOLOGIN roles referenced by grants/policies on the verification server (cluster-level; never dropped)"
  )
  .option(
    "--ensure-environment",
    "stub Supabase-provisioned surfaces (auth helpers, cron schema) in the temporary databases"
  )
  .option(
    "--no-ensure-environment",
    "disable the Supabase environment stub when another command or config enables it"
  )
  .option(
    "--keep-databases",
    "keep the temporary databases after the run and print their names (debugging failed verifies)"
  )
  .description("Apply from + migration twice and compare against target in temporary databases.")
  .action(async (options: VerifyCommandOptions) => {
    const config = await loadCliConfig();
    const databaseUrl = await resolveCliVerificationDatabaseUrl(options.databaseUrl);
    if (!databaseUrl) {
      process.stderr.write(
        "no database URL: pass --database-url, --env, set SUPASCHEMA_DATABASE_URL, or run inside a project with supabase/config.toml\n"
      );
      process.exitCode = 1;
      return;
    }
    const migrationsDir = resolveMigrationsDir(options.migrationsDir, config);
    const migrationPath =
      options.migration ?? (await latestMigrationFile(resolve(process.cwd(), migrationsDir)));
    if (migrationPath === undefined) {
      process.stderr.write(`no migration to verify: ${migrationsDir} has no .sql files\n`);
      process.exitCode = 1;
      return;
    }
    const sources = await resolveSourceDefaults(options, config, () =>
      resolveCliVerificationDatabaseUrl(options.databaseUrl)
    );
    if (sources.notice !== undefined) {
      process.stderr.write(sources.notice);
    }
    if (options.migration === undefined) {
      process.stderr.write(`defaults: --migration ${migrationPath} (flags override)\n`);
    }
    const diagnostics = await verifyMigration({
      config,
      databaseUrl,
      ensureRoles: options.ensureRoles === true,
      ...(options.ensureEnvironment === undefined
        ? {}
        : { ensureEnvironment: options.ensureEnvironment }),
      ...(options.keepDatabases === true ? { keepDatabases: true } : {}),
      from: sources.from,
      migrationPath,
      to: sources.to,
    });
    printDiagnostics(diagnostics);
    if (hasErrors(diagnostics)) {
      process.exitCode = 2;
      return;
    }
    process.stdout.write("ok\n");
  });

program
  .command("selfcheck")
  .option(
    "--database-url <url>",
    "PostgreSQL URL to extract (default: SUPASCHEMA_DATABASE_URL, then the local Supabase stack from supabase/config.toml)"
  )
  .description("Re-extract the live catalog's rendered SQL and report identity normalization gaps.")
  .action(async (options: { databaseUrl?: string }) => {
    const config = await loadCliConfig();
    const databaseUrl = await resolveCliDatabaseUrl(options.databaseUrl);
    if (!databaseUrl) {
      process.stderr.write(
        "no database URL: pass --database-url, --env, set SUPASCHEMA_DATABASE_URL, or run inside a project with supabase/config.toml\n"
      );
      process.exitCode = 1;
      return;
    }
    const result = await selfCheckCatalog({ config, databaseUrl });
    printDiagnostics(result.diagnostics);
    process.stdout.write(
      `selfcheck: ${result.checkedObjects} objects, ${result.mismatches} parity mismatches\n`
    );
    if (hasErrors(result.diagnostics)) {
      process.exitCode = 2;
    }
  });

program
  .command("explain")
  .argument("<code>", "diagnostic code, e.g. SUPA_PLAN_DESTRUCTIVE_HINT_REQUIRED")
  .option("--json", "print the structured remediation definition as JSON")
  .description("Explain a supaschema diagnostic code.")
  .action((code: string, options: { json?: boolean }) => {
    const normalizedCode = code.toUpperCase();
    const definition = diagnosticDefinitions[normalizedCode];
    if (!definition) {
      process.stderr.write(`unknown diagnostic code "${code}"\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      options.json === true
        ? `${JSON.stringify({ code: normalizedCode, ...definition }, null, 2)}\n`
        : renderDiagnosticDefinition(normalizedCode, definition)
    );
  });

function renderDiagnosticDefinition(code: string, definition: DiagnosticDefinition): string {
  const lines = [`${code}: ${definition.summary}`];
  if (definition.cause) {
    lines.push(`Cause: ${definition.cause}`);
  }
  appendNumberedSection(lines, "Recovery", definition.recoverySteps);
  appendBulletedSection(lines, "Commands", definition.commands);
  appendBulletedSection(lines, "Expected evidence", definition.expectedEvidence);
  appendBulletedSection(lines, "Do not", definition.forbiddenActions);
  if (definition.docs) {
    lines.push(`Docs: ${definition.docs}`);
  }
  return `${lines.join("\n")}\n`;
}

function appendNumberedSection(
  lines: string[],
  heading: string,
  values: readonly string[] | undefined
): void {
  if (!values || values.length === 0) {
    return;
  }
  lines.push(`${heading}:`);
  for (const [index, value] of values.entries()) {
    lines.push(`  ${index + 1}. ${value}`);
  }
}

function appendBulletedSection(
  lines: string[],
  heading: string,
  values: readonly string[] | undefined
): void {
  if (!values || values.length === 0) {
    return;
  }
  lines.push(`${heading}:`);
  for (const value of values) {
    lines.push(`  - ${value}`);
  }
}

const hookCommand = program
  .command("hook", { hidden: true })
  .description("Internal agent hook entrypoints.");

hookCommand
  .command("schema-write", { hidden: true })
  .description("Run the internal schema-write hook workflow.")
  .action(() =>
    runHookFailOpen(async () => {
      const payload = JSON.parse(await readStdin());
      const output = await schemaWriteHookOutput(payload);
      if (output !== undefined) {
        process.stdout.write(`${JSON.stringify(output)}\n`);
      }
    })
  );

hookCommand
  .command("generated-artifact-edit", { hidden: true })
  .option("--runtime <runtime>", "claude | codex", "claude")
  .description("Run the internal generated-artifact edit guard.")
  .action(async (options: { runtime?: string }) => {
    const runtime = options.runtime === "codex" ? "codex" : "claude";
    let output: AgentHookOutput | undefined;
    try {
      const payload = JSON.parse(await readStdin());
      output = generatedArtifactEditHookOutput(payload, runtime);
    } catch {
      output = generatedArtifactGuardFailureOutput(runtime);
    }
    if (runtime === "codex") {
      process.stdout.write(`${JSON.stringify(output ?? {})}\n`);
      return;
    }
    if (output?.reason !== undefined) {
      process.stderr.write(`${output.reason}\n`);
      process.exitCode = 2;
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${redactRawError(error)}\n`);
  process.exitCode = 1;
});
