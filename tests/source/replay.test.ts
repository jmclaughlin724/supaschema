import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/schema.js";
import { MODEL_FORMAT_VERSION } from "../../src/hash.js";
import { buildSchemaPlanningContext } from "../../src/planner/context.js";
import { extractSourceModel } from "../../src/source/extract.js";
import type {
  Diagnostic,
  SchemaModel,
  SchemaObject,
  SupaschemaConfig,
  TableColumn,
} from "../../src/types.js";

const lowercaseHexCharacters = "0123456789abcdef";

async function writeMigrations(files: [string, string][]): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "supa-replay-"));
  for (const [name, sql] of files) {
    await writeFile(join(directory, name), sql);
  }
  return directory;
}

async function extractMigrations(
  files: [string, string][],
  config: SupaschemaConfig = resolveConfig()
): Promise<SchemaModel> {
  const directory = await writeMigrations(files);
  return extractSourceModel(`migrations:${directory}`, { config });
}

async function extractDirectory(
  files: [string, string][],
  config: SupaschemaConfig = resolveConfig()
): Promise<SchemaModel> {
  const directory = await writeMigrations(files);
  return extractSourceModel(`dir:${directory}`, { config });
}

function errors(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.filter((item) => item.severity === "error");
}

function table(model: SchemaModel, key: string): SchemaObject | undefined {
  return model.objects.find((object) => object.key === key);
}

async function expectPolicyReplayMatchesDeclaration(
  initialPolicy: string,
  alteration: string,
  declaredPolicy: string
): Promise<void> {
  const history = await extractMigrations([
    [
      "20240101000000_alter_policy.sql",
      `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, active boolean);
${initialPolicy}
${alteration}`,
    ],
  ]);
  const declared = await extractDirectory([
    [
      "app.sql",
      `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, active boolean);
${declaredPolicy}`,
    ],
  ]);

  expect(errors(history.diagnostics)).toEqual([]);
  expect(errors(declared.diagnostics)).toEqual([]);
  expect(history.fingerprint).toBe(declared.fingerprint);
  expect(table(history, "policy:app.accounts_update:accounts")?.hash).toBe(
    table(declared, "policy:app.accounts_update:accounts")?.hash
  );
}

function columns(object: SchemaObject | undefined): TableColumn[] {
  const value = object?.metadata.columns;
  return Array.isArray(value) ? value.filter(isTableColumn) : [];
}

function columnNames(object: SchemaObject | undefined): string[] {
  return columns(object).map((column) => column.name);
}

function column(object: SchemaObject | undefined, name: string): TableColumn | undefined {
  return columns(object).find((item) => item.name === name);
}

function enumValues(model: SchemaModel, key: string): string[] {
  const value = model.objects.find((object) => object.key === key)?.metadata.values;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isTableColumn(value: unknown): value is TableColumn {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof Reflect.get(value, "definition") === "string" &&
    typeof Reflect.get(value, "name") === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256Hex(value: string): boolean {
  if (value.length !== 64) {
    return false;
  }
  for (const character of value) {
    if (!lowercaseHexCharacters.includes(character)) {
      return false;
    }
  }
  return true;
}

function fixtureFileHashes(value: unknown): Record<string, string> {
  if (!(isRecord(value) && isRecord(value.files))) {
    throw new Error("Anilize migration fixture provenance must contain a files object");
  }
  const hashes: Record<string, string> = {};
  for (const [file, hash] of Object.entries(value.files)) {
    if (!file.endsWith(".sql") || typeof hash !== "string" || !isSha256Hex(hash)) {
      throw new Error(`Invalid Anilize migration fixture hash for ${file}`);
    }
    hashes[file] = hash;
  }
  return hashes;
}

describe("migrations source replay", () => {
  it("replays the immutable Anilize migration corpus deterministically", async () => {
    const fixture = join(process.cwd(), "tests", "fixtures", "anilize-migrations");
    const provenance: unknown = JSON.parse(
      await readFile(join(fixture, "provenance.json"), "utf8")
    );
    const expectedHashes = fixtureFileHashes(provenance);
    const expectedSqlFiles = Object.keys(expectedHashes).sort();
    const actualSqlFiles = (await readdir(fixture)).filter((file) => file.endsWith(".sql")).sort();
    expect(actualSqlFiles).toEqual(expectedSqlFiles);
    for (const file of actualSqlFiles) {
      const actualHash = createHash("sha256")
        .update(await readFile(join(fixture, file)))
        .digest("hex");
      expect(actualHash, file).toBe(expectedHashes[file]);
    }

    const config = resolveConfig({ migrationsDir: fixture });
    const first = await extractSourceModel(`migrations:${fixture}`, { config });
    const second = await extractSourceModel(`migrations:${fixture}`, {
      config,
    });

    expect(first.diagnostics).toEqual([]);
    expect(second.diagnostics).toEqual([]);
    expect(first.formatVersion).toBe(MODEL_FORMAT_VERSION);
    expect(first.objects).toHaveLength(246);
    expect(first.fingerprint).toBe(
      "981829cb6c103886b7981a4394fd6d8990db32ec502ba4b2beac0d7f813bedb3"
    );
    expect(second.objects.map(({ hash, key }) => ({ hash, key }))).toEqual(
      first.objects.map(({ hash, key }) => ({ hash, key }))
    );
    expect(second.fingerprint).toBe(first.fingerprint);

    const objectKeys = first.objects.map((object) => object.key);
    const roleAssignmentCheckNames = first.objects
      .filter(
        (object) =>
          object.ref.kind === "constraint" &&
          object.ref.schema === "authz" &&
          object.ref.table === "role_assignments" &&
          object.metadata.constraintType === "CONSTR_CHECK"
      )
      .map((object) => object.ref.name);
    expect(roleAssignmentCheckNames).toEqual([
      "role_assignments_check",
      "role_assignments_check1",
      "role_assignments_check2",
    ]);
    expect(first.objects.some((object) => object.sql.toLowerCase().includes("create role"))).toBe(
      false
    );
    expect(objectKeys).toContain("table:platform.fastmcp_key_value");

    expect(objectKeys).toContain(
      "constraint:core.relationships_id_organization_id_key:relationships"
    );
    expect(objectKeys).not.toContain(
      "index:core.relationships_id_organization_id_key:relationships"
    );
    const validatedConstraintKeys = [
      "constraint:mortgage.loan_cases_relationship_id_organization_id_fkey:loan_cases",
      "constraint:real_estate.transactions_relationship_id_organization_id_fkey:transactions",
    ];
    const validatedConstraints = first.objects.filter((object) =>
      validatedConstraintKeys.includes(object.key)
    );
    expect(validatedConstraints.map((object) => object.key)).toEqual(validatedConstraintKeys);
    for (const constraint of validatedConstraints) {
      expect(constraint.sql.toUpperCase()).not.toContain("NOT VALID");
    }
  });

  it("reconstructs create, column alter, column rename, enum append, and drop end-state", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_create.sql",
        `CREATE SCHEMA app;
CREATE TYPE app.status AS ENUM ('draft', 'active');
CREATE TABLE app.accounts (
  id integer NOT NULL,
  nickname text,
  status app.status NOT NULL DEFAULT 'draft'
);
CREATE TABLE app.archived_accounts (id integer);`,
      ],
      [
        "20240102000000_mutate.sql",
        `ALTER TABLE app.accounts ADD COLUMN age integer;
ALTER TABLE app.accounts ALTER COLUMN age TYPE bigint;
ALTER TABLE app.accounts RENAME COLUMN nickname TO display_name;
ALTER TYPE app.status ADD VALUE IF NOT EXISTS 'paused' AFTER 'draft';
DROP TABLE app.archived_accounts;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    const accounts = table(model, "table:app.accounts");
    expect(columnNames(accounts)).toEqual(["id", "display_name", "status", "age"]);
    expect(column(accounts, "age")).toEqual(
      expect.objectContaining({ definition: "bigint", type: "bigint" })
    );
    expect(enumValues(model, "enum:app.status")).toEqual(["draft", "paused", "active"]);
    expect(table(model, "table:app.archived_accounts")).toBeUndefined();
  });

  it("nets create and drop of the same table to an absent table", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_create_drop.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.transient_events (id integer);
DROP TABLE app.transient_events;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(model.objects.map((object) => object.key)).not.toContain("table:app.transient_events");
  });

  it("replays CREATE and DROP FOREIGN DATA WRAPPER", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_create_drop_fdw.sql",
        `CREATE FOREIGN DATA WRAPPER airtable;
DROP FOREIGN DATA WRAPPER airtable;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(model.objects.map((object) => object.key)).not.toContain(
      "foreign-data-wrapper:airtable"
    );
  });

  it("replays DROP INDEX before an index is recreated", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_recreate_index.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, company_id integer);
CREATE INDEX accounts_lookup_idx ON app.accounts (id);
DROP INDEX app.accounts_lookup_idx;
CREATE INDEX accounts_lookup_idx ON app.accounts (company_id);`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(
      model.objects.filter((object) => object.key === "index:app.accounts_lookup_idx:accounts")
    ).toHaveLength(1);
    expect(
      model.objects.find((object) => object.key === "index:app.accounts_lookup_idx:accounts")?.sql
    ).toContain("company_id");
  });

  it("allocates unnamed ADD COLUMN constraints against existing table constraints", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_create.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (
  id bigint,
  CONSTRAINT accounts_minimum_check CHECK (id > 0)
);
ALTER TABLE app.accounts ADD COLUMN minimum bigint CHECK (minimum > id);`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(
      model.objects
        .filter((object) => object.ref.kind === "constraint")
        .map((object) => object.ref.name)
    ).toEqual(["accounts_minimum_check", "accounts_minimum_check1"]);
  });

  it("allocates generated constraint names within the owning table", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_create.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.other (
  id bigint,
  CONSTRAINT accounts_check CHECK (id > 0)
);
CREATE TABLE app.accounts (
  minimum bigint,
  maximum bigint,
  CHECK (minimum <= maximum)
);`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(
      model.objects
        .filter((object) => object.ref.kind === "constraint")
        .map((object) => object.ref.name)
    ).toEqual(["accounts_check", "accounts_check"]);
  });

  it("reuses a generated constraint name after PostgreSQL drops it", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_reuse.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (
  minimum bigint,
  maximum bigint,
  CHECK (minimum <= maximum)
);
ALTER TABLE app.accounts DROP CONSTRAINT accounts_check;
ALTER TABLE app.accounts ADD CHECK (minimum IS NULL OR maximum IS NULL);`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(
      model.objects
        .filter((object) => object.ref.kind === "constraint")
        .map((object) => object.ref.name)
    ).toEqual(["accounts_check"]);
  });

  it("still rejects duplicated explicitly named constraints", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_duplicate.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (
  id bigint,
  CONSTRAINT accounts_id_check CHECK (id > 0)
);
ALTER TABLE app.accounts ADD CONSTRAINT accounts_id_check CHECK (id < 100);`,
      ],
    ]);

    expect(errors(model.diagnostics).map((item) => item.code)).toEqual(["SUPA_REPLAY_ORDER_GAP"]);
  });

  it("treats catalog-guarded duplicate constraints as idempotent", async () => {
    const guarded = `DO $schema_replay$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'accounts_id_check'
  ) THEN
    ALTER TABLE app.accounts
      ADD CONSTRAINT accounts_id_check CHECK (id > 0);
  END IF;
END
$schema_replay$;`;
    const model = await extractMigrations([
      [
        "20240101000000_guarded.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id bigint);
${guarded}
${guarded}`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(
      model.objects.filter((object) => object.key === "constraint:app.accounts_id_check:accounts")
    ).toHaveLength(1);
  });

  it("hard-fails duplicate CREATE without idempotency", async () => {
    const duplicate = await extractMigrations([
      [
        "20240101000000_duplicate.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE TABLE app.accounts (id integer);`,
      ],
    ]);

    expect(duplicate.objects).toEqual([]);
    expect(errors(duplicate.diagnostics).map((item) => item.code)).toEqual([
      "SUPA_REPLAY_ORDER_GAP",
    ]);
  });

  it("skips duplicate CREATE IF NOT EXISTS statements", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_if_not_exists.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE TABLE IF NOT EXISTS app.accounts (id integer, ignored text);
CREATE INDEX IF NOT EXISTS accounts_id_idx ON app.accounts (id);
CREATE INDEX IF NOT EXISTS accounts_id_idx ON app.accounts (id);`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(columnNames(table(model, "table:app.accounts"))).toEqual(["id"]);
    expect(
      model.objects.filter((object) => object.key === "index:app.accounts_id_idx:accounts")
    ).toHaveLength(1);
  });

  it("skips every object synthesized from a duplicate CREATE TABLE IF NOT EXISTS", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_if_not_exists_constraints.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (
  id integer PRIMARY KEY,
  email text UNIQUE
);
CREATE TABLE IF NOT EXISTS app.accounts (
  id integer PRIMARY KEY,
  email text UNIQUE,
  ignored text UNIQUE
);`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(columnNames(table(model, "table:app.accounts"))).toEqual(["id", "email"]);
    expect(table(model, "constraint:app.accounts_ignored_key:accounts")).toBeUndefined();
  });

  it("replaces CREATE OR REPLACE objects instead of treating them as duplicate creates", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_replace_view.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, name text);
CREATE OR REPLACE FUNCTION app.touch_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE OR REPLACE VIEW app.account_names AS SELECT name FROM app.accounts;
CREATE OR REPLACE VIEW app.account_names AS SELECT id FROM app.accounts;
CREATE OR REPLACE TRIGGER accounts_touch BEFORE UPDATE ON app.accounts FOR EACH ROW EXECUTE FUNCTION app.touch_account();
CREATE OR REPLACE TRIGGER accounts_touch BEFORE INSERT ON app.accounts FOR EACH ROW EXECUTE FUNCTION app.touch_account();`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(table(model, "table:app.accounts")).toBeDefined();
    expect(model.objects.find((object) => object.key === "view:app.account_names")?.sql).toContain(
      "SELECT id"
    );
    expect(
      model.objects.find((object) => object.key === "trigger:app.accounts_touch:accounts")?.sql
    ).toContain("BEFORE INSERT");
  });

  it("replays column rename chains against the current table shape", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_create.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.people (full_name text);`,
      ],
      [
        "20240102000000_rename.sql",
        `ALTER TABLE app.people RENAME COLUMN full_name TO name;
ALTER TABLE app.people RENAME COLUMN name TO display_name;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(columnNames(table(model, "table:app.people"))).toEqual(["display_name"]);
  }, 10_000);

  it("honors enum BEFORE and AFTER neighbor ordering", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_enum.sql",
        `CREATE SCHEMA app;
CREATE TYPE app.status AS ENUM ('draft', 'active');`,
      ],
      [
        "20240102000000_enum_values.sql",
        `ALTER TYPE app.status ADD VALUE IF NOT EXISTS 'queued' BEFORE 'active';
ALTER TYPE app.status ADD VALUE IF NOT EXISTS 'archived' AFTER 'active';`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(enumValues(model, "enum:app.status")).toEqual(["draft", "queued", "active", "archived"]);
  });

  it("renames enum values without changing enum ordering", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_enum_rename.sql",
        `CREATE SCHEMA app;
CREATE TYPE app.status AS ENUM ('draft', 'queued', 'active');
ALTER TYPE app.status RENAME VALUE 'queued' TO 'waiting';`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(enumValues(model, "enum:app.status")).toEqual(["draft", "waiting", "active"]);
  });

  it("replays simple DDL embedded in idempotent DO blocks", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_do_enum.sql",
        `CREATE SCHEMA app;
DO $schema_replay$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'status') THEN
    CREATE TYPE app.status AS ENUM ('draft', 'active');
  END IF;
END
$schema_replay$;
DO $schema_replay$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'status') THEN
    CREATE TYPE app.status AS ENUM ('draft', 'active');
  END IF;
END
$schema_replay$;
ALTER TYPE app.status ADD VALUE IF NOT EXISTS 'queued' BEFORE 'active';`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(enumValues(model, "enum:app.status")).toEqual(["draft", "queued", "active"]);
  });

  it("preserves quoted identifiers while replaying DO-block DDL", async () => {
    const ddl = 'CREATE TABLE app."items;""archive" ("create;value" text);';
    const history = await extractMigrations([
      [
        "20240101000000_quoted_identifier.sql",
        `CREATE SCHEMA app;
DO $schema_replay$ BEGIN ${ddl} END $schema_replay$;`,
      ],
    ]);
    const declared = await extractDirectory([["app.sql", `CREATE SCHEMA app; ${ddl}`]]);

    expect(errors(history.diagnostics)).toEqual([]);
    expect(errors(declared.diagnostics)).toEqual([]);
    expect(history.fingerprint).toBe(declared.fingerprint);
  });

  it("preserves bare-dollar-quoted values while replaying DO-block DDL", async () => {
    const ddl = "CREATE TYPE app.status AS ENUM ($$draft;queued$$, 'active');";
    const history = await extractMigrations([
      [
        "20240101000000_dollar_quote.sql",
        `CREATE SCHEMA app;
DO $schema_replay$ BEGIN ${ddl} END $schema_replay$;`,
      ],
    ]);
    const declared = await extractDirectory([["app.sql", `CREATE SCHEMA app; ${ddl}`]]);

    expect(errors(history.diagnostics)).toEqual([]);
    expect(errors(declared.diagnostics)).toEqual([]);
    expect(history.fingerprint).toBe(declared.fingerprint);
    expect(enumValues(history, "enum:app.status")).toEqual(["draft;queued", "active"]);
  });

  it("preserves one DO-block idempotency guard across multiple guarded DDL statements", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_do_guard.sql",
        `CREATE SCHEMA app;
DO $schema_replay$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'status') THEN
    CREATE TYPE app.status AS ENUM ('draft', 'active');
    CREATE TYPE app.priority AS ENUM ('low', 'high');
  END IF;
END
$schema_replay$;
DO $schema_replay$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'status') THEN
    CREATE TYPE app.status AS ENUM ('draft', 'active');
    CREATE TYPE app.priority AS ENUM ('low', 'high');
  END IF;
END
$schema_replay$;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(enumValues(model, "enum:app.status")).toEqual(["draft", "active"]);
    expect(enumValues(model, "enum:app.priority")).toEqual(["low", "high"]);
  });

  it("keeps modeled ALTER TABLE subtypes from the same multi-command statement", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_table.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);`,
      ],
      [
        "20240102000000_mixed_alter.sql",
        `ALTER TABLE app.accounts
  ADD COLUMN name text,
  ADD CONSTRAINT accounts_name_check CHECK (char_length(name) > 0);`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(columnNames(table(model, "table:app.accounts"))).toEqual(["id", "name"]);
    expect(model.objects).toContainEqual(
      expect.objectContaining({
        ref: {
          kind: "constraint",
          name: "accounts_name_check",
          schema: "app",
          table: "accounts",
        },
      })
    );
  });

  it("synthesizes constraints from ADD COLUMN inline constraints", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_add_column_unique.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
ALTER TABLE app.accounts ADD COLUMN email text UNIQUE;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(columnNames(table(model, "table:app.accounts"))).toEqual(["id", "email"]);
    expect(table(model, "constraint:app.accounts_email_key:accounts")).toBeDefined();
  });

  it("skips duplicate ADD COLUMN IF NOT EXISTS statements", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_add_column_if_not_exists.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
ALTER TABLE app.accounts ADD COLUMN IF NOT EXISTS id integer;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(columnNames(table(model, "table:app.accounts"))).toEqual(["id"]);
  });

  it("removes column-scoped indexes when a column is dropped", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_drop_indexed_column.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, email text);
CREATE INDEX accounts_email_idx ON app.accounts (email);
ALTER TABLE app.accounts DROP COLUMN email;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(columnNames(table(model, "table:app.accounts"))).toEqual(["id"]);
    expect(table(model, "index:app.accounts_email_idx:accounts")).toBeUndefined();
  });

  it("rebinds constraint SQL when a constrained column is renamed", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_rename_constrained_column.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, email text UNIQUE);
ALTER TABLE app.accounts RENAME COLUMN email TO contact_email;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    const constraint = table(model, "constraint:app.accounts_email_key:accounts");
    expect(constraint?.metadata.constraintColumns).toEqual(["contact_email"]);
    expect(constraint?.sql).toContain("contact_email");
  });

  it("rebinds dependent view SQL when a table is renamed", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_rename_view_source.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE VIEW app.account_ids AS SELECT id FROM app.accounts;
ALTER TABLE app.accounts RENAME TO customers;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(table(model, "table:app.customers")).toBeDefined();
    expect(table(model, "view:app.account_ids")?.sql).toContain("customers");
  });

  it("rebinds a column comment identity when the column is renamed", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_rename_commented_column.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, email text);
COMMENT ON COLUMN app.accounts.email IS 'contact';
ALTER TABLE app.accounts RENAME COLUMN email TO contact_email;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    const comments = model.objects.filter((object) => object.ref.kind === "comment");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.metadata.commentTarget).toMatchObject({
      kind: "column",
      name: "contact_email",
      table: "accounts",
    });
    expect(comments[0]?.sql).toContain("contact_email");
    expect(comments[0]?.sql).not.toContain("accounts.email");
  });

  it("rebinds table and column comment identities when the table is renamed", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_rename_commented_table.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, email text);
COMMENT ON TABLE app.accounts IS 'directory';
COMMENT ON COLUMN app.accounts.email IS 'contact';
ALTER TABLE app.accounts RENAME TO customers;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    const targets = model.objects
      .filter((object) => object.ref.kind === "comment")
      .map((object) => object.metadata.commentTarget);
    expect(targets).toHaveLength(2);
    expect(targets).toContainEqual(expect.objectContaining({ kind: "table", name: "customers" }));
    expect(targets).toContainEqual(
      expect.objectContaining({
        kind: "column",
        name: "email",
        table: "customers",
      })
    );
    for (const comment of model.objects.filter((object) => object.ref.kind === "comment")) {
      expect(comment.sql).toContain("customers");
      expect(comment.sql).not.toContain("accounts");
    }

    const declarative = await extractMigrations([
      [
        "20240101000000_commented_table.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.customers (id integer, email text);
COMMENT ON TABLE app.customers IS 'directory';
COMMENT ON COLUMN app.customers.email IS 'contact';`,
      ],
    ]);
    const replayHashes = model.objects
      .filter((object) => object.ref.kind === "comment")
      .map((object) => object.hash)
      .sort((left, right) => left.localeCompare(right));
    const declarativeHashes = declarative.objects
      .filter((object) => object.ref.kind === "comment")
      .map((object) => object.hash)
      .sort((left, right) => left.localeCompare(right));
    expect(replayHashes).toEqual(declarativeHashes);
  });

  it("rebuilds renamed comment SQL with quoted identifiers", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_rename_quoted_table.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, email text);
COMMENT ON TABLE app.accounts IS 'directory';
COMMENT ON COLUMN app.accounts.email IS 'contact';
ALTER TABLE app.accounts RENAME TO "Purchase Order";`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    const comments = model.objects.filter((object) => object.ref.kind === "comment");
    expect(comments).toHaveLength(2);
    const tableComment = comments.find(
      (object) => object.metadata.descriptor === "table app.Purchase Order"
    );
    expect(tableComment?.sql).toBe(`COMMENT ON TABLE app."Purchase Order" IS 'directory'`);
    const columnComment = comments.find(
      (object) => object.metadata.descriptor === "column app.Purchase Order.email"
    );
    expect(columnComment?.sql).toBe(`COMMENT ON COLUMN app."Purchase Order".email IS 'contact'`);
  });

  it("deletes empty-string and IS NULL comments while keeping nonempty comments", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_empty_comment.sql",
        `CREATE SCHEMA app;
CREATE SCHEMA other;
CREATE SCHEMA extra;
COMMENT ON SCHEMA app IS '';
COMMENT ON SCHEMA other IS 'temp';
COMMENT ON SCHEMA other IS NULL;
COMMENT ON SCHEMA extra IS 'docs';`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    const comments = model.objects.filter((object) => object.ref.kind === "comment");
    expect(comments).toHaveLength(1);
    expect(comments[0]?.metadata.description).toBe("docs");
    expect(comments[0]?.metadata.commentTarget).toMatchObject({
      kind: "schema",
      name: "extra",
    });
  });

  it("hard-fails unsupported rename types without returning partial objects", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_rename_schema.sql",
        `CREATE SCHEMA app;
ALTER SCHEMA app RENAME TO app2;`,
      ],
    ]);

    expect(model.objects).toEqual([]);
    expect(errors(model.diagnostics).map((item) => item.code)).toEqual(["SUPA_REPLAY_UNSUPPORTED"]);
  });

  it("skips renames whose target table is absent from the replay model", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_absent_rename.sql",
        `ALTER TABLE app.legacy_accounts RENAME TO legacy_accounts__adopted;
ALTER TABLE app.legacy_people RENAME COLUMN full_name TO name;
CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(columnNames(table(model, "table:app.accounts"))).toEqual(["id"]);
  });

  it("skips absent ALTER targets and DROP IF EXISTS targets", async () => {
    const model = await extractMigrations(
      [
        [
          "20240101000000_absent_managed_targets.sql",
          `CREATE SCHEMA app;
ALTER TABLE auth.users ADD COLUMN nickname text;
DROP TABLE IF EXISTS auth.identities;
CREATE TABLE app.accounts (id integer);
ALTER TABLE app.accounts DROP COLUMN IF EXISTS missing_column;`,
        ],
      ],
      resolveConfig({
        managedSchemas: ["auth"],
        schemas: { exclude: ["auth"], include: [] },
      })
    );

    expect(errors(model.diagnostics)).toEqual([]);
    expect(columnNames(table(model, "table:app.accounts"))).toEqual(["id"]);
  });

  it("does not hard-fail managed schema DDL filtered out by config", async () => {
    const model = await extractMigrations(
      [
        [
          "20240101000000_managed_schema.sql",
          `CREATE SCHEMA vault;
CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);`,
        ],
      ],
      resolveConfig({
        managedSchemas: ["vault"],
        schemas: { exclude: ["vault"], include: [] },
      })
    );

    expect(errors(model.diagnostics)).toEqual([]);
    expect(table(model, "schema:vault")).toBeUndefined();
    expect(columnNames(table(model, "table:app.accounts"))).toEqual(["id"]);
  });

  it("hard-fails absent DROP targets without IF EXISTS as ordering gaps", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_drop_missing.sql",
        `CREATE SCHEMA app;
DROP TABLE app.missing;`,
      ],
    ]);

    expect(model.objects).toEqual([]);
    expect(errors(model.diagnostics).map((item) => item.code)).toEqual(["SUPA_REPLAY_ORDER_GAP"]);
  });

  it("drops table-owned sequences with their owning table", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_drop_owned_sequence.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE SEQUENCE app.accounts_id_seq;
ALTER SEQUENCE app.accounts_id_seq OWNED BY app.accounts.id;
DROP TABLE app.accounts;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(table(model, "table:app.accounts")).toBeUndefined();
    expect(table(model, "sequence:app.accounts_id_seq")).toBeUndefined();
  });

  it("drops dependent views when DROP TABLE uses CASCADE", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_drop_cascade.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE VIEW app.account_ids AS SELECT id FROM app.accounts;
DROP TABLE app.accounts CASCADE;`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(table(model, "table:app.accounts")).toBeUndefined();
    expect(table(model, "view:app.account_ids")).toBeUndefined();
  });

  describe("drops remove attached grants and comments", () => {
    const prelude = `CREATE SCHEMA app;
CREATE TABLE app.thing (id integer primary key);`;

    async function replayDrop(create: string, drop: string): Promise<SchemaModel> {
      return await extractMigrations([
        ["20240101000000_create.sql", `${prelude}\n${create}`],
        ["20240102000000_drop.sql", drop],
      ]);
    }

    function attachedObjects(model: SchemaModel): string[] {
      return model.objects
        .filter((object) => object.ref.kind === "grant" || object.ref.kind === "comment")
        .map((object) => object.key);
    }

    const dropForms: [string, string, string][] = [
      [
        "DROP VIEW IF EXISTS unquoted",
        `CREATE VIEW app.v_thing AS SELECT id FROM app.thing;
GRANT SELECT ON TABLE app.v_thing TO authenticated;
COMMENT ON VIEW app.v_thing IS 'a view';`,
        "DROP VIEW IF EXISTS app.v_thing;",
      ],
      [
        "DROP VIEW IF EXISTS quoted",
        `CREATE VIEW app.v_thing AS SELECT id FROM app.thing;
GRANT SELECT ON TABLE app.v_thing TO authenticated;
COMMENT ON VIEW app.v_thing IS 'a view';`,
        'DROP VIEW IF EXISTS "app"."v_thing";',
      ],
      [
        "DROP VIEW without IF EXISTS",
        `CREATE VIEW app.v_thing AS SELECT id FROM app.thing;
GRANT SELECT ON TABLE app.v_thing TO authenticated;
COMMENT ON VIEW app.v_thing IS 'a view';`,
        "DROP VIEW app.v_thing;",
      ],
      [
        "DROP MATERIALIZED VIEW IF EXISTS",
        `CREATE MATERIALIZED VIEW app.mv_thing AS SELECT id FROM app.thing;
GRANT SELECT ON TABLE app.mv_thing TO authenticated;
COMMENT ON MATERIALIZED VIEW app.mv_thing IS 'a matview';`,
        'DROP MATERIALIZED VIEW IF EXISTS "app"."mv_thing";',
      ],
      [
        "DROP FUNCTION IF EXISTS",
        `CREATE FUNCTION app.fn_thing() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
REVOKE ALL ON FUNCTION app.fn_thing() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.fn_thing() TO authenticated;
COMMENT ON FUNCTION app.fn_thing() IS 'a function';`,
        "DROP FUNCTION IF EXISTS app.fn_thing();",
      ],
      [
        "DROP TABLE IF EXISTS",
        `CREATE TABLE app.other (id integer);
GRANT SELECT ON TABLE app.other TO authenticated;
COMMENT ON TABLE app.other IS 'a table';
COMMENT ON COLUMN app.other.id IS 'the id';`,
        "DROP TABLE IF EXISTS app.other;",
      ],
      [
        "DROP SEQUENCE IF EXISTS",
        `CREATE SEQUENCE app.seq_thing;
GRANT USAGE ON SEQUENCE app.seq_thing TO authenticated;
COMMENT ON SEQUENCE app.seq_thing IS 'a sequence';`,
        "DROP SEQUENCE IF EXISTS app.seq_thing;",
      ],
      [
        "DROP TYPE IF EXISTS on an enum",
        `CREATE TYPE app.status AS ENUM ('on', 'off');
COMMENT ON TYPE app.status IS 'an enum';`,
        "DROP TYPE IF EXISTS app.status;",
      ],
    ];

    for (const [label, create, drop] of dropForms) {
      it(`removes attached objects for ${label}`, async () => {
        const model = await replayDrop(create, drop);
        expect(errors(model.diagnostics)).toEqual([]);
        expect(attachedObjects(model)).toEqual([]);
      });
    }

    it("removes attached objects of CASCADE-removed dependents", async () => {
      const model = await extractMigrations([
        [
          "20240101000000_create.sql",
          `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE VIEW app.account_ids AS SELECT id FROM app.accounts;
GRANT SELECT ON TABLE app.account_ids TO authenticated;
COMMENT ON VIEW app.account_ids IS 'derived';`,
        ],
        ["20240102000000_drop.sql", "DROP TABLE app.accounts CASCADE;"],
      ]);

      expect(errors(model.diagnostics)).toEqual([]);
      expect(table(model, "view:app.account_ids")).toBeUndefined();
      expect(attachedObjects(model)).toEqual([]);
    });

    it("does not restore a dropped grant when the relation is recreated", async () => {
      const model = await extractMigrations([
        [
          "20240101000000_create.sql",
          `${prelude}
CREATE VIEW app.v_thing AS SELECT id FROM app.thing;
GRANT SELECT ON TABLE app.v_thing TO authenticated;`,
        ],
        ["20240102000000_drop.sql", "DROP VIEW app.v_thing;"],
        ["20240103000000_recreate.sql", "CREATE VIEW app.v_thing AS SELECT id FROM app.thing;"],
      ]);

      expect(errors(model.diagnostics)).toEqual([]);
      expect(table(model, "view:app.v_thing")).toBeDefined();
      expect(attachedObjects(model)).toEqual([]);
    });

    it("keeps grants and comments for objects that were not dropped", async () => {
      const model = await replayDrop(
        `CREATE VIEW app.v_thing AS SELECT id FROM app.thing;
GRANT SELECT ON TABLE app.v_thing TO authenticated;
GRANT SELECT ON TABLE app.thing TO authenticated;
COMMENT ON TABLE app.thing IS 'kept';`,
        "DROP VIEW app.v_thing;"
      );

      expect(errors(model.diagnostics)).toEqual([]);
      expect(
        model.objects
          .filter((object) => object.ref.kind === "grant")
          .map((object) => object.metadata.targetIdentity)
      ).toEqual(["app.thing"]);
      expect(
        model.objects
          .filter((object) => object.ref.kind === "comment")
          .map((object) => object.metadata.descriptor)
      ).toEqual(["table app.thing"]);
    });
  });

  it("replays drop-and-recreate indexes and constraints", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_drop_recreate_owned_objects.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (
  id integer,
  name text,
  CONSTRAINT accounts_name_check CHECK (name IS NOT NULL)
);
CREATE INDEX accounts_name_idx ON app.accounts (name);
DROP INDEX app.accounts_name_idx;
ALTER TABLE app.accounts DROP CONSTRAINT accounts_name_check;
CREATE INDEX accounts_name_idx ON app.accounts (name);
ALTER TABLE app.accounts ADD CONSTRAINT accounts_name_check CHECK (name IS NOT NULL);`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(table(model, "index:app.accounts_name_idx:accounts")).toBeDefined();
    expect(table(model, "constraint:app.accounts_name_check:accounts")).toBeDefined();
  });

  it("hashes each constraint in a replayed multi-command ALTER like the declarative tree", async () => {
    const history = await extractMigrations([
      [
        "20240101000000_add_constraints.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, score integer);
ALTER TABLE app.accounts
  ADD CONSTRAINT accounts_id_positive CHECK (id > 0),
  ADD CONSTRAINT accounts_score_positive CHECK (score > 0);`,
      ],
    ]);
    const declared = await extractDirectory([
      [
        "app.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (
  id integer,
  score integer,
  CONSTRAINT accounts_id_positive CHECK (id > 0),
  CONSTRAINT accounts_score_positive CHECK (score > 0)
);`,
      ],
    ]);

    expect(errors(history.diagnostics)).toEqual([]);
    expect(errors(declared.diagnostics)).toEqual([]);
    const constraintKeys = [
      "constraint:app.accounts_id_positive:accounts",
      "constraint:app.accounts_score_positive:accounts",
    ];
    for (const key of constraintKeys) {
      expect(table(history, key)?.hash).toBe(table(declared, key)?.hash);
    }
    expect(history.fingerprint).toBe(declared.fingerprint);
  });

  it("preserves single-command ADD CONSTRAINT source facets during replay", async () => {
    const history = await extractMigrations([
      [
        "20240101000000_add_constraint.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, included integer);
ALTER TABLE ONLY app.accounts
  ADD CONSTRAINT accounts_id_key UNIQUE (id) INCLUDE (included) WITH (fillfactor = 80);`,
      ],
    ]);
    const declared = await extractDirectory([
      [
        "app.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (
  id integer,
  included integer,
  CONSTRAINT accounts_id_key UNIQUE (id) INCLUDE (included) WITH (fillfactor = 80)
);`,
      ],
    ]);

    expect(errors(history.diagnostics)).toEqual([]);
    expect(errors(declared.diagnostics)).toEqual([]);
    const key = "constraint:app.accounts_id_key:accounts";
    const replayedConstraint = table(history, key);
    expect(replayedConstraint?.sql).toContain("ALTER TABLE ONLY app.accounts");
    expect(replayedConstraint?.sql).toContain("INCLUDE (included)");
    expect(replayedConstraint?.sql).toContain("WITH (fillfactor = 80)");
    expect(replayedConstraint?.hash).toBe(table(declared, key)?.hash);
    expect(history.fingerprint).toBe(declared.fingerprint);
  });

  it("preserves source facets and the allocated name for an unnamed single command", async () => {
    const history = await extractMigrations([
      [
        "20240101000000_add_constraint.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, included integer);
ALTER TABLE ONLY app.accounts
  ADD UNIQUE (id) INCLUDE (included) WITH (fillfactor = 80);`,
      ],
    ]);
    const declared = await extractDirectory([
      [
        "app.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (
  id integer,
  included integer,
  UNIQUE (id) INCLUDE (included) WITH (fillfactor = 80)
);`,
      ],
    ]);

    expect(errors(history.diagnostics)).toEqual([]);
    expect(errors(declared.diagnostics)).toEqual([]);
    const key = "constraint:app.accounts_id_key:accounts";
    const replayedConstraint = table(history, key);
    expect(replayedConstraint?.sql).toContain('CONSTRAINT "accounts_id_key"');
    expect(replayedConstraint?.sql).toContain("INCLUDE (included)");
    expect(replayedConstraint?.sql).toContain("WITH (fillfactor = 80)");
    expect(replayedConstraint?.hash).toBe(table(declared, key)?.hash);
    expect(history.fingerprint).toBe(declared.fingerprint);
  });

  it("preserves source facets for an unnamed constraint in a multi-command ALTER", async () => {
    const history = await extractMigrations([
      [
        "20240101000000_add_constraints.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, included integer, score integer);
-- résumé
ALTER TABLE ONLY app.accounts
  ADD UNIQUE (id) INCLUDE (included) WITH (fillfactor = 80),
  ADD CONSTRAINT accounts_score_positive CHECK (score > 0);`,
      ],
    ]);
    const declared = await extractDirectory([
      [
        "app.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (
  id integer,
  included integer,
  score integer,
  UNIQUE (id) INCLUDE (included) WITH (fillfactor = 80),
  CONSTRAINT accounts_score_positive CHECK (score > 0)
);`,
      ],
    ]);

    expect(errors(history.diagnostics)).toEqual([]);
    expect(errors(declared.diagnostics)).toEqual([]);
    const key = "constraint:app.accounts_id_key:accounts";
    const replayedConstraint = table(history, key);
    expect(replayedConstraint?.sql).toContain("ALTER TABLE ONLY");
    expect(replayedConstraint?.sql).toContain('CONSTRAINT "accounts_id_key"');
    expect(replayedConstraint?.sql).toContain("INCLUDE (included)");
    expect(replayedConstraint?.sql).toContain("WITH (fillfactor = 80)");
    expect(replayedConstraint?.hash).toBe(table(declared, key)?.hash);
    expect(history.fingerprint).toBe(declared.fingerprint);
  });

  it("replays index rename before recreating the old index name", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_rename_index.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer, name text);
CREATE INDEX accounts_name_idx ON app.accounts (name);
ALTER INDEX app.accounts_name_idx RENAME TO accounts_name_idx_old;
CREATE INDEX accounts_name_idx ON app.accounts (name);`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(table(model, "index:app.accounts_name_idx:accounts")).toBeDefined();
    expect(table(model, "index:app.accounts_name_idx_old:accounts")).toBeDefined();
  });

  it("hashes a replayed index rename like the equivalent declarative tree", async () => {
    const migrations = await writeMigrations([
      [
        "20240101000000_rename_index.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE INDEX accounts_id_idx ON app.accounts (id);
ALTER INDEX app.accounts_id_idx RENAME TO accounts_lookup_idx;`,
      ],
    ]);
    const tree = await writeMigrations([
      [
        "app.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE INDEX accounts_lookup_idx ON app.accounts (id);`,
      ],
    ]);
    const config = resolveConfig();
    const replayed = await extractSourceModel(`migrations:${migrations}`, {
      config,
    });
    const declared = await extractSourceModel(`dir:${tree}`, { config });

    expect(errors(replayed.diagnostics)).toEqual([]);
    expect(errors(declared.diagnostics)).toEqual([]);
    const identities = (model: SchemaModel) =>
      model.objects.map((object) => ({
        hash: object.hash,
        key: object.key,
        sql: object.sql,
      }));
    expect(identities(replayed)).toEqual(identities(declared));
    expect(replayed.fingerprint).toBe(declared.fingerprint);
  });

  it("filters bootstrap inventory identically from migration and tree sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-bootstrap-parity-"));
    const migrations = join(root, "migrations");
    const schemas = join(root, "schemas");
    await mkdir(migrations);
    await mkdir(join(schemas, "_bootstrap"), { recursive: true });
    await writeFile(
      join(schemas, "_bootstrap", "extensions.sql"),
      "CREATE SCHEMA extensions;\nCREATE EXTENSION pgcrypto WITH SCHEMA extensions;\n"
    );
    await writeFile(
      join(schemas, "app.sql"),
      "CREATE SCHEMA app;\nCREATE TABLE app.accounts (id bigint);\n"
    );
    await writeFile(
      join(migrations, "20240101000000_create.sql"),
      `CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
CREATE SCHEMA app;
CREATE TABLE app.accounts (id bigint);`
    );
    const config = resolveConfig({
      migrationsDir: migrations,
      schemaPaths: [schemas],
    });
    const replayed = await extractSourceModel(`migrations:${migrations}`, {
      config,
      cwd: root,
    });
    const declared = await extractSourceModel(`dir:${schemas}`, {
      config,
      cwd: root,
    });

    expect(errors(replayed.diagnostics)).toEqual([]);
    expect(errors(declared.diagnostics)).toEqual([]);
    expect(replayed.fingerprint).toBe(declared.fingerprint);
  });

  it("accepts the configured migrations directory as the before-state with lineage present", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-migrations-lineage-match-"));
    const migrations = join(root, "migrations");
    const schemas = join(root, "schemas");
    await mkdir(migrations);
    await mkdir(schemas);
    await writeFile(
      join(migrations, "20240101000000_legacy.sql"),
      "CREATE SCHEMA app;\nCREATE TABLE app.accounts (id bigint);\n"
    );
    const config = resolveConfig({
      migrationsDir: migrations,
      schemaPaths: [schemas],
      sources: { from: "empty:" },
    });
    const before = await extractSourceModel(`migrations:${migrations}`, {
      config,
      cwd: root,
    });
    const generatedPath = join(migrations, "20240102000000_generated.sql");
    const generatedSql = "ALTER TABLE app.accounts ADD COLUMN name text;\n";
    await writeFile(generatedPath, generatedSql);
    const generated = await extractSourceModel(`migrations:${migrations}`, {
      config,
      cwd: root,
    });
    await writeFile(
      generatedPath,
      `-- supaschema: lineage format=${MODEL_FORMAT_VERSION} from=${before.fingerprint} to=${generated.fingerprint}
${generatedSql}`
    );
    await writeFile(
      join(migrations, "20240103000000_hand_authored.sql"),
      "ALTER TABLE app.accounts ADD COLUMN rogue text;\n"
    );
    await writeFile(
      join(schemas, "app.sql"),
      "CREATE SCHEMA app;\nCREATE TABLE app.accounts (id bigint, name text, rogue text);\n"
    );

    const context = await buildSchemaPlanningContext({
      config,
      cwd: root,
      from: `migrations:${migrations}`,
      migrationsDir: migrations,
      to: `dir:${schemas}`,
    });

    expect(errors(context.diagnostics)).toEqual([]);
  });

  it("blocks a non-matching migrations directory as the before-state", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-migrations-lineage-other-"));
    const migrations = join(root, "migrations");
    const other = join(root, "other-migrations");
    const schemas = join(root, "schemas");
    await mkdir(migrations);
    await mkdir(other);
    await mkdir(schemas);
    await writeFile(
      join(migrations, "20240101000000_legacy.sql"),
      "CREATE SCHEMA app;\nCREATE TABLE app.accounts (id bigint);\n"
    );
    await writeFile(
      join(other, "20240101000000_legacy.sql"),
      "CREATE SCHEMA app;\nCREATE TABLE app.accounts (id bigint);\n"
    );
    await writeFile(
      join(schemas, "app.sql"),
      "CREATE SCHEMA app;\nCREATE TABLE app.accounts (id bigint);\n"
    );
    const config = resolveConfig({
      migrationsDir: migrations,
      schemaPaths: [schemas],
      sources: { from: "empty:" },
    });

    const context = await buildSchemaPlanningContext({
      config,
      cwd: root,
      from: `migrations:${other}`,
      migrationsDir: migrations,
      to: `dir:${schemas}`,
    });

    expect(context.diagnostics.map((item) => item.code)).toContain(
      "SUPA_MIGRATION_BASELINE_UNSUPPORTED"
    );
  });

  it("blocks hand-authored migrations after generated lineage", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-migrations-lineage-"));
    const migrations = join(root, "migrations");
    const schemas = join(root, "schemas");
    await mkdir(migrations);
    await mkdir(schemas);
    const legacySql = "CREATE SCHEMA app;\nCREATE TABLE app.accounts (id bigint);\n";
    await writeFile(join(migrations, "20240101000000_legacy.sql"), legacySql);
    const config = resolveConfig({
      migrationsDir: migrations,
      schemaPaths: [schemas],
      sources: { from: "empty:" },
    });
    const before = await extractSourceModel(`migrations:${migrations}`, {
      config,
      cwd: root,
    });
    const generatedPath = join(migrations, "20240102000000_generated.sql");
    const generatedSql = "ALTER TABLE app.accounts ADD COLUMN name text;\n";
    await writeFile(generatedPath, generatedSql);
    const generated = await extractSourceModel(`migrations:${migrations}`, {
      config,
      cwd: root,
    });
    await writeFile(
      generatedPath,
      `-- supaschema: lineage format=${MODEL_FORMAT_VERSION} from=${before.fingerprint} to=${generated.fingerprint}
${generatedSql}`
    );
    await writeFile(
      join(migrations, "20240103000000_hand_authored.sql"),
      "ALTER TABLE app.accounts ADD COLUMN rogue text;\n"
    );
    await writeFile(
      join(schemas, "app.sql"),
      "CREATE SCHEMA app;\nCREATE TABLE app.accounts (id bigint, name text, rogue text);\n"
    );

    const context = await buildSchemaPlanningContext({
      config,
      cwd: root,
      from: "empty:",
      migrationsDir: migrations,
      to: `dir:${schemas}`,
    });

    expect(context.diagnostics.map((item) => item.code)).toContain(
      "SUPA_MIGRATION_BASELINE_REPLAY_REQUIRED"
    );
  });

  it("replays RLS state transitions across migration files", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_create.sql",
        "CREATE SCHEMA app;\nCREATE TABLE app.accounts (id bigint);\nALTER TABLE app.accounts ENABLE ROW LEVEL SECURITY;\nALTER TABLE app.accounts FORCE ROW LEVEL SECURITY;",
      ],
      ["20240102000000_relax.sql", "ALTER TABLE app.accounts NO FORCE ROW LEVEL SECURITY;"],
    ]);
    const rls = model.objects.find((object) => object.ref.kind === "rls");

    expect(errors(model.diagnostics)).toEqual([]);
    expect(rls?.metadata).toMatchObject({ rlsEnabled: true, rlsForced: false });
  });

  it("removes comments through NULL and owning-column drops", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_create.sql",
        "CREATE SCHEMA app;\nCREATE TABLE app.accounts (id bigint, email text);\nCOMMENT ON TABLE app.accounts IS 'accounts';\nCOMMENT ON COLUMN app.accounts.email IS 'email';",
      ],
      [
        "20240102000000_remove.sql",
        "COMMENT ON TABLE app.accounts IS NULL;\nALTER TABLE app.accounts DROP COLUMN email;",
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(model.objects.filter((object) => object.ref.kind === "comment")).toEqual([]);
  });

  it("replays policy drop before recreating the policy name", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_policy_drop.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE POLICY accounts_select ON app.accounts FOR SELECT USING (true);
DROP POLICY accounts_select ON app.accounts;
CREATE POLICY accounts_select ON app.accounts FOR SELECT USING (id IS NOT NULL);`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(table(model, "policy:app.accounts_select:accounts")).toBeDefined();
  });

  it("replays trigger drop before recreating the trigger name", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_trigger_drop.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE FUNCTION app.touch_account() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER accounts_touch BEFORE UPDATE ON app.accounts FOR EACH ROW EXECUTE FUNCTION app.touch_account();
DROP TRIGGER accounts_touch ON app.accounts;
CREATE TRIGGER accounts_touch BEFORE INSERT ON app.accounts FOR EACH ROW EXECUTE FUNCTION app.touch_account();`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(table(model, "trigger:app.accounts_touch:accounts")).toBeDefined();
  });

  it("treats session and role migration statements as no-ops", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_neutral.sql",
        `SET statement_timeout = '5s';
CREATE ROLE app_worker NOLOGIN;
GRANT app_worker TO postgres WITH ADMIN OPTION;
REVOKE app_worker FROM postgres;
CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE POLICY accounts_select ON app.accounts FOR SELECT USING (true);`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(columnNames(table(model, "table:app.accounts"))).toEqual(["id"]);
  });

  it("replays ALTER VIEW security_invoker SET like the equivalent declarative view", async () => {
    const history = await extractMigrations([
      [
        "20240101000000_alter_view.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE VIEW app.account_ids AS SELECT id FROM app.accounts;
ALTER VIEW app.account_ids SET (security_invoker = true);`,
      ],
    ]);
    const declared = await extractDirectory([
      [
        "app.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE VIEW app.account_ids WITH (security_invoker = true) AS SELECT id FROM app.accounts;`,
      ],
    ]);

    expect(errors(history.diagnostics)).toEqual([]);
    expect(errors(declared.diagnostics)).toEqual([]);
    expect(table(history, "view:app.account_ids")?.metadata.securityInvoker).toBe(true);
    expect(table(history, "view:app.account_ids")?.hash).toBe(
      table(declared, "view:app.account_ids")?.hash
    );
    expect(history.fingerprint).toBe(declared.fingerprint);
  });

  it("replays ALTER VIEW security_invoker RESET without retaining stale metadata", async () => {
    const history = await extractMigrations([
      [
        "20240101000000_reset_view.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE VIEW app.account_ids WITH (security_invoker = true) AS SELECT id FROM app.accounts;
ALTER VIEW app.account_ids RESET (security_invoker);`,
      ],
    ]);
    const declared = await extractDirectory([
      [
        "app.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE VIEW app.account_ids AS SELECT id FROM app.accounts;`,
      ],
    ]);

    expect(errors(history.diagnostics)).toEqual([]);
    expect(errors(declared.diagnostics)).toEqual([]);
    expect(table(history, "view:app.account_ids")?.metadata.securityInvoker).toBeUndefined();
    expect(table(history, "view:app.account_ids")?.hash).toBe(
      table(declared, "view:app.account_ids")?.hash
    );
    expect(history.fingerprint).toBe(declared.fingerprint);
  });

  it("applies ALTER VIEW options after CREATE OR REPLACE sequencing", async () => {
    const history = await extractMigrations([
      [
        "20240101000000_replace_view.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE VIEW app.account_ids WITH (security_invoker = true) AS SELECT id FROM app.accounts;
CREATE OR REPLACE VIEW app.account_ids AS SELECT id FROM app.accounts;
ALTER VIEW app.account_ids SET (security_invoker = true);`,
      ],
    ]);
    const declared = await extractDirectory([
      [
        "app.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE VIEW app.account_ids WITH (security_invoker = true) AS SELECT id FROM app.accounts;`,
      ],
    ]);

    expect(errors(history.diagnostics)).toEqual([]);
    expect(history.fingerprint).toBe(declared.fingerprint);
  });

  it("reports missing ALTER VIEW targets as views and honors IF EXISTS", async () => {
    const missing = await extractMigrations([
      ["20240101000000_missing_view.sql", "ALTER VIEW app.missing SET (security_invoker = true);"],
    ]);
    const optional = await extractMigrations([
      [
        "20240101000000_optional_view.sql",
        "ALTER VIEW IF EXISTS app.missing SET (security_invoker = true);",
      ],
    ]);
    const diagnostics = errors(missing.diagnostics);

    expect(diagnostics.map((item) => item.code)).toEqual(["SUPA_REPLAY_ORDER_GAP"]);
    expect(diagnostics[0]?.message).toContain("ALTER VIEW");
    expect(diagnostics[0]?.ref?.kind).toBe("view");
    expect(errors(optional.diagnostics)).toEqual([]);
  });

  it("fails closed for unsupported ALTER VIEW forms", async () => {
    for (const alteration of [
      "ALTER VIEW app.account_ids OWNER TO app_worker;",
      "ALTER VIEW app.account_ids SET (security_barrier = true);",
    ]) {
      const model = await extractMigrations([
        [
          "20240101000000_unsupported_view.sql",
          `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE VIEW app.account_ids AS SELECT id FROM app.accounts;
${alteration}`,
        ],
      ]);

      expect(errors(model.diagnostics).map((item) => item.code)).toContain(
        "SUPA_REPLAY_UNSUPPORTED"
      );
    }
  });

  it("treats duplicate-guarded role-only DO blocks as replay-neutral", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_role.sql",
        `DO $$
BEGIN
  CREATE ROLE app_worker NOLOGIN;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);`,
      ],
    ]);

    expect(errors(model.diagnostics)).toEqual([]);
    expect(model.objects.map((object) => object.key)).toEqual(["schema:app", "table:app.accounts"]);
  });

  it("replays ALTER POLICY TO while preserving both predicates", async () => {
    await expectPolicyReplayMatchesDeclaration(
      `CREATE POLICY accounts_update ON app.accounts FOR UPDATE TO anon
  USING (active)
  WITH CHECK (id > 0);`,
      "ALTER POLICY accounts_update ON app.accounts TO authenticated;",
      `CREATE POLICY accounts_update ON app.accounts FOR UPDATE TO authenticated
  USING (active)
  WITH CHECK (id > 0);`
    );
  });

  it("replays ALTER POLICY USING while preserving roles and WITH CHECK", async () => {
    await expectPolicyReplayMatchesDeclaration(
      `CREATE POLICY accounts_update ON app.accounts FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (active);`,
      "ALTER POLICY accounts_update ON app.accounts USING (id IS NOT NULL);",
      `CREATE POLICY accounts_update ON app.accounts FOR UPDATE TO authenticated
  USING (id IS NOT NULL)
  WITH CHECK (active);`
    );
  });

  it("replays ALTER POLICY WITH CHECK while preserving roles and USING", async () => {
    await expectPolicyReplayMatchesDeclaration(
      `CREATE POLICY accounts_update ON app.accounts FOR UPDATE TO authenticated
  USING (id IS NOT NULL)
  WITH CHECK (true);`,
      "ALTER POLICY accounts_update ON app.accounts WITH CHECK (active AND id > 0);",
      `CREATE POLICY accounts_update ON app.accounts FOR UPDATE TO authenticated
  USING (id IS NOT NULL)
  WITH CHECK (active AND id > 0);`
    );
  });

  it("replays ALTER POLICY TO PUBLIC while preserving both predicates", async () => {
    await expectPolicyReplayMatchesDeclaration(
      `CREATE POLICY accounts_update ON app.accounts FOR UPDATE TO authenticated
  USING (active)
  WITH CHECK (id > 0);`,
      "ALTER POLICY accounts_update ON app.accounts TO PUBLIC;",
      `CREATE POLICY accounts_update ON app.accounts FOR UPDATE TO PUBLIC
  USING (active)
  WITH CHECK (id > 0);`
    );
  });

  it("reports an order gap when ALTER POLICY targets a missing policy", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_alter_policy.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
ALTER POLICY accounts_select ON app.accounts USING (id IS NOT NULL);`,
      ],
    ]);

    expect(model.objects).toEqual([]);
    expect(errors(model.diagnostics).map((item) => item.code)).toEqual(["SUPA_REPLAY_ORDER_GAP"]);
  });

  it("fails closed for ALTER POLICY rename", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_rename_policy.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE POLICY accounts_select ON app.accounts USING (id IS NOT NULL);
ALTER POLICY accounts_select ON app.accounts RENAME TO accounts_read;`,
      ],
    ]);

    expect(model.objects).toEqual([]);
    expect(errors(model.diagnostics).map((item) => item.code)).toEqual(["SUPA_REPLAY_UNSUPPORTED"]);
    expect(errors(model.diagnostics)[0]?.message).toContain("OBJECT_POLICY");
  });

  it("replays constraint validation to the same end state as an initially valid constraint", async () => {
    const history = await extractMigrations([
      [
        "20240101000000_validate.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.parents (id integer PRIMARY KEY);
CREATE TABLE app.children (parent_id integer);
ALTER TABLE app.children ADD CONSTRAINT children_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES app.parents(id) NOT VALID;
ALTER TABLE app.children VALIDATE CONSTRAINT children_parent_id_fkey;`,
      ],
    ]);
    const declared = await extractDirectory([
      [
        "app.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.parents (id integer PRIMARY KEY);
CREATE TABLE app.children (parent_id integer);
ALTER TABLE app.children ADD CONSTRAINT children_parent_id_fkey
  FOREIGN KEY (parent_id) REFERENCES app.parents(id);`,
      ],
    ]);

    expect(errors(history.diagnostics)).toEqual([]);
    expect(errors(declared.diagnostics)).toEqual([]);
    expect(history.fingerprint).toBe(declared.fingerprint);
  });

  it("hard-fails validation when the target constraint is absent", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_validate_missing.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.children (parent_id integer);
ALTER TABLE app.children VALIDATE CONSTRAINT children_parent_id_fkey;`,
      ],
    ]);

    expect(model.objects).toEqual([]);
    expect(errors(model.diagnostics).map((item) => item.code)).toEqual(["SUPA_REPLAY_ORDER_GAP"]);
  });

  it("consumes a unique backing index when attaching it as a table constraint", async () => {
    const history = await extractMigrations([
      [
        "20240101000000_using_index.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
CREATE UNIQUE INDEX accounts_id_key ON app.accounts (id);
ALTER TABLE app.accounts ADD CONSTRAINT accounts_id_key UNIQUE USING INDEX accounts_id_key;`,
      ],
    ]);
    const declared = await extractDirectory([
      [
        "app.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
ALTER TABLE app.accounts ADD CONSTRAINT accounts_id_key UNIQUE (id);`,
      ],
    ]);

    expect(errors(history.diagnostics)).toEqual([]);
    expect(errors(declared.diagnostics)).toEqual([]);
    expect(history.objects.some((object) => object.ref.kind === "index")).toBe(false);
    expect(history.fingerprint).toBe(declared.fingerprint);
  });

  it("uses the backing index name for an unnamed attached constraint", async () => {
    const history = await extractMigrations([
      [
        "20240101000000_using_index.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (email text);
CREATE UNIQUE INDEX accounts_email_idx ON app.accounts (email);
ALTER TABLE app.accounts ADD UNIQUE USING INDEX accounts_email_idx;`,
      ],
    ]);
    const declared = await extractDirectory([
      [
        "app.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (email text);
ALTER TABLE app.accounts ADD CONSTRAINT accounts_email_idx UNIQUE (email);`,
      ],
    ]);

    expect(errors(history.diagnostics)).toEqual([]);
    expect(errors(declared.diagnostics)).toEqual([]);
    expect(history.objects.some((object) => object.ref.kind === "index")).toBe(false);
    expect(history.fingerprint).toBe(declared.fingerprint);
  });

  it("hard-fails a constraint attachment when its backing index is absent", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_using_missing_index.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
ALTER TABLE app.accounts ADD CONSTRAINT accounts_id_key UNIQUE USING INDEX accounts_id_key;`,
      ],
    ]);

    expect(model.objects).toEqual([]);
    expect(errors(model.diagnostics).map((item) => item.code)).toEqual(["SUPA_REPLAY_ORDER_GAP"]);
  });

  it("unions split grants that share one replay identity", async () => {
    const files: [string, string][] = [
      [
        "20240101000000_split_grant.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.sessions (id integer, token text);
GRANT INSERT ON app.sessions TO app_worker;
GRANT SELECT(id, token) ON app.sessions TO app_worker;`,
      ],
    ];
    const model = await extractMigrations(files);
    const declared = await extractDirectory(files);

    expect(errors(model.diagnostics)).toEqual([]);
    const grants = model.objects.filter((object) => object.ref.kind === "grant");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.metadata.privileges).toEqual(["INSERT", "SELECT"]);
    expect(grants[0]?.metadata.columnPrivileges).toEqual({
      SELECT: ["id", "token"],
    });
    expect(grants[0]?.sql).toBe(
      'GRANT INSERT, SELECT ("id", "token") ON TABLE "app"."sessions" TO "app_worker"'
    );
    expect(model.fingerprint).toBe(declared.fingerprint);
  });

  it("replays a covering revoke followed by a re-grant as the re-granted state", async () => {
    const files: [string, string][] = [
      [
        "20240101000000_grant.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.sessions (id integer, token text);
GRANT INSERT, SELECT, UPDATE ON app.sessions TO app_worker;`,
      ],
      [
        "20240102000000_regrant.sql",
        `REVOKE INSERT, SELECT, UPDATE ON app.sessions FROM app_worker;
GRANT INSERT, SELECT (id, token), UPDATE (token) ON app.sessions TO app_worker;`,
      ],
    ];
    const model = await extractMigrations(files);
    const declared = await extractDirectory(files);

    expect(errors(model.diagnostics)).toEqual([]);
    const grants = model.objects.filter((object) => object.ref.kind === "grant");
    expect(grants).toHaveLength(1);
    expect(grants[0]?.metadata.verb).toBe("GRANT");
    expect(grants[0]?.metadata.privileges).toEqual(["INSERT", "SELECT", "UPDATE"]);
    expect(grants[0]?.metadata.columnPrivileges).toEqual({
      SELECT: ["id", "token"],
      UPDATE: ["token"],
    });
    expect(model.fingerprint).toBe(declared.fingerprint);
  });

  it("hard-fails unsupported ALTER TABLE subtypes", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_unsupported_alter.sql",
        `CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);
ALTER TABLE app.accounts ALTER COLUMN id SET STATISTICS 100;`,
      ],
    ]);

    expect(model.objects).toEqual([]);
    expect(errors(model.diagnostics).map((item) => item.code)).toEqual(["SUPA_REPLAY_UNSUPPORTED"]);
  });

  it("hard-fails unsupported top-level statements", async () => {
    const model = await extractMigrations([
      [
        "20240101000000_listen.sql",
        `LISTEN app_channel;
CREATE SCHEMA app;
CREATE TABLE app.accounts (id integer);`,
      ],
    ]);

    expect(model.objects).toEqual([]);
    expect(errors(model.diagnostics).map((item) => item.code)).toEqual(["SUPA_REPLAY_UNSUPPORTED"]);
  });

  it("hard-fails a missing migrations directory with a named ordering diagnostic", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-replay-missing-"));
    const missing = join(root, "missing");
    const model = await extractSourceModel(`migrations:${missing}`, {
      config: resolveConfig(),
    });

    expect(model.objects).toEqual([]);
    expect(errors(model.diagnostics).map((item) => item.code)).toEqual(["SUPA_REPLAY_ORDER_GAP"]);
  });
});
