import { Pool } from "pg";
import { resolveConfig, type SupaschemaConfig } from "../config/schema.js";
import { diagnostic } from "../diagnostics/diagnostics.js";
import { suppressDefaultAclImpliedGrants } from "../grants/default-acl.js";
import { fingerprintObjects, MODEL_FORMAT_VERSION } from "../hash.js";
import { finalizeObjects } from "../sql/facts.js";
import { formatQualifiedName, quoteIdent, stripOuterDoubleQuotes } from "../sql/identifiers.js";
import { overlayRetainedSchemas, retainCatalogOverlayObjects } from "../sql/ownership.js";
import { policyMetadataFromSql } from "../sql/policies.js";
import { rlsStateSql } from "../sql/rls.js";
import { makeObject } from "../sql/statements.js";
import type { Diagnostic, SchemaModel, SchemaObject } from "../types.js";
import { collectComments } from "./comments.js";
import { collectForeignObjects } from "./foreign.js";
import {
  collectDefaultPrivileges,
  collectGrants,
  collectRoutineExecuteGrantees,
} from "./grants.js";
import {
  type CatalogQuery,
  catalogSchemaFilter,
  managedSchemaFilterFor,
  notExtensionMember,
} from "./query.js";
import { collectSequences } from "./sequences.js";
import { collectTables } from "./tables.js";
import { collectTypes } from "./types.js";

export interface ExtractCatalogOptions {
  config?: Partial<SupaschemaConfig>;
  databaseUrl: string;
  normalize?: boolean;
  source?: string;
}

type CatalogPool = Pick<Pool, "query"> & Pick<CatalogQuery, "schemaFilter">;

function openCatalogPool(
  databaseUrl: string,
  config: SupaschemaConfig,
  overlaySchemas: readonly string[]
): Pool & CatalogPool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 4,
    options: "-c search_path=",
  });
  pool.on("error", () => undefined);
  return Object.assign(pool, {
    schemaFilter: managedSchemaFilterFor({
      schemas: {
        include:
          config.schemas.include.length === 0
            ? config.schemas.include
            : [...new Set([...config.schemas.include, ...overlaySchemas])],
        exclude: config.schemas.exclude.filter((schema) => !overlaySchemas.includes(schema)),
      },
    }),
  });
}

export async function extractRoutineExecuteGrantees(
  options: Pick<ExtractCatalogOptions, "config" | "databaseUrl">
): Promise<Map<string, Set<string>> | Diagnostic> {
  const config = resolveConfig(options.config);
  const pool = openCatalogPool(options.databaseUrl, config, overlayRetainedSchemas(config));
  try {
    return await collectRoutineExecuteGrantees(pool);
  } catch (error) {
    return catalogExtractFailedDiagnostic(error);
  } finally {
    await pool.end();
  }
}

export async function extractCatalogModel(options: ExtractCatalogOptions): Promise<SchemaModel> {
  const config = resolveConfig(options.config);
  const overlaySchemas = overlayRetainedSchemas(config);
  const catalogPool = openCatalogPool(options.databaseUrl, config, overlaySchemas);
  try {
    const sections = await Promise.all([
      collectSection((objects) => appendSchemas(catalogPool, objects, 0)),
      collectSection((objects) => appendExtensions(catalogPool, objects, 0)),
      collectTypes(catalogPool),
      collectSequences(catalogPool),
      collectTables(catalogPool),
      collectForeignObjects(catalogPool),
      collectSection((objects) => appendFunctions(catalogPool, objects, 0)),
      collectSection((objects) => appendViews(catalogPool, objects, 0)),
      collectSection((objects) => appendIndexes(catalogPool, objects, 0)),
      collectSection((objects) => appendTriggers(catalogPool, objects, 0)),
      collectSection((objects) => appendPoliciesAndRls(catalogPool, objects, 0)),
      collectGrants(catalogPool),
      collectDefaultPrivileges(catalogPool),
      collectComments(catalogPool),
    ]);
    const objects: SchemaObject[] = retainCatalogOverlayObjects(
      suppressDefaultAclImpliedGrants(sections.flat()),
      overlaySchemas,
      config
    );
    objects.forEach((object, index) => {
      object.ordinal = index;
    });
    const diagnostics = await finalizeObjects(objects, {
      normalize: options.normalize === true,
    });
    return {
      diagnostics,
      fingerprint: fingerprintObjects(objects),
      formatVersion: MODEL_FORMAT_VERSION,
      objects,
      source: options.source ?? "database",
    };
  } catch (error) {
    return {
      diagnostics: [catalogExtractFailedDiagnostic(error)],
      fingerprint: fingerprintObjects([]),
      objects: [],
      source: options.source ?? "database",
    };
  } finally {
    await catalogPool.end();
  }
}

function catalogExtractFailedDiagnostic(error: unknown): Diagnostic {
  return diagnostic("SUPA_CATALOG_EXTRACT_FAILED", "error", errorMessage(error), {
    hint: "Confirm the database URL is reachable and the role can read pg_catalog.",
  });
}

async function collectSection(
  section: (objects: SchemaObject[]) => Promise<number>
): Promise<SchemaObject[]> {
  const objects: SchemaObject[] = [];
  await section(objects);
  return objects;
}

async function appendSchemas(
  pool: CatalogPool,
  objects: SchemaObject[],
  ordinal: number
): Promise<number> {
  let nextOrdinal = ordinal;

  const result = await pool.query<Record<string, unknown>>(`
    select n.nspname as name
    from pg_namespace n
    where ${catalogSchemaFilter(pool)}
      and n.nspname <> 'public'
    order by nspname
  `);
  for (const row of result.rows) {
    const name = stringValue(row.name);
    objects.push(
      makeObject({ kind: "schema", name }, `CREATE SCHEMA ${quoteIdent(name)}`, nextOrdinal)
    );
    nextOrdinal += 1;
  }
  return nextOrdinal;
}

async function appendExtensions(
  pool: CatalogPool,
  objects: SchemaObject[],
  ordinal: number
): Promise<number> {
  let nextOrdinal = ordinal;

  const result = await pool.query<Record<string, unknown>>(`
    select e.extname as name, n.nspname as schema
    from pg_extension e
    join pg_namespace n on n.oid = e.extnamespace
    where e.extname <> 'plpgsql'
      and ${catalogSchemaFilter(pool)}
    order by e.extname
  `);
  for (const row of result.rows) {
    const name = stringValue(row.name);
    const schema = stringValue(row.schema);
    objects.push(
      makeObject(
        { kind: "extension", name },
        `CREATE EXTENSION ${quoteIdent(name)} WITH SCHEMA ${quoteIdent(schema)}`,
        nextOrdinal,
        undefined,
        { schema }
      )
    );
    nextOrdinal += 1;
  }
  return nextOrdinal;
}

async function appendFunctions(
  pool: CatalogPool,
  objects: SchemaObject[],
  ordinal: number
): Promise<number> {
  let nextOrdinal = ordinal;
  const result = await pool.query<Record<string, unknown>>(`
    select
      n.nspname as schema,
      p.proname as name,
      p.prokind as kind,
      oidvectortypes(p.proargtypes) as args,
      p.provariadic <> 0 as variadic,
      pg_get_functiondef(p.oid) as definition
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where ${catalogSchemaFilter(pool)}
      and ${notExtensionMember("p", "pg_proc")}
      and p.prokind in ('f', 'p')
    order by n.nspname, p.proname, oidvectortypes(p.proargtypes)
  `);
  for (const row of result.rows) {
    const kind = stringValue(row.kind) === "p" ? "procedure" : "function";
    objects.push(
      makeObject(
        {
          kind,
          name: stringValue(row.name),
          schema: stringValue(row.schema),

          signature: functionSignature(stringValue(row.args), row.variadic === true),
        },
        stringValue(row.definition),
        nextOrdinal
      )
    );
    nextOrdinal += 1;
  }
  return nextOrdinal;
}

function functionSignature(args: string, variadic: boolean): string {
  if (!variadic || args.length === 0) {
    return args;
  }
  const types = args.split(", ");
  types[types.length - 1] = `VARIADIC ${types.at(-1)}`;
  return types.join(", ");
}

async function appendViews(
  pool: CatalogPool,
  objects: SchemaObject[],
  ordinal: number
): Promise<number> {
  let nextOrdinal = ordinal;
  const result = await pool.query<Record<string, unknown>>(`
    select
      n.nspname as schema,
      c.relname as name,
      c.relkind as relkind,
      c.relispopulated as relispopulated,
      c.reloptions as reloptions,
      pg_get_viewdef(c.oid, true) as definition
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('v', 'm')
      and ${catalogSchemaFilter(pool)}
      and ${notExtensionMember("c", "pg_class")}
    order by n.nspname, c.relname
  `);
  for (const row of result.rows) {
    const kind = stringValue(row.relkind) === "m" ? "materialized-view" : "view";
    const prefix = kind === "materialized-view" ? "CREATE MATERIALIZED VIEW" : "CREATE VIEW";
    const schema = stringValue(row.schema);
    const name = stringValue(row.name);
    const withClause =
      kind === "view" && reloptionEnabled(row.reloptions, "security_invoker")
        ? " WITH (security_invoker = true)"
        : "";
    const dataClause =
      kind === "materialized-view" && row.relispopulated === false ? " WITH NO DATA" : "";
    const definition = trimCatalogDefinition(stringValue(row.definition));
    objects.push(
      makeObject(
        { kind, name, schema },
        `${prefix} ${formatQualifiedName(schema, name)}${withClause} AS\n${definition}${dataClause}`,
        nextOrdinal,
        undefined,
        kind === "materialized-view"
          ? { withNoData: row.relispopulated === false ? true : undefined }
          : undefined
      )
    );
    nextOrdinal += 1;
  }
  return nextOrdinal;
}

function trimCatalogDefinition(definition: string): string {
  const trimmed = definition.trimEnd();
  return trimmed.endsWith(";") ? trimmed.slice(0, -1).trimEnd() : trimmed;
}

function reloptionEnabled(reloptions: unknown, option: string): boolean {
  if (!Array.isArray(reloptions)) {
    return false;
  }
  for (const entry of reloptions) {
    const text = String(entry);
    const separator = text.indexOf("=");
    const name = separator === -1 ? text : text.slice(0, separator);
    if (name.trim().toLowerCase() !== option) {
      continue;
    }
    const value =
      separator === -1
        ? "true"
        : text
            .slice(separator + 1)
            .trim()
            .toLowerCase();
    return value === "true" || value === "on" || value === "1" || value === "yes";
  }
  return false;
}

async function appendIndexes(
  pool: CatalogPool,
  objects: SchemaObject[],
  ordinal: number
): Promise<number> {
  let nextOrdinal = ordinal;

  const result = await pool.query<Record<string, unknown>>(`
    select
      n.nspname as schemaname,
      table_class.relname as tablename,
      index_class.relname as indexname,
      pg_get_indexdef(index_class.oid) as indexdef
    from pg_class index_class
    join pg_namespace n on n.oid = index_class.relnamespace
    join pg_index i on i.indexrelid = index_class.oid
    join pg_class table_class on table_class.oid = i.indrelid
    where index_class.relkind in ('i', 'I')
      and ${catalogSchemaFilter(pool)}
      and ${notExtensionMember("index_class", "pg_class")}
      and ${notExtensionMember("table_class", "pg_class")}
      and not exists (
        select 1
        from pg_constraint con
        where con.conindid = index_class.oid
      )
    order by n.nspname, index_class.relname
  `);
  for (const row of result.rows) {
    const object = makeObject(
      {
        kind: "index",
        name: stringValue(row.indexname),
        schema: stringValue(row.schemaname),
        table: stringValue(row.tablename),
      },
      stringValue(row.indexdef),
      nextOrdinal
    );
    object.dependencies.push(`${stringValue(row.schemaname)}.${stringValue(row.tablename)}`);
    objects.push(object);
    nextOrdinal += 1;
  }
  return nextOrdinal;
}

async function appendTriggers(
  pool: CatalogPool,
  objects: SchemaObject[],
  ordinal: number
): Promise<number> {
  let nextOrdinal = ordinal;
  const result = await pool.query<Record<string, unknown>>(`
    select
      n.nspname as schema,
      c.relname as table_name,
      t.tgname as name,
      pg_get_triggerdef(t.oid, true) as definition
    from pg_trigger t
    join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace
    where not t.tgisinternal
      and ${catalogSchemaFilter(pool)}
      and ${notExtensionMember("c", "pg_class")}
    order by n.nspname, c.relname, t.tgname
  `);
  for (const row of result.rows) {
    objects.push(
      makeObject(
        {
          kind: "trigger",
          name: stringValue(row.name),
          schema: stringValue(row.schema),
          table: stringValue(row.table_name),
        },
        stringValue(row.definition),
        nextOrdinal
      )
    );
    nextOrdinal += 1;
  }
  return nextOrdinal;
}

async function appendPoliciesAndRls(
  pool: CatalogPool,
  objects: SchemaObject[],
  ordinal: number
): Promise<number> {
  let nextOrdinal = ordinal;
  const rls = await pool.query<Record<string, unknown>>(`
    select n.nspname as schema, c.relname as name, c.relrowsecurity as rls, c.relforcerowsecurity as force
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and (c.relrowsecurity or c.relforcerowsecurity)
      and ${catalogSchemaFilter(pool)}
      and ${notExtensionMember("c", "pg_class")}
    order by n.nspname, c.relname
  `);
  for (const row of rls.rows) {
    const schema = stringValue(row.schema);
    const name = stringValue(row.name);

    const state = {
      rlsEnabled: row.rls === true,
      rlsForced: row.force === true,
    };
    objects.push(
      makeObject(
        { kind: "rls", name, schema, table: name },
        rlsStateSql(schema, name, state),
        nextOrdinal,
        undefined,
        state
      )
    );
    nextOrdinal += 1;
  }
  const policies = await pool.query<Record<string, unknown>>(`
    select
      schemaname as schema,
      tablename as table_name,
      policyname as name,
      permissive,
      roles,
      cmd,
      qual,
      with_check
    from pg_policies
    where exists (
      select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = pg_policies.schemaname
        and c.relname = pg_policies.tablename
        and ${catalogSchemaFilter(pool)}
        and ${notExtensionMember("c", "pg_class")}
    )
    order by schemaname, tablename, policyname
  `);
  for (const row of policies.rows) {
    const schema = stringValue(row.schema);
    const table = stringValue(row.table_name);
    const name = stringValue(row.name);
    const clauses = [
      `CREATE POLICY ${quoteIdent(name)} ON ${formatQualifiedName(schema, table)}`,
      `AS ${stringValue(row.permissive)}`,
      `FOR ${stringValue(row.cmd)}`,

      `TO ${normalizePolicyRoles(row.roles)
        .map((role) => (role === "public" ? "PUBLIC" : quoteIdent(role)))
        .join(", ")}`,
    ];
    if (row.qual) {
      clauses.push(`USING (${stringValue(row.qual)})`);
    }
    if (row.with_check) {
      clauses.push(`WITH CHECK (${stringValue(row.with_check)})`);
    }
    const sql = clauses.join(" ");
    objects.push(
      makeObject({ kind: "policy", name, schema, table }, sql, nextOrdinal, undefined, {
        command: stringValue(row.cmd)?.toLowerCase() ?? "all",
        hasCheckPredicate: stringValue(row.with_check) !== undefined,
        hasUsingPredicate: stringValue(row.qual) !== undefined,
        ...(await policyMetadataFromSql(sql)),
      })
    );
    nextOrdinal += 1;
  }
  return nextOrdinal;
}

function normalizePolicyRoles(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      return trimmed
        .slice(1, -1)
        .split(",")
        .map((role) => stripOuterDoubleQuotes(role.trim()))
        .filter(Boolean);
    }
    return trimmed
      .split(",")
      .map((role) => role.trim())
      .filter(Boolean);
  }
  return [String(value)];
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
