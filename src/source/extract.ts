import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { extractCatalogModel } from "../catalog/extract.js";
import { parseRuntimeSource } from "../config/contract.js";
import { resolveConfig } from "../config/schema.js";
import { expandEnvReference } from "../database/url.js";
import { diagnostic, isDiagnostic } from "../diagnostics/diagnostics.js";
import { fingerprintObjects, MODEL_FORMAT_VERSION } from "../hash.js";
import { commentTarget, objectSchema } from "../sql/dependents.js";
import { extractObjectsFromSql } from "../sql/extract.js";
import { isManagedSchemaOverlay } from "../sql/ownership.js";
import type {
  Diagnostic,
  ExtractOptions,
  SchemaModel,
  SchemaObject,
  SupaschemaConfig,
} from "../types.js";
import { declaredRoutineRevokes, normalizeSourceObjects } from "./normalize.js";
import { reconstructModelFromMigrations } from "./replay.js";

const execFileAsync = promisify(execFile);

interface SqlFile {
  path: string;
  sql: string;
}

export async function extractSourceModel(
  source: string,
  options: ExtractOptions = {}
): Promise<SchemaModel> {
  const cwd = options.cwd ?? process.cwd();
  const config = resolveConfig(options.config);
  const model = applyConfigModelFilters(
    await extractRawModel(source, cwd, config, options.excludeMigrationFiles),
    config
  );
  return isBootstrapInventorySource(source)
    ? await filterBootstrapInventoryObjects(model, cwd, config)
    : model;
}

function isBootstrapInventorySource(source: string): boolean {
  const kind = parseRuntimeSource(source)?.kind;
  return kind === "database" || kind === "migrations";
}

async function extractRawModel(
  source: string,
  cwd: string,
  config: SupaschemaConfig,
  excludeMigrationFiles: readonly string[] | undefined
): Promise<SchemaModel> {
  const parsed = parseRuntimeSource(source);
  if (!parsed) {
    throw new Error(`unsupported source "${source}"`);
  }
  if (parsed.kind === "catalog") {
    return readCatalogSource(parsed.payload, cwd, source);
  }
  if (parsed.kind === "database") {
    const databaseUrl = expandEnvReference(parsed.payload);
    return extractCatalogModel({
      config,
      databaseUrl,
      normalize: config.normalize === "deparse",
      source,
    });
  }
  if (parsed.kind === "dump") {
    if (parsed.payload === "-") {
      const sql = await readAllStdin();
      return modelFromSqlFiles([{ path: "<stdin>", sql }], source, config);
    }
    const path = resolve(cwd, parsed.payload);
    const sql = await readFile(path, "utf8");
    return modelFromSqlFiles([{ path, sql }], source, config);
  }
  if (parsed.kind === "dir") {
    const root = resolve(cwd, parsed.payload);
    const files = await readSqlFiles(root);
    return modelFromSqlFiles(files, source, config);
  }
  if (parsed.kind === "migrations") {
    const directory = resolve(cwd, parsed.payload);
    return reconstructModelFromMigrations(directory, source, config, {
      cwd,
      ...(excludeMigrationFiles === undefined ? {} : { excludeFiles: excludeMigrationFiles }),
    });
  }
  if (parsed.kind === "empty") {
    return modelFromSqlFiles([], source, config);
  }
  if (parsed.kind === "git") {
    const ref = parsed.payload || "HEAD";
    const files =
      ref === "INDEX"
        ? await readGitIndexSqlFiles(cwd, config.schemaPaths)
        : await readGitSqlFiles(ref, cwd, config.schemaPaths);
    return modelFromSqlFiles(files, source, config);
  }
  throw new Error(`unsupported source "${source}"`);
}

const schemaScopedDiagnosticCodes = new Set([
  "SUPA_EXTRACT_SIDE_EFFECT_UNSUPPORTED",
  "SUPA_EXTRACT_UNSUPPORTED",
  "SUPA_NORMALIZE_FIDELITY",
  "SUPA_NORMALIZE_UNSUPPORTED",
  "SUPA_SUPABASE_MANAGED_SCHEMA",
]);

export function parseSchemaFilter(schemaFilter: string | undefined): Set<string> {
  if (!schemaFilter) {
    return new Set();
  }
  return new Set(
    schemaFilter
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function filterModelBySchemas(model: SchemaModel, schemas: Set<string>): SchemaModel {
  if (schemas.size === 0) {
    return model;
  }

  const filtered = withObjects(
    model,
    model.objects.filter((object) => schemas.has(objectSchema(object)))
  );
  return {
    ...filtered,
    ...(model.declaredRoutineRevokes === undefined
      ? {}
      : {
          declaredRoutineRevokes: model.declaredRoutineRevokes.filter((object) =>
            schemas.has(objectSchema(object))
          ),
        }),
    diagnostics: filtered.diagnostics.filter(
      (item) =>
        !schemaScopedDiagnosticCodes.has(item.code) ||
        diagnosticSchemas(item).some((schema) => schemas.has(schema))
    ),
  };
}

function applyConfigModelFilters(model: SchemaModel, config: SupaschemaConfig): SchemaModel {
  let current = model;
  if (config.schemas.include.length > 0) {
    current = filterModelBySchemas(current, new Set(config.schemas.include));
  }
  if (config.schemas.exclude.length > 0) {
    const excluded = new Set(config.schemas.exclude);
    current = withObjects(
      current,
      current.objects.filter(
        (object) => !excluded.has(objectSchema(object)) || isManagedSchemaOverlay(object, config)
      )
    );
    current = {
      ...current,
      diagnostics: current.diagnostics.filter((item) => {
        if (item.code === "SUPA_SUPABASE_MANAGED_SCHEMA" && item.severity === "error") {
          return true;
        }
        if (!schemaScopedDiagnosticCodes.has(item.code)) {
          return true;
        }
        const itemSchemas = diagnosticSchemas(item);
        return itemSchemas.length === 0 || itemSchemas.some((schema) => !excluded.has(schema));
      }),
    };
  }
  if (config.excludedGrantRoles.length > 0) {
    const roles = new Set(config.excludedGrantRoles);
    current = withObjects(
      current,
      current.objects.filter((object) => !isExcludedGrant(object, roles))
    );
  }
  return pruneFilteredCommentTargets(current);
}

function withObjects(model: SchemaModel, objects: SchemaObject[]): SchemaModel {
  if (objects.length === model.objects.length) {
    return model;
  }
  return { ...model, fingerprint: fingerprintObjects(objects), objects };
}

function pruneFilteredCommentTargets(model: SchemaModel): SchemaModel {
  const objectKeys = new Set(model.objects.map((object) => object.key));
  return withObjects(
    model,
    model.objects.filter((object) => {
      const targetKey = filteredExtensionCommentTargetKey(object);
      return targetKey === undefined || objectKeys.has(targetKey);
    })
  );
}

async function filterBootstrapInventoryObjects(
  model: SchemaModel,
  cwd: string,
  config: SupaschemaConfig
): Promise<SchemaModel> {
  const bootstrap = await bootstrapInventoryModel(cwd, config);
  if (bootstrap.objects.length === 0) {
    return model;
  }
  const bootstrapKeys = new Set(bootstrap.objects.map((object) => object.key));
  const bootstrapExtensionSchemas = new Set(
    model.objects
      .filter((object) => object.ref.kind === "extension" && bootstrapKeys.has(object.key))
      .map((object) => object.metadata.schema)
      .filter((schema): schema is string => typeof schema === "string")
  );
  const bootstrapCommentTargetKeys = new Set(
    bootstrap.objects
      .map(bootstrapCommentTargetKey)
      .filter((key): key is string => key !== undefined)
  );
  return withObjects(
    model,
    model.objects.filter((object) => {
      if (bootstrapKeys.has(object.key)) {
        return false;
      }
      if (object.ref.kind === "schema" && bootstrapExtensionSchemas.has(object.ref.name)) {
        return false;
      }
      const targetKey = schemaOrExtensionCommentTargetKey(object);
      return targetKey === undefined || !bootstrapCommentTargetKeys.has(targetKey);
    })
  );
}

async function bootstrapInventoryModel(
  cwd: string,
  config: SupaschemaConfig
): Promise<SchemaModel> {
  const files: SqlFile[] = [];
  for (const schemaPath of config.schemaPaths) {
    const root = resolve(cwd, schemaPath, "_bootstrap");
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.isFile() && extname(entry.name) === ".sql") {
        const path = join(root, entry.name);
        files.push({ path: relative(cwd, path), sql: await readFile(path, "utf8") });
      }
    }
  }
  return modelFromSqlFiles(files, "bootstrap:inventory", config);
}

function bootstrapCommentTargetKey(object: SchemaObject): string | undefined {
  const ref = object.ref;
  if (ref.kind === "schema") {
    return `schema:${ref.name}`;
  }
  if (ref.kind === "extension") {
    return `extension:${ref.name}`;
  }
}

function schemaOrExtensionCommentTargetKey(object: SchemaObject): string | undefined {
  const target = commentTarget(object);
  if (object.ref.kind !== "comment" || !target) {
    return;
  }
  if (target.kind === "extension" || target.kind === "schema") {
    return `${target.kind}:${target.name}`;
  }
}

function filteredExtensionCommentTargetKey(object: SchemaObject): string | undefined {
  const target = commentTarget(object);
  return target?.kind === "extension" ? `extension:${target.name}` : undefined;
}

function diagnosticSchemas(item: Diagnostic): string[] {
  const schemas = new Set(item.schemas ?? []);
  if (item.ref?.kind === "schema") {
    schemas.add(item.ref.name);
  }
  if (item.ref?.schema !== undefined) {
    schemas.add(item.ref.schema);
  }
  return [...schemas];
}

function isExcludedGrant(object: SchemaObject, roles: Set<string>): boolean {
  if (object.ref.kind !== "grant" && object.ref.kind !== "default-privilege") {
    return false;
  }
  const grantee = typeof object.metadata.grantee === "string" ? object.metadata.grantee : undefined;
  const forRole = typeof object.metadata.forRole === "string" ? object.metadata.forRole : undefined;
  return (
    (grantee !== undefined && roles.has(grantee)) || (forRole !== undefined && roles.has(forRole))
  );
}
async function readCatalogSource(path: string, cwd: string, source: string): Promise<SchemaModel> {
  const fullPath = resolve(cwd, path);
  const raw = objectValue(JSON.parse(await readFile(fullPath, "utf8")));
  const rawObjects = property(raw, "objects");
  const rawDiagnostics = property(raw, "diagnostics");
  const formatVersion = property(raw, "formatVersion");
  const fingerprint = property(raw, "fingerprint");
  const objects = Array.isArray(rawObjects) ? rawObjects.filter(isSchemaObject) : [];
  const diagnostics = Array.isArray(rawDiagnostics) ? rawDiagnostics.filter(isDiagnostic) : [];
  if (formatVersion !== MODEL_FORMAT_VERSION) {
    diagnostics.push(
      diagnostic(
        "SUPA_CATALOG_SNAPSHOT_VERSION",
        "warning",
        `catalog snapshot model version ${formatVersion ?? "unknown"} does not match this supaschema model version ${MODEL_FORMAT_VERSION}`,
        {
          file: fullPath,
          hint: "Object hashes are version-specific; regenerate the snapshot with `supaschema inspect` to avoid false replacements.",
        }
      )
    );
  }
  const model: SchemaModel = {
    diagnostics,
    fingerprint: typeof fingerprint === "string" ? fingerprint : fingerprintObjects(objects),
    objects,
    source,
  };
  if (typeof formatVersion === "number") {
    model.formatVersion = formatVersion;
  }
  return model;
}

function isSchemaObject(value: unknown): value is SchemaObject {
  const record = objectValue(value);
  return (
    Array.isArray(property(record, "dependencies")) &&
    typeof property(record, "hash") === "string" &&
    typeof property(record, "key") === "string" &&
    typeof property(record, "metadata") === "object" &&
    typeof property(record, "normalizedSql") === "string" &&
    typeof property(record, "ordinal") === "number" &&
    typeof property(record, "ref") === "object" &&
    typeof property(record, "sql") === "string"
  );
}

function objectValue(value: unknown): object {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function property(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

async function modelFromSqlFiles(
  files: SqlFile[],
  source: string,
  config: SupaschemaConfig
): Promise<SchemaModel> {
  const extractedObjects: SchemaObject[] = [];
  const diagnostics: Diagnostic[] = [];
  let ordinal = 0;
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    const extracted = await extractObjectsFromSql(file.sql, {
      config,
      existingObjects: extractedObjects,
      file: file.path,
      startOrdinal: ordinal,
    });
    extractedObjects.push(...extracted.objects);
    diagnostics.push(...extracted.diagnostics);
    ordinal = extracted.nextOrdinal;
  }
  const routineRevokes = declaredRoutineRevokes(extractedObjects);
  const objects = await normalizeSourceObjects(extractedObjects, diagnostics, {
    normalize: config.normalize === "deparse",
  });
  diagnostics.push(...duplicateKeyDiagnostics(objects));
  return {
    declaredRoutineRevokes: routineRevokes,
    diagnostics,
    fingerprint: fingerprintObjects(objects),
    formatVersion: MODEL_FORMAT_VERSION,
    objects: objects.sort((left, right) => left.ordinal - right.ordinal),
    source,
  };
}
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readSqlFiles(root: string): Promise<SqlFile[]> {
  const files: SqlFile[] = [];
  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "_bootstrap") {
          continue;
        }
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && extname(entry.name) === ".sql") {
        files.push({
          path: relative(root, fullPath),
          sql: await readFile(fullPath, "utf8"),
        });
      }
    }
  }
  await walk(root);
  return files;
}
async function readGitSqlFiles(
  ref: string,
  cwd: string,
  schemaPaths: string[]
): Promise<SqlFile[]> {
  const files: SqlFile[] = [];
  for (const schemaPath of schemaPaths) {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-tree", "-r", "--name-only", ref, "--", schemaPath],
      { maxBuffer: 1024 * 1024 * 10 }
    );
    const paths = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith(".sql") && !isBootstrapInventoryPath(line));
    for (const path of paths) {
      const { stdout: sql } = await execFileAsync("git", ["-C", cwd, "show", `${ref}:${path}`], {
        maxBuffer: 1024 * 1024 * 20,
      });
      files.push({ path, sql });
    }
  }
  return files;
}

async function readGitIndexSqlFiles(cwd: string, schemaPaths: string[]): Promise<SqlFile[]> {
  const files: SqlFile[] = [];
  for (const schemaPath of schemaPaths) {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--", schemaPath],
      { maxBuffer: 1024 * 1024 * 10 }
    );
    const paths = stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith(".sql") && !isBootstrapInventoryPath(line));
    for (const path of paths) {
      const { stdout: sql } = await execFileAsync("git", ["-C", cwd, "show", `:${path}`], {
        maxBuffer: 1024 * 1024 * 20,
      });
      files.push({ path, sql });
    }
  }
  return files;
}

function isBootstrapInventoryPath(path: string): boolean {
  return pathSegments(path).includes("_bootstrap");
}

function pathSegments(path: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (const char of path) {
    if (char === "/" || char === "\\") {
      if (current.length > 0) {
        segments.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

function duplicateKeyDiagnostics(objects: SchemaObject[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const seen = new Map<string, SchemaObject>();
  for (const object of objects) {
    const previous = seen.get(object.key);
    if (previous) {
      diagnostics.push(
        diagnostic("SUPA_EXTRACT_DUPLICATE_OBJECT", "error", "duplicate object identity", {
          file: object.file,
          hint: `first seen in ${previous.file ?? "unknown source"}`,
          ref: object.ref,
        })
      );
      continue;
    }
    seen.set(object.key, object);
  }
  return diagnostics;
}
