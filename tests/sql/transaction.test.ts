import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, test } from "vitest";
import { checkMigrationSql } from "../../src/check/migration.js";
import { resolveDatabaseUrl } from "../../src/database/url.js";
import { extractSourceModel } from "../../src/source/extract.js";
import { verifyMigration } from "../../src/verify/migration.js";

const databaseUrl = process.env.SUPASCHEMA_TEST_DATABASE_URL ?? resolveDatabaseUrl();

const enumHazardMigration = `SET lock_timeout = '5s';
ALTER TYPE app.mood ADD VALUE IF NOT EXISTS 'curious';
ALTER TABLE app.entries ADD COLUMN IF NOT EXISTS fallback app.mood DEFAULT 'curious'::app.mood;
`;

describe("enum value same-transaction hazard", () => {
  it("flags later use of an enum value added in the same migration", async () => {
    const diagnostics = await checkMigrationSql(enumHazardMigration);

    const hazard = diagnostics.find(
      (item) => item.code === "SUPA_CHECK_ENUM_VALUE_USE_SAME_TRANSACTION"
    );
    expect(hazard?.severity).toBe("error");
  });

  it("downgrades the hazard to a warning in per-statement mode", async () => {
    const diagnostics = await checkMigrationSql(enumHazardMigration, {
      config: { transactionMode: "per-statement" },
    });

    const hazard = diagnostics.find(
      (item) => item.code === "SUPA_CHECK_ENUM_VALUE_USE_SAME_TRANSACTION"
    );
    expect(hazard?.severity).toBe("warning");
  });

  it("does not flag migrations that only add the value", async () => {
    const diagnostics = await checkMigrationSql(
      "ALTER TYPE app.mood ADD VALUE IF NOT EXISTS 'curious';"
    );

    expect(
      diagnostics.some((item) => item.code === "SUPA_CHECK_ENUM_VALUE_USE_SAME_TRANSACTION")
    ).toBe(false);
  });
});

describe("nontransactional statement escalation", () => {
  it("escalates CREATE INDEX CONCURRENTLY to an error under the default config", async () => {
    const diagnostics = await checkMigrationSql(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS items_idx ON app.items (id);"
    );

    const finding = diagnostics.find((item) => item.code === "SUPA_CHECK_NONTRANSACTIONAL_INDEX");
    expect(finding?.severity).toBe("error");
  });

  it("keeps the warning severity for per-statement runners", async () => {
    const diagnostics = await checkMigrationSql(
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS items_idx ON app.items (id);",
      { config: { transactionMode: "per-statement" } }
    );

    const finding = diagnostics.find((item) => item.code === "SUPA_CHECK_NONTRANSACTIONAL_INDEX");
    expect(finding?.severity).toBe("warning");
  });
});

describe("config model filters", () => {
  it("filters schemas and excluded grant roles from extracted models", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supa-filters-"));
    await writeFile(
      join(directory, "schema.sql"),
      [
        "CREATE SCHEMA app;",
        "CREATE SCHEMA reporting;",
        "CREATE TABLE app.accounts (id integer);",
        "CREATE TABLE reporting.rollups (id integer);",
        "GRANT SELECT ON TABLE app.accounts TO supabase_admin;",
        "GRANT SELECT ON TABLE app.accounts TO app_user;",
      ].join("\n")
    );
    const model = await extractSourceModel(`dir:${directory}`, {
      config: {
        excludedGrantRoles: ["supabase_admin"],
        schemas: { exclude: [], include: ["app"] },
      },
    });

    const keys = model.objects.map((object) => object.key);
    expect(keys).toContain("table:app.accounts");
    expect(keys).not.toContain("table:reporting.rollups");
    expect(keys.some((key) => key.includes("supabase_admin"))).toBe(false);
    expect(keys.some((key) => key.includes("app_user"))).toBe(true);
  });
});

describe("Supabase view security_invoker policy", () => {
  it("warns for public views without security_invoker when Supabase-managed surfaces are configured", async () => {
    const directory = await mkdtemp(join(tmpdir(), "supa-secinv-"));
    await writeFile(
      join(directory, "views.sql"),
      [
        "CREATE VIEW public.exposed AS SELECT 1 AS one;",
        "CREATE VIEW public.safe WITH (security_invoker = true) AS SELECT 1 AS one;",
      ].join("\n")
    );
    const checked = await extractSourceModel(`dir:${directory}`, {
      config: { managedSchemas: ["auth", "storage"] },
    });

    const warnings = checked.diagnostics.filter(
      (item) => item.code === "SUPA_SUPABASE_VIEW_SECURITY_INVOKER"
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.ref?.name).toBe("exposed");
  });
});

describe.skipIf(!databaseUrl)("transactional verify fidelity", () => {
  test("fails per-migration verify for enum add-then-use and passes per-statement", {
    timeout: 60_000,
  }, async () => {
    if (!databaseUrl) {
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "supa-enum-verify-"));
    const fromSql = [
      "CREATE SCHEMA app;",
      "CREATE TYPE app.mood AS ENUM ('happy', 'sad');",
      "CREATE TABLE app.entries (id integer, current app.mood);",
    ].join("\n");
    const toSql = [
      "CREATE SCHEMA app;",
      "CREATE TYPE app.mood AS ENUM ('happy', 'sad', 'curious');",
      "CREATE TABLE app.entries (id integer, current app.mood);",
    ].join("\n");
    await writeFile(join(directory, "from.sql"), fromSql);
    await writeFile(join(directory, "to.sql"), toSql);
    const migrationPath = join(directory, "migration.sql");
    await writeFile(
      migrationPath,
      "ALTER TYPE app.mood ADD VALUE IF NOT EXISTS 'curious';\nINSERT INTO app.entries (id, current) VALUES (1, 'curious'::app.mood) ON CONFLICT DO NOTHING;\n"
    );

    const perMigration = await verifyMigration({
      config: { transactionMode: "per-migration" },
      databaseUrl,
      from: `dump:${join(directory, "from.sql")}`,
      migrationPath,
      to: `dump:${join(directory, "to.sql")}`,
    });
    expect(perMigration.some((item) => item.severity === "error")).toBe(true);

    const perStatement = await verifyMigration({
      config: { transactionMode: "per-statement" },
      databaseUrl,
      from: `dump:${join(directory, "from.sql")}`,
      migrationPath,
      to: `dump:${join(directory, "to.sql")}`,
    });

    expect(perStatement.filter((item) => item.severity === "error")).toEqual([]);
  });
});
