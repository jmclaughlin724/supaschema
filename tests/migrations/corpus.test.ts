import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/schema.js";
import { readMigrationContext } from "../../src/migrations/context.js";
import { buildSchemaDiffPlan } from "../../src/pipeline/diff.js";
import { planSchemaDiff } from "../../src/planner/schema.js";
import { renderMigration } from "../../src/render/migration.js";
import { extractSourceModel } from "../../src/source/extract.js";

describe("migration-derived source corpus", () => {
  it("uses existing migrations to release reviewed column drops", async () => {
    const root = await migrationCorpusFixture({
      migrationSql: `
        DROP FUNCTION app.legacy_secret(p_ciphertext bytea);
        UPDATE app.credentials SET encrypted_value = encrypted_value;
        ALTER TABLE app.credentials DROP COLUMN encrypted_value;
      `,
    });

    const plan = await buildSchemaDiffPlan({
      checkMigrationBaseline: false,
      config: resolveConfig({
        migrationsDir: "migrations",
        schemaPaths: ["to"],
      }),
      cwd: root,
      from: "dir:from",
      schema: "app",
      to: "dir:to",
    });

    expect(plan.diagnostics.map((item) => item.code)).not.toContain(
      "SUPA_PLAN_COLUMN_ALTER_HINT_REQUIRED"
    );
    expect(
      plan.operations.find((operation) => operation.key === "table:app.credentials")
    ).toMatchObject({
      blocked: false,
      destructive: true,
    });
    expect(
      plan.operations.find((operation) => operation.key === "function:app.legacy_secret(bytea)")
    ).toMatchObject({
      blocked: false,
      destructive: true,
    });

    const sql = renderMigration(plan, { includeHeader: false });
    expect(sql).toContain('"disposition":"migration-intent"');
    expect(sql).toContain('"key":"table:app.credentials"');
    expect(sql).toContain('"key":"function:app.legacy_secret(bytea)"');
  });

  it("does not plan independent grant cleanup for dropped function targets", async () => {
    const root = await migrationCorpusFixture({ migrationSql: "" });

    const plan = await buildSchemaDiffPlan({
      checkMigrationBaseline: false,
      config: resolveConfig({
        migrationsDir: "migrations",
        schemaPaths: ["to"],
      }),
      cwd: root,
      from: "dir:from",
      schema: "app",
      to: "dir:to",
    });

    expect(plan.operations.map((operation) => operation.key)).not.toContain(
      "grant:app.revoke:function:app.legacy_secret(bytea):PUBLIC"
    );
  });

  it("reapplies retained PUBLIC revokes after dropping and recreating a function", async () => {
    const root = await migrationCorpusFixture({ migrationSql: "" });
    await writeFile(
      join(root, "to", "schema.sql"),
      `
        CREATE SCHEMA app;
        CREATE TABLE app.credentials (
          id uuid PRIMARY KEY,
          encrypted_value bytea
        );
        CREATE FUNCTION app.legacy_secret(p_ciphertext bytea)
        RETURNS bytea
        LANGUAGE sql
        AS $$ SELECT p_ciphertext $$;
        REVOKE ALL ON FUNCTION app.legacy_secret(p_ciphertext bytea) FROM PUBLIC;
      `
    );

    const plan = await buildSchemaDiffPlan({
      checkMigrationBaseline: false,
      config: resolveConfig({
        hints: { destructive: ["function:app.legacy_secret(bytea)"] },
        migrationsDir: "migrations",
        schemaPaths: ["to"],
      }),
      cwd: root,
      from: "dir:from",
      schema: "app",
      to: "dir:to",
    });

    const sql = renderMigration(plan, { includeHeader: false });
    const drop = sql.indexOf('DROP FUNCTION IF EXISTS "app"."legacy_secret"');
    const create = sql.indexOf("CREATE OR REPLACE FUNCTION app.legacy_secret");
    const revoke = sql.indexOf('REVOKE ALL ON FUNCTION "app"."legacy_secret"');
    expect(drop).toBeGreaterThanOrEqual(0);
    expect(create).toBeGreaterThan(drop);
    expect(revoke).toBeGreaterThan(create);
    expect(sql.split("REVOKE ALL ON FUNCTION")).toHaveLength(2);
  });

  it("re-applies only declared revokes whose grantee still holds EXECUTE after a drop and recreate lost them", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-routine-privilege-drift-"));
    await writeFile(
      join(root, "schema.sql"),
      `
        CREATE SCHEMA app;
        CREATE FUNCTION app.store_secret(p_id uuid, p_at timestamptz)
        RETURNS uuid
        LANGUAGE sql
        AS $$ SELECT p_id $$;
        REVOKE ALL ON FUNCTION app.store_secret(p_id uuid, p_at timestamptz) FROM PUBLIC, anon;
        GRANT EXECUTE ON FUNCTION app.store_secret(p_id uuid, p_at timestamptz) TO service_role;
        CREATE FUNCTION app.public_ping() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
        CREATE FUNCTION app.revoked_ping() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
        REVOKE ALL ON FUNCTION app.revoked_ping() FROM PUBLIC;
      `
    );
    const lineageBaseline = await extractSourceModel(`dir:${root}`);
    const appliedRoutineExecuteGrantees = new Map([
      ["app.store_secret(uuid, timestamp with time zone)", new Set(["PUBLIC", "service_role"])],
      ["app.public_ping()", new Set(["PUBLIC"])],
    ]);

    expect(planSchemaDiff(lineageBaseline, lineageBaseline).operations).toEqual([]);
    const plan = planSchemaDiff(lineageBaseline, lineageBaseline, {
      appliedRoutineExecuteGrantees,
    });

    const revokeKey =
      "grant:app.revoke:function:app.store_secret(uuid, timestamp with time zone):PUBLIC";
    expect(plan.operations.map((operation) => [operation.kind, operation.key])).toEqual([
      ["create", revokeKey],
    ]);
    expect(plan.diagnostics.filter((item) => item.code === "SUPA_ROUTINE_PRIVILEGE_DRIFT")).toEqual(
      [
        expect.objectContaining({
          ref: expect.objectContaining({ kind: "grant" }),
          severity: "warning",
        }),
      ]
    );
    expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const sql = renderMigration(plan, { includeHeader: false });
    expect(sql).toContain(
      'REVOKE ALL ON FUNCTION "app"."store_secret"(uuid, timestamp with time zone) FROM PUBLIC'
    );
    expect(sql.split("REVOKE ")).toHaveLength(2);
    expect(sql).not.toContain("service_role");
    expect(sql).not.toContain("anon");
  });

  it("re-applies a named-role routine revoke that source normalization nets away", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-routine-named-revoke-"));
    await writeFile(
      join(root, "schema.sql"),
      `
        CREATE SCHEMA app;
        CREATE FUNCTION app.lookup() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
        REVOKE ALL ON FUNCTION app.lookup() FROM anon;
        CREATE FUNCTION app.regranted() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$;
        REVOKE ALL ON FUNCTION app.regranted() FROM anon;
        GRANT EXECUTE ON FUNCTION app.regranted() TO anon;
      `
    );
    const lineageBaseline = await extractSourceModel(`dir:${root}`);
    const appliedRoutineExecuteGrantees = new Map([
      ["app.lookup()", new Set(["PUBLIC", "anon"])],
      ["app.regranted()", new Set(["PUBLIC", "anon"])],
    ]);

    expect(planSchemaDiff(lineageBaseline, lineageBaseline).operations).toEqual([]);
    const plan = planSchemaDiff(lineageBaseline, lineageBaseline, {
      appliedRoutineExecuteGrantees,
    });

    expect(plan.operations.map((operation) => [operation.kind, operation.key])).toEqual([
      ["create", "grant:app.revoke:function:app.lookup():anon"],
    ]);
    expect(
      plan.diagnostics.filter((item) => item.code === "SUPA_ROUTINE_PRIVILEGE_DRIFT")
    ).toHaveLength(1);
    const sql = renderMigration(plan, { includeHeader: false });
    expect(sql).toContain('REVOKE ALL ON FUNCTION "app"."lookup"() FROM');
    expect(sql).not.toContain("regranted");
  });

  it("blocks the plan when the applied routine privilege database cannot be read", async () => {
    const root = await migrationCorpusFixture({ migrationSql: "" });

    const plan = await buildSchemaDiffPlan({
      checkMigrationBaseline: false,
      config: resolveConfig({ migrationsDir: "migrations", schemaPaths: ["to"] }),
      cwd: root,
      from: "dir:from",
      routinePrivilegeDatabaseUrl: "postgresql://supaschema@127.0.0.1:1/unreachable",
      schema: "app",
      to: "dir:to",
    });

    expect(plan.operations).toEqual([]);
    expect(plan.diagnostics).toContainEqual(
      expect.objectContaining({ code: "SUPA_CATALOG_EXTRACT_FAILED", severity: "error" })
    );
  });

  it("still blocks column drops when existing migrations do not declare them", async () => {
    const root = await migrationCorpusFixture({ migrationSql: "" });

    const plan = await buildSchemaDiffPlan({
      checkMigrationBaseline: false,
      config: resolveConfig({
        migrationsDir: "migrations",
        schemaPaths: ["to"],
      }),
      cwd: root,
      from: "dir:from",
      schema: "app",
      to: "dir:to",
    });

    expect(plan.diagnostics.map((item) => item.code)).toContain(
      "SUPA_PLAN_COLUMN_ALTER_HINT_REQUIRED"
    );
  });

  it("blocks storage transitions when the corpus lacks reviewed data movement intent", async () => {
    const root = await migrationCorpusFixture({
      migrationSql: "ALTER TABLE app.credentials DROP COLUMN encrypted_value;",
    });

    const plan = await buildSchemaDiffPlan({
      checkMigrationBaseline: false,
      config: resolveConfig({
        migrationsDir: "migrations",
        schemaPaths: ["to"],
      }),
      cwd: root,
      from: "dir:from",
      schema: "app",
      to: "dir:to",
    });

    expect(plan.diagnostics.map((item) => item.code)).toContain(
      "SUPA_PLAN_DATA_TRANSITION_REQUIRED"
    );
    expect(
      plan.operations.find((operation) => operation.key === "table:app.credentials")
    ).toMatchObject({
      blocked: true,
    });
  });

  it("does not use unrelated data statements as storage transition proof", async () => {
    const root = await migrationCorpusFixture({
      migrationSql: `
        INSERT INTO app.audit_log (id) VALUES (1);
        ALTER TABLE app.credentials DROP COLUMN encrypted_value;
      `,
    });

    const plan = await buildSchemaDiffPlan({
      checkMigrationBaseline: false,
      config: resolveConfig({
        migrationsDir: "migrations",
        schemaPaths: ["to"],
      }),
      cwd: root,
      from: "dir:from",
      schema: "app",
      to: "dir:to",
    });

    expect(plan.diagnostics.map((item) => item.code)).toContain(
      "SUPA_PLAN_DATA_TRANSITION_REQUIRED"
    );
  });

  it("uses the selected migrations directory for source intent", async () => {
    const root = await migrationCorpusFixture({ migrationSql: "" });
    await mkdir(join(root, "selected-migrations"), { recursive: true });
    await writeFile(
      join(root, "selected-migrations", "20260102000000_existing.sql"),
      "UPDATE app.credentials SET encrypted_value = encrypted_value;\nALTER TABLE app.credentials DROP COLUMN encrypted_value;"
    );

    const plan = await buildSchemaDiffPlan({
      checkMigrationBaseline: false,
      config: resolveConfig({
        migrationsDir: "migrations",
        schemaPaths: ["to"],
      }),
      cwd: root,
      from: "dir:from",
      migrationsDir: "selected-migrations",
      schema: "app",
      to: "dir:to",
    });

    expect(plan.diagnostics.map((item) => item.code)).not.toContain(
      "SUPA_PLAN_COLUMN_ALTER_HINT_REQUIRED"
    );
    expect(
      plan.operations.find((operation) => operation.key === "table:app.credentials")
    ).toMatchObject({
      blocked: false,
      metadata: expect.objectContaining({
        destructiveDisposition: "migration-intent",
      }),
    });
  });

  it("does not use stale config-dir intent when a different migrations directory is selected", async () => {
    const root = await migrationCorpusFixture({
      migrationSql: "ALTER TABLE app.credentials DROP COLUMN encrypted_value;",
    });
    await mkdir(join(root, "selected-migrations"), { recursive: true });

    const plan = await buildSchemaDiffPlan({
      checkMigrationBaseline: false,
      config: resolveConfig({
        migrationsDir: "migrations",
        schemaPaths: ["to"],
      }),
      cwd: root,
      from: "dir:from",
      migrationsDir: "selected-migrations",
      schema: "app",
      to: "dir:to",
    });

    expect(plan.diagnostics.map((item) => item.code)).toContain(
      "SUPA_PLAN_COLUMN_ALTER_HINT_REQUIRED"
    );
  });

  it("does not promote migration-corpus parse failures to plan errors", async () => {
    const root = await migrationCorpusFixture({ migrationSql: "CREATE TABLE" });

    const { corpus } = await readMigrationContext("migrations", { cwd: root });

    expect(corpus.diagnostics).toEqual([
      expect.objectContaining({
        code: "SUPA_MIGRATION_CORPUS_PARSE_SKIPPED",
        severity: "warning",
      }),
    ]);
  });

  it("treats standard DROP ROUTINE as function and procedure destructive intent", async () => {
    const root = await migrationCorpusFixture({
      migrationSql: "DROP ROUTINE app.legacy_secret(bytea);",
    });

    const { corpus } = await readMigrationContext("migrations", { cwd: root });

    expect(corpus.destructiveKeys).toContain("function:app.legacy_secret(bytea)");
    expect(corpus.destructiveKeys).toContain("procedure:app.legacy_secret(bytea)");
  });

  it("records data, DO, generated, identity, default, constraint, type, index, and enum source facts", async () => {
    const root = await migrationCorpusFixture({
      migrationSql: `
        DO $$ begin perform 1; end $$;
        INSERT INTO app.credentials (id) VALUES (1) ON CONFLICT DO NOTHING;
        ALTER TYPE app.status ADD VALUE IF NOT EXISTS 'active';
        ALTER TABLE app.credentials ALTER COLUMN encrypted_value TYPE text;
        ALTER TABLE app.credentials ALTER COLUMN encrypted_value SET DEFAULT '';
        ALTER TABLE app.credentials ALTER COLUMN encrypted_value ADD GENERATED ALWAYS AS IDENTITY;
        ALTER TABLE app.credentials ALTER COLUMN encrypted_value DROP EXPRESSION IF EXISTS;
        ALTER TABLE app.credentials ADD CONSTRAINT credentials_id_check CHECK (id > 0);
        CREATE INDEX IF NOT EXISTS credentials_id_idx ON app.credentials (id);
      `,
    });

    const { corpus } = await readMigrationContext("migrations", { cwd: root });
    const kinds = corpus.operations.map((operation) => operation.kind);

    expect(kinds).toEqual(
      expect.arrayContaining([
        "constraint",
        "data-statement",
        "do-block",
        "enum-rewrite",
        "index",
        "table-column-default",
        "table-column-generated",
        "table-column-identity",
        "table-column-type",
      ])
    );
  });

  it("tracks generated lineage as baseline proof and later hand-authored files as unproven", async () => {
    const root = await migrationCorpusFixture({
      migrationSql: "-- supaschema: lineage from=abc to=def\nSELECT 1;",
    });
    await writeFile(join(root, "migrations", "20260102000000_hand.sql"), "SELECT 2;");

    const context = await readMigrationContext("migrations", { cwd: root });

    expect(context.latestGeneratedBaseline).toMatchObject({
      fingerprint: "def",
      source: "migration-baseline:migrations@20260101000000",
      version: "20260101000000",
    });
    expect(context.unprovenBaselineFiles.map((file) => basename(file))).toEqual([
      "20260102000000_hand.sql",
    ]);
  });
});

async function migrationCorpusFixture(options: { migrationSql: string }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "supa-migration-corpus-"));
  await mkdir(join(root, "from"), { recursive: true });
  await mkdir(join(root, "to"), { recursive: true });
  await mkdir(join(root, "migrations"), { recursive: true });
  await writeFile(
    join(root, "from", "schema.sql"),
    `
      CREATE SCHEMA app;
      CREATE TABLE app.credentials (
        id uuid PRIMARY KEY,
        encrypted_value bytea
      );
      CREATE FUNCTION app.legacy_secret(p_ciphertext bytea)
      RETURNS text
      LANGUAGE sql
      AS $$ SELECT encode(p_ciphertext, 'hex') $$;
      REVOKE ALL ON FUNCTION app.legacy_secret(p_ciphertext bytea) FROM PUBLIC;
    `
  );
  await writeFile(
    join(root, "to", "schema.sql"),
    `
      CREATE SCHEMA app;
      CREATE TABLE app.credentials (
        id uuid PRIMARY KEY,
        secret_id uuid
      );
    `
  );
  await writeFile(join(root, "migrations", "20260101000000_existing.sql"), options.migrationSql);
  return root;
}
