import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it, test } from "vitest";
import { resolveDatabaseUrl } from "../../src/database/url.js";
import {
  buildSupabaseCliCommand,
  groupMigrationUnits,
  runDirectMigrationRunner,
} from "../../src/migrations/runners.js";

const databaseUrl = process.env.SUPASCHEMA_TEST_DATABASE_URL ?? resolveDatabaseUrl();

async function migrationDir(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "supa-runner-"));
  for (const [file, sql] of Object.entries(files)) {
    await writeFile(join(root, file), sql);
  }
  return root;
}

describe("migration runner planning", () => {
  it("groups concurrent companions into one non-transactional unit", () => {
    expect(
      groupMigrationUnits(
        ["20260101000000_one.concurrent.sql", "20260101000000_one.sql"],
        "per-migration"
      )
    ).toEqual([
      {
        files: ["20260101000000_one.sql", "20260101000000_one.concurrent.sql"],
        transactional: false,
        version: "20260101000000",
      },
    ]);
  });

  it("marks per-statement units as non-transactional", () => {
    expect(groupMigrationUnits(["20260101000000_one.sql"], "per-statement")).toEqual([
      {
        files: ["20260101000000_one.sql"],
        transactional: false,
        version: "20260101000000",
      },
    ]);
  });

  it("builds redacted Supabase CLI commands with target URLs", () => {
    const command = buildSupabaseCliCommand({
      databaseUrl: "postgresql://postgres:secret@example.test/postgres",
      operation: "remote",
    });

    expect(command.args).toEqual([
      "db",
      "push",
      "--db-url",
      "postgresql://postgres:secret@example.test/postgres",
    ]);
    expect(command.displayCommand).toContain("supabase db push --db-url");
    expect(command.displayCommand).not.toContain("secret");
  });
});

describe.skipIf(!databaseUrl)("direct PostgreSQL migration runner", () => {
  test("applies pending files and records migration history", { timeout: 30_000 }, async () => {
    await withTempDatabase(async (url) => {
      const root = await migrationDir({
        "20260101000000_one.sql": `
CREATE SCHEMA app;
CREATE TABLE app.runner_ok (id bigint PRIMARY KEY);
`,
      });

      const result = await runDirectMigrationRunner({
        databaseUrl: url,
        directory: root,
        historyTable: "supaschema_migrations.schema_migrations",
        pending: ["20260101000000_one.sql"],
        transactionMode: "per-migration",
      });

      expect(result.ok).toBe(true);
      expect(result.ok ? result.appliedVersions : []).toEqual(["20260101000000"]);
      expect(await queryScalar(url, "select to_regclass('app.runner_ok')::text")).toBe(
        "app.runner_ok"
      );
      expect(
        await queryScalar(url, "select version from supaschema_migrations.schema_migrations")
      ).toBe("20260101000000");
    });
  });

  test("rolls back transactional migration SQL and does not insert history on failure", async () => {
    await withTempDatabase(async (url) => {
      const root = await migrationDir({
        "20260101000000_bad.sql": `
CREATE SCHEMA app;
CREATE TABLE app.runner_bad (id bigint PRIMARY KEY);
SELECT missing_function();
`,
      });

      const result = await runDirectMigrationRunner({
        databaseUrl: url,
        directory: root,
        historyTable: "supaschema_migrations.schema_migrations",
        pending: ["20260101000000_bad.sql"],
        transactionMode: "per-migration",
      });

      expect(result.ok).toBe(false);
      expect(await queryScalar(url, "select to_regclass('app.runner_bad')::text")).toBe(null);
      expect(
        await queryScalar(url, "select count(*)::int from supaschema_migrations.schema_migrations")
      ).toBe(0);
    });
  });

  test("applies concurrent companions outside the transaction and records one version", async () => {
    await withTempDatabase(async (url) => {
      const root = await migrationDir({
        "20260101000000_concurrent.concurrent.sql":
          "CREATE INDEX CONCURRENTLY runner_concurrent_id_idx ON app.runner_concurrent (id);\n",
        "20260101000000_concurrent.sql": `
CREATE SCHEMA app;
CREATE TABLE app.runner_concurrent (id bigint PRIMARY KEY);
`,
      });

      const result = await runDirectMigrationRunner({
        databaseUrl: url,
        directory: root,
        historyTable: "supaschema_migrations.schema_migrations",
        pending: ["20260101000000_concurrent.sql", "20260101000000_concurrent.concurrent.sql"],
        transactionMode: "per-migration",
      });

      expect(result.ok).toBe(true);
      expect(
        await queryScalar(url, "select to_regclass('app.runner_concurrent_id_idx')::text")
      ).toBe("app.runner_concurrent_id_idx");
      expect(
        await queryScalar(
          url,
          "select count(*)::int from supaschema_migrations.schema_migrations where version = '20260101000000'"
        )
      ).toBe(1);
    });
  });
});

async function withTempDatabase(callback: (url: string) => Promise<void>): Promise<void> {
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  const db = `supa_runner_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
  await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${db}`);
  const url = new URL(databaseUrl);
  url.pathname = `/${db}`;
  try {
    await callback(url.toString());
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.end();
  }
}

async function queryScalar(databaseUrl: string, sql: string): Promise<null | number | string> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const result = await client.query<{ value: null | number | string }>(
      `select (${sql}) as value`
    );
    return result.rows[0]?.value ?? null;
  } finally {
    await client.end();
  }
}
