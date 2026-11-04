import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { Client } from "pg";
import { extractCatalogModel } from "../catalog/extract.js";
import { checkMigrationSql } from "../check/migration.js";
import { resolveConfig, type SupaschemaConfig } from "../config/schema.js";
import {
  applyMigrationSql,
  applySql as applyPerStatementSql,
  applySqlStatements,
  assertLocalDatabaseUrl,
  createDatabaseWithRetry,
  databaseUrlWithDatabase,
  tempDatabaseName,
} from "../database/admin.js";
import { diagnostic, formatDiagnostics, hasErrors } from "../diagnostics/diagnostics.js";
import { fingerprintObjects } from "../hash.js";
import { groupMigrationUnits, type MigrationUnit } from "../migrations/runners.js";
import { planSchemaDiff } from "../planner/schema.js";
import { renderMigration } from "../render/migration.js";
import { extractSourceModel } from "../source/extract.js";
import {
  type AstStatement,
  asRecord,
  astStatements,
  readString,
  roleSpecName,
} from "../sql/ast.js";
import { extractObjectsFromSql } from "../sql/extract.js";
import { quoteIdent } from "../sql/identifiers.js";
import { parseSqlAst } from "../sql/parser.js";
import type {
  Diagnostic,
  ExtractOptions,
  MigrationOperation,
  ObjectRef,
  SchemaModel,
  VerifyMigrationOptions,
} from "../types.js";
import {
  preflightCapability,
  supabaseAuthEnvironmentStubSql,
  supabaseCronEnvironmentStubSql,
  supabaseEnvironmentStubSql,
  supabaseVaultEnvironmentStubSql,
  unreplayableVerificationObjects,
} from "./environment.js";

const preDropOperationPrefix = "pre-drop:";

export function verifyMigration(options: VerifyMigrationOptions): Promise<Diagnostic[]> {
  return verifyMigrationChain({ ...options, migrationPaths: [options.migrationPath] });
}

export interface VerifyMigrationChainOptions extends Omit<VerifyMigrationOptions, "migrationPath"> {
  ignoredObjects?: ObjectRef[];
  migrationPaths: string[];
}

export async function verifyMigrationChain(
  options: VerifyMigrationChainOptions
): Promise<Diagnostic[]> {
  const config = resolveConfig(options.config);
  const diagnostics: Diagnostic[] = [];
  const databaseDiagnostic = verifyDatabaseUrlDiagnostic(options.databaseUrl);
  if (databaseDiagnostic !== undefined) {
    return [databaseDiagnostic];
  }
  const migrations = await migrationSqlByFile(options.migrationPaths);
  const extractOptions = verificationExtractOptions(options);
  const ignoredObjects = [...(options.ignoredObjects ?? []), ...unreplayableVerificationObjects];
  for (const sql of migrations.values()) {
    diagnostics.push(...(await checkMigrationSql(sql, extractOptions)));
  }
  if (hasErrors(diagnostics)) {
    return diagnostics;
  }
  const from = filterIgnoredObjects(
    await extractSourceModel(options.from, extractOptions),
    ignoredObjects
  );
  const to = filterIgnoredObjects(
    await extractSourceModel(options.to, extractOptions),
    ignoredObjects
  );
  diagnostics.push(...from.diagnostics, ...to.diagnostics);
  if (hasErrors(diagnostics)) {
    return diagnostics;
  }
  const admin = new Client({ connectionString: options.databaseUrl });
  const migrationDb = tempDatabaseName("migration");
  const targetDb = tempDatabaseName("target");
  const created: string[] = [];
  const environmentEnsured = options.ensureEnvironment ?? false;
  try {
    if (await connectVerificationAdmin(admin, diagnostics)) {
      return diagnostics;
    }
    await createVerificationDatabases(admin, [migrationDb, targetDb], created);
    const migrationUrl = databaseUrlWithDatabase(options.databaseUrl, migrationDb);
    const targetUrl = databaseUrlWithDatabase(options.databaseUrl, targetDb);
    if (options.ensureRoles === true) {
      await ensureReferencedRoles(admin, [from, to]);
    }
    await applyBootstrapInventory(config, options.cwd, migrationUrl, targetUrl);
    await ensureVerificationEnvironment(environmentEnsured, migrationUrl, targetUrl);
    await applyVerificationScenario(migrationUrl, targetUrl, from, to, migrations, config);
    await compareVerificationCatalogs(
      migrationUrl,
      targetUrl,
      from,
      to,
      config,
      options.cwd,
      environmentEnsured,
      diagnostics
    );
  } catch (error) {
    diagnostics.push(...verifyFailureDiagnostics(error, environmentEnsured, config));
  } finally {
    await cleanupTempDatabases(admin, created, options.keepDatabases === true, diagnostics);
    await admin.end().catch(() => undefined);
  }
  return diagnostics;
}

function filterIgnoredObjects(model: SchemaModel, ignoredObjects: ObjectRef[]): SchemaModel {
  if (ignoredObjects.length === 0) {
    return model;
  }
  const withoutIgnoredObjects = model.objects.filter(
    (object) => !ignoredObjects.some((ignored) => objectMatchesIgnoredRef(object, ignored))
  );
  const ignoredSchemas = new Set(
    ignoredObjects
      .map((object) => object.schema)
      .filter((schema): schema is string => schema !== undefined)
  );
  const objects = withoutIgnoredObjects.filter(
    (object) =>
      !(
        object.ref.kind === "schema" &&
        ignoredSchemas.has(object.ref.name) &&
        !withoutIgnoredObjects.some(
          (candidate) => candidate !== object && objectSchemaName(candidate.ref) === object.ref.name
        )
      )
  );
  if (objects.length === model.objects.length) {
    return model;
  }
  return { ...model, fingerprint: fingerprintObjects(objects), objects };
}

function objectMatchesIgnoredRef(
  object: { dependencies: string[]; ref: ObjectRef },
  ignored: ObjectRef
): boolean {
  if (sameObjectRef(object.ref, ignored)) {
    return true;
  }
  if (ignored.kind !== "table") {
    return false;
  }
  return (
    (object.ref.schema === ignored.schema && object.ref.table === ignored.name) ||
    (ignored.schema !== undefined &&
      object.dependencies.includes(`${ignored.schema}.${ignored.name}`))
  );
}

function sameObjectRef(left: ObjectRef, right: ObjectRef): boolean {
  return (
    left.kind === right.kind &&
    left.name === right.name &&
    left.schema === right.schema &&
    left.signature === right.signature &&
    left.table === right.table
  );
}

function objectSchemaName(ref: ObjectRef): string {
  if (ref.kind === "schema") {
    return ref.name;
  }
  return ref.schema ?? "public";
}

async function migrationSqlByFile(migrationPaths: string[]): Promise<Map<string, string>> {
  const migrations = new Map<string, string>();
  for (const migrationPath of migrationPaths) {
    migrations.set(basename(migrationPath), await readFile(migrationPath, "utf8"));
  }
  return migrations;
}

function verifyDatabaseUrlDiagnostic(databaseUrl: string): Diagnostic | undefined {
  try {
    assertLocalDatabaseUrl(databaseUrl, "SUPASCHEMA_VERIFY_ALLOW_REMOTE");
  } catch (error) {
    return diagnostic("SUPA_VERIFY_FAILED", "error", errorMessage(error), {
      hint: "verify creates and drops databases; non-local hosts require SUPASCHEMA_VERIFY_ALLOW_REMOTE=1.",
    });
  }
}

function verificationExtractOptions(
  options: Pick<VerifyMigrationOptions, "config" | "cwd">
): ExtractOptions {
  const extractOptions: ExtractOptions = {};
  if (options.config !== undefined) {
    extractOptions.config = options.config;
  }
  if (options.cwd !== undefined) {
    extractOptions.cwd = options.cwd;
  }
  return extractOptions;
}

async function connectVerificationAdmin(
  admin: Client,
  diagnostics: Diagnostic[]
): Promise<boolean> {
  await admin.connect();
  const capability = await preflightCapability(admin);
  if (capability === undefined) {
    return false;
  }
  diagnostics.push(capability);
  return true;
}

async function createVerificationDatabases(
  admin: Client,
  databaseNames: string[],
  created: string[]
): Promise<void> {
  for (const databaseName of databaseNames) {
    await createDatabaseWithRetry(admin, `CREATE DATABASE ${quoteIdent(databaseName)}`);
    created.push(databaseName);
  }
}

async function ensureVerificationEnvironment(
  environmentEnsured: boolean,
  migrationUrl: string,
  targetUrl: string
): Promise<void> {
  if (!environmentEnsured) {
    return;
  }

  await Promise.all([
    ensureOneVerificationEnvironment(migrationUrl),
    ensureOneVerificationEnvironment(targetUrl),
  ]);
}

async function ensureOneVerificationEnvironment(databaseUrl: string): Promise<void> {
  await applySql(databaseUrl, supabaseAuthEnvironmentStubSql, "per-statement");
  if (!(await databaseHasExtension(databaseUrl, "supabase_vault"))) {
    await applySql(databaseUrl, supabaseVaultEnvironmentStubSql, "per-statement");
  }
  await applySql(databaseUrl, supabaseCronEnvironmentStubSql, "per-statement");
}

async function databaseHasExtension(databaseUrl: string, name: string): Promise<boolean> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const result = await client.query("SELECT 1 FROM pg_catalog.pg_extension WHERE extname = $1", [
      name,
    ]);
    return result.rowCount !== 0;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function applyBootstrapInventory(
  config: SupaschemaConfig,
  cwd: string | undefined,
  migrationUrl: string,
  targetUrl: string
): Promise<void> {
  const sql = await bootstrapInventorySql(config, cwd);
  if (sql.trim().length === 0) {
    return;
  }
  await applySql(migrationUrl, sql, "per-statement");
  await applySql(targetUrl, sql, "per-statement");
}

export async function bootstrapInventorySql(
  config: SupaschemaConfig,
  cwd: string | undefined,
  includeExtensions = false
): Promise<string> {
  const root = cwd ?? process.cwd();
  const chunks: string[] = [];
  for (const schemaPath of config.schemaPaths) {
    const bootstrapDir = resolve(root, schemaPath, "_bootstrap");
    const entries = await readdir(bootstrapDir, { withFileTypes: true }).catch(() => []);
    const files = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    for (const file of files) {
      const path = join(bootstrapDir, file);
      chunks.push(
        await filterUnreplayableVerificationSql(
          await readFile(path, "utf8"),
          path,
          includeExtensions
        )
      );
    }
  }
  return chunks.join("\n");
}

async function filterUnreplayableVerificationSql(
  sql: string,
  file: string,
  includeExtensions: boolean
): Promise<string> {
  const parsed = await parseSqlAst(sql, file);
  if (parsed.ast === undefined || hasErrors(parsed.diagnostics)) {
    throw new Error(
      `failed to parse bootstrap inventory ${file}\n${formatDiagnostics(parsed.diagnostics)}`
    );
  }
  return astStatements(parsed.ast, sql)
    .filter(
      (statement) => includeExtensions || !isUnreplayableVerificationExtensionStatement(statement)
    )
    .map((statement) => `${statement.text};`)
    .join("\n");
}

function isUnreplayableVerificationExtensionStatement(statement: AstStatement): boolean {
  if (statement.tag !== "CreateExtensionStmt") {
    return false;
  }
  const node = asRecord(statement.node.CreateExtensionStmt);
  const name = readString(node?.extname);
  return unreplayableVerificationObjects.some(
    (object) => object.kind === "extension" && object.name === name
  );
}

async function applyVerificationScenario(
  migrationUrl: string,
  targetUrl: string,
  from: SchemaModel,
  to: SchemaModel,
  migrations: Map<string, string>,
  config: SupaschemaConfig
): Promise<void> {
  await applyModel(migrationUrl, from);
  const replayableMigrations = new Map<string, string>();
  for (const [file, sql] of migrations) {
    replayableMigrations.set(file, await filterUnreplayableVerificationSql(sql, file, false));
  }
  await applyMigrationChain(migrationUrl, replayableMigrations, config.transactionMode);
  await applyMigrationChain(migrationUrl, replayableMigrations, config.transactionMode);
  await applyModel(targetUrl, to);
}

async function applyMigrationChain(
  databaseUrl: string,
  migrations: Map<string, string>,
  mode: "per-migration" | "per-statement"
): Promise<void> {
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    for (const unit of verificationMigrationUnits(migrations, mode)) {
      if (unit.transactional) {
        await client.query("BEGIN");
        try {
          await applyMigrationUnitSql(client, migrations, unit.files);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => undefined);
          throw error;
        }
      } else {
        await applyMigrationUnitSql(client, migrations, unit.files);
      }
    }
  } finally {
    await client.end().catch(() => undefined);
  }
}

function verificationMigrationUnits(
  migrations: Map<string, string>,
  mode: "per-migration" | "per-statement"
): MigrationUnit[] {
  const units = groupMigrationUnits([...migrations.keys()], mode);
  if (units.length > 0 || migrations.size === 0) {
    return units;
  }
  return [
    {
      files: [...migrations.keys()].sort((left, right) => left.localeCompare(right)),
      transactional: mode === "per-migration",
      version: "verification",
    },
  ];
}

async function applyMigrationUnitSql(
  client: Pick<Client, "query">,
  migrations: Map<string, string>,
  files: string[]
): Promise<void> {
  for (const file of files) {
    const sql = migrations.get(file);
    if (sql === undefined) {
      throw new Error(`missing migration SQL for ${file}`);
    }
    await applySqlStatements(client, sql);
  }
}

async function compareVerificationCatalogs(
  migrationUrl: string,
  targetUrl: string,
  from: SchemaModel,
  to: SchemaModel,
  config: SupaschemaConfig,
  cwd: string | undefined,
  environmentEnsured: boolean,
  diagnostics: Diagnostic[]
): Promise<void> {
  const afterMigration = await extractCatalogModel({
    config,
    databaseUrl: migrationUrl,
    source: "verify:migration",
  });
  const expectedTarget = await extractCatalogModel({
    config,
    databaseUrl: targetUrl,
    source: "verify:target",
  });
  const reconvergenceSource = await extractSourceModel(`database:${migrationUrl}`, {
    config,
    ...(cwd === undefined ? {} : { cwd }),
  });
  diagnostics.push(
    ...afterMigration.diagnostics,
    ...expectedTarget.diagnostics,
    ...reconvergenceSource.diagnostics
  );
  const reconvergence = await reconvergenceDiagnostic(
    from,
    reconvergenceSource,
    to,
    config,
    environmentEnsured
  );
  if (reconvergence?.severity === "error" || reconvergence === undefined) {
    pushFingerprintMismatchDiagnostic(diagnostics, afterMigration, expectedTarget);
  }
  if (reconvergence !== undefined) {
    diagnostics.push(reconvergence);
  }
}

function pushFingerprintMismatchDiagnostic(
  diagnostics: Diagnostic[],
  afterMigration: SchemaModel,
  expectedTarget: SchemaModel
): void {
  if (afterMigration.fingerprint === expectedTarget.fingerprint) {
    return;
  }
  diagnostics.push(
    diagnostic(
      "SUPA_VERIFY_FINGERPRINT_MISMATCH",
      "error",
      "migration result catalog fingerprint does not match target catalog fingerprint",
      {
        hint: fingerprintMismatchHint(afterMigration, expectedTarget),
      }
    )
  );
}

async function reconvergenceDiagnostic(
  beforeMigration: SchemaModel,
  afterMigration: SchemaModel,
  to: SchemaModel,
  config: SupaschemaConfig,
  environmentEnsured: boolean
): Promise<Diagnostic | undefined> {
  const permissiveConfig = {
    ...config,
    hints: { ...config.hints, destructive: ["*"], renames: [] },
  };
  const baseline = planSchemaDiff(beforeMigration, to, { config: permissiveConfig });
  const reconvergence = planSchemaDiff(afterMigration, to, { config: permissiveConfig });
  const stubKeys = environmentEnsured ? await stubObjectKeys(config) : new Set<string>();
  return reconvergenceResidualDiagnostic(baseline.operations, reconvergence.operations, stubKeys);
}

function verifyFailureDiagnostics(
  error: unknown,
  environmentEnsured: boolean,
  config: SupaschemaConfig
): Diagnostic[] {
  const message = errorMessage(error);
  const out: Diagnostic[] = [
    diagnostic("SUPA_VERIFY_FAILED", "error", message, {
      hint: "Use a disposable PostgreSQL database URL whose role can CREATE DATABASE and DROP DATABASE.",
    }),
  ];
  const stubbedSchema = environmentEnsured
    ? managedSchemaReferenced(message, config.managedSchemas)
    : undefined;
  if (stubbedSchema !== undefined) {
    out.push(
      diagnostic(
        "SUPA_VERIFY_STUB_REFERENCE",
        "warning",
        `verify failed while referencing the "${stubbedSchema}" managed schema, which --ensure-environment provisions only as a minimal stub`,
        {
          hint: `--ensure-environment stubs auth.users, auth.sessions, the auth.uid/role/jwt/email helpers, Vault secrets, and cron tables; other ${stubbedSchema} objects are absent. This may be a stub limitation rather than a real migration defect; confirm by applying the migration to a disposable database that provisions the managed surface. Use --no-ensure-environment only when the verification server itself provisions the managed surface in new databases.`,
        }
      )
    );
  }
  return out;
}

async function cleanupTempDatabases(
  admin: Client,
  created: string[],
  keepDatabases: boolean,
  diagnostics: Diagnostic[]
): Promise<void> {
  if (keepDatabases && created.length > 0) {
    diagnostics.push(
      diagnostic(
        "SUPA_VERIFY_CLEANUP_FAILED",
        "warning",
        `kept temporary databases for inspection: ${created.join(", ")}`,
        { hint: "Drop them manually when done (--keep-databases was set)." }
      )
    );
    return;
  }
  for (const databaseName of created.reverse()) {
    try {
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [databaseName]
      );
      await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(databaseName)} WITH (FORCE)`);
    } catch (cleanupError) {
      diagnostics.push(
        diagnostic("SUPA_VERIFY_CLEANUP_FAILED", "warning", errorMessage(cleanupError), {
          hint: `Temporary database ${databaseName} may need manual removal.`,
        })
      );
    }
  }
}

async function collectReferencedRoles(models: SchemaModel[]): Promise<string[]> {
  const roles = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0 && value !== "PUBLIC") {
      roles.add(value);
    }
  };
  for (const model of models) {
    for (const object of model.objects) {
      await collectRolesFromObject(object, add);
    }
  }
  return [...roles].sort((left, right) => left.localeCompare(right));
}

async function collectRolesFromObject(
  object: SchemaModel["objects"][number],
  add: (value: unknown) => void
): Promise<void> {
  if (object.ref.kind === "grant" || object.ref.kind === "default-privilege") {
    add(object.metadata.grantee);
    add(object.metadata.forRole);
    return;
  }
  if (object.ref.kind !== "policy") {
    return;
  }
  const parsed = await parseSqlAst(object.sql);
  if (parsed.ast === undefined) {
    return;
  }
  for (const statement of astStatements(parsed.ast, object.sql)) {
    const policy = asRecord(statement.node.CreatePolicyStmt);
    for (const role of Array.isArray(policy?.roles) ? policy.roles : []) {
      add(roleSpecName(role));
    }
  }
}

async function ensureReferencedRoles(admin: Client, models: SchemaModel[]): Promise<void> {
  for (const role of await collectReferencedRoles(models)) {
    await admin.query(
      `DO $supaschema$\nBEGIN\n  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = ${quoteRoleLiteral(role)}) THEN\n    CREATE ROLE ${quoteIdent(role)} NOLOGIN;\n  END IF;\nEND\n$supaschema$`
    );
  }
}

async function stubObjectKeys(config: SupaschemaConfig): Promise<Set<string>> {
  const stubKeys = new Set<string>();
  const stubs = await extractObjectsFromSql(supabaseEnvironmentStubSql, { config });
  for (const object of stubs.objects) {
    stubKeys.add(object.key);
  }
  return stubKeys;
}

function reconvergenceResidualDiagnostic(
  baselineOperations: MigrationOperation[],
  operations: MigrationOperation[],
  stubKeys: Set<string>
): Diagnostic | undefined {
  const residualOperations = operations.filter((operation) => !stubKeys.has(operation.key));
  if (residualOperations.length === 0) {
    return;
  }
  const baselineKeys = operationIdentitySet(baselineOperations, stubKeys);
  const residualKeys = operationIdentitySet(residualOperations, stubKeys);
  const newResidualKeys = [...residualKeys].filter((key) => !baselineKeys.has(key));
  const reducedPreExistingDrift =
    baselineKeys.size > residualKeys.size && newResidualKeys.length === 0;
  const residual = residualOperations
    .slice(0, 6)
    .map((operation) => `${operation.kind} ${operation.key}`)
    .join(", ");
  if (reducedPreExistingDrift) {
    return diagnostic(
      "SUPA_VERIFY_PREEXISTING_DRIFT",
      "warning",
      `migration converged ${baselineKeys.size - residualKeys.size} drift object(s); ${residualKeys.size} pre-existing drift object(s) remain`,
      {
        hint: `residual: ${residual}. Run target reconciliation separately; this migration introduced no new drift and did not leave any changed object unresolved.`,
      }
    );
  }
  return diagnostic(
    "SUPA_VERIFY_RECONVERGENCE",
    "error",
    `${residualOperations.length} operation(s) remain between the migrated catalog and the target model; the diff would never converge to empty`,
    {
      hint: `residual: ${residual}.${newResidualKeys.length === 0 ? "" : ` New residual identities: ${newResidualKeys.slice(0, 6).join(", ")}.`} The target model declares state the catalog cannot reproduce (or vice versa); fix the model or the engine's lane parity.`,
    }
  );
}

function operationIdentitySet(
  operations: readonly MigrationOperation[],
  ignoredKeys: ReadonlySet<string>
): Set<string> {
  return new Set(
    operations
      .filter((operation) => !ignoredKeys.has(operation.key))
      .map((operation) =>
        operation.key.startsWith(preDropOperationPrefix)
          ? operation.key.slice(preDropOperationPrefix.length)
          : operation.key
      )
  );
}

function quoteRoleLiteral(role: string): string {
  return `'${role.replaceAll("'", "''")}'`;
}

const mismatchSampleLimit = 12;

function fingerprintMismatchHint(migration: SchemaModel, target: SchemaModel): string {
  const appliedHashes = new Map(migration.objects.map((object) => [object.key, object.hash]));
  const targetHashes = new Map(target.objects.map((object) => [object.key, object.hash]));
  const missing: string[] = [];
  const changed: string[] = [];
  for (const [key, hash] of targetHashes) {
    const applied = appliedHashes.get(key);
    if (applied === undefined) {
      missing.push(key);
    } else if (applied !== hash) {
      changed.push(key);
    }
  }
  const unexpected = [...appliedHashes.keys()].filter((key) => !targetHashes.has(key));
  const parts: string[] = [];
  const mismatchGroups: [string, string[]][] = [
    ["missing from migration result", missing],
    ["not present in target", unexpected],
    ["definition differs", changed],
  ];
  for (const [label, keys] of mismatchGroups) {
    if (keys.length === 0) {
      continue;
    }
    const sorted = [...keys].sort((left, right) => left.localeCompare(right));
    const sample = sorted.slice(0, mismatchSampleLimit).join(", ");
    const suffix =
      sorted.length > mismatchSampleLimit ? ` (+${sorted.length - mismatchSampleLimit} more)` : "";
    parts.push(`${label}: ${sample}${suffix}`);
  }
  return parts.join("; ") || `migration=${migration.fingerprint} target=${target.fingerprint}`;
}

async function applyModel(databaseUrl: string, model: SchemaModel): Promise<void> {
  const plan = planSchemaDiff(emptySchemaModel(model.source), model);
  const sql = renderMigration(plan, { includeHeader: false });
  try {
    await applySql(databaseUrl, sql, "per-statement");
  } catch (error) {
    const planErrors = plan.diagnostics.filter((item) => item.severity === "error");
    if (planErrors.length > 0) {
      throw new Error(
        `${errorMessage(error)}; synthesizing ${model.source} also reported blocking plan diagnostics:\n${formatDiagnostics(planErrors)}`,
        { cause: error }
      );
    }
    throw error;
  }
}

function emptySchemaModel(source: string): SchemaModel {
  return {
    diagnostics: [],
    fingerprint: "empty",
    objects: [],
    source: `${source}:empty`,
  };
}

async function applySql(
  databaseUrl: string,
  sql: string,
  mode: "per-migration" | "per-statement"
): Promise<void> {
  if (mode === "per-migration") {
    await applyMigrationSql(databaseUrl, sql);
    return;
  }
  await applyPerStatementSql(databaseUrl, sql);
}
function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function managedSchemaReferenced(message: string, managedSchemas: string[]): string | undefined {
  const lower = message.toLowerCase();
  for (const schema of managedSchemas) {
    if (lower.includes(`${schema.toLowerCase()}.`)) {
      return schema;
    }
  }
}
