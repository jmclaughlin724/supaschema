import { describe, expect, test } from "vitest";
import { checkMigrationSql } from "../../src/check/migration.js";
import { resolveDatabaseUrl } from "../../src/database/url.js";
import { planSchemaDiff } from "../../src/planner/schema.js";
import { renderMigration } from "../../src/render/migration.js";
import { extractSourceModel } from "../../src/source/extract.js";
import { parseSqlAst } from "../../src/sql/parser.js";
import type { SupaschemaConfig } from "../../src/types.js";
import { verifyMigration } from "../../src/verify/migration.js";
import { hasUnqualifiedCatalogName, hasUnqualifiedRegproc } from "../catalog/qualification.js";

const databaseUrl = process.env.SUPASCHEMA_TEST_DATABASE_URL ?? resolveDatabaseUrl();

interface Scenario {
  config?: Partial<SupaschemaConfig>;
  ensureRoles?: boolean;
  from: string;
  name: string;
  to: string;
}

const scenarios: Scenario[] = [
  {
    config: { hints: { destructive: ["function:app.legacy_ping()"] } },
    from: "dir:tests/fixtures/basic/from",
    name: "basic",
    to: "dir:tests/fixtures/basic/to",
  },
  {
    from: "dir:tests/fixtures/add-column/from",
    name: "add-column",
    to: "dir:tests/fixtures/add-column/to",
  },
  {
    from: "dir:tests/fixtures/dependent-views/from",
    name: "dependent-views",
    to: "dir:tests/fixtures/dependent-views/to",
  },
  {
    config: { managedSchemas: [] },
    ensureRoles: true,
    from: "dir:tests/fixtures/dependent-views/from",
    name: "parity-tree",
    to: "dir:tests/fixtures/parity/tree",
  },
  {
    config: { managedSchemas: [] },
    from: "dir:tests/fixtures/dependent-views/from",
    name: "hostile",
    to: "dir:tests/fixtures/parity/hostile",
  },
];

async function renderScenario(scenario: Scenario): Promise<string> {
  const options = scenario.config ? { config: scenario.config } : {};
  const from = await extractSourceModel(scenario.from, options);
  const to = await extractSourceModel(scenario.to, options);
  const sourceErrors = [...from.diagnostics, ...to.diagnostics].filter(
    (item) => item.severity === "error"
  );
  if (sourceErrors.length > 0) {
    throw new Error(`expected source extraction to succeed: ${JSON.stringify(sourceErrors)}`);
  }
  const plan = planSchemaDiff(from, to, options);
  const planErrors = plan.diagnostics.filter((item) => item.severity === "error");
  if (planErrors.length > 0) {
    throw new Error(`expected planning to succeed: ${JSON.stringify(planErrors)}`);
  }
  return renderMigration(plan, options);
}

describe.each(scenarios)("generated migration standards: $name", (scenario) => {
  test("parses cleanly through the PostgreSQL parser", async () => {
    const sql = await renderScenario(scenario);
    const parsed = await parseSqlAst(sql);

    expect(parsed.ast).toBeDefined();
    expect(parsed.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  test("passes supaschema's own replay-safety checker", async () => {
    const sql = await renderScenario(scenario);
    const diagnostics = await checkMigrationSql(
      sql,
      scenario.config ? { config: scenario.config } : {}
    );

    expect(diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  test("carries the lock and statement timeout preamble", async () => {
    const sql = await renderScenario(scenario);

    expect(sql).toContain("SET lock_timeout = ");
    expect(sql).toContain("SET statement_timeout = ");
  });

  test("never emits CASCADE and never references catalogs unqualified", async () => {
    const sql = await renderScenario(scenario);
    const diagnostics = await checkMigrationSql(
      sql,
      scenario.config ? { config: scenario.config } : {}
    );
    const diagnosticCodes = diagnostics.map((diagnostic) => diagnostic.code);

    expect(diagnosticCodes).not.toContain("SUPA_CHECK_CASCADE");
    expect(
      hasUnqualifiedCatalogName(sql, [
        "pg_type",
        "pg_class",
        "pg_namespace",
        "pg_constraint",
        "pg_roles",
      ])
    ).toBe(false);
    expect(hasUnqualifiedRegproc(sql)).toBe(false);
  });

  test.skipIf(!databaseUrl)(
    "applies twice against a disposable database and matches the target catalog",
    { timeout: 60_000 },
    async () => {
      if (!databaseUrl) {
        return;
      }
      const { mkdtemp, writeFile } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const sql = await renderScenario(scenario);
      const directory = await mkdtemp(join(tmpdir(), `supa-out-${scenario.name}-`));
      const migrationPath = join(directory, "migration.sql");
      await writeFile(migrationPath, sql);

      const diagnostics = await verifyMigration({
        ...(scenario.config ? { config: scenario.config } : {}),
        databaseUrl,
        ensureRoles: scenario.ensureRoles === true,
        from: scenario.from,
        migrationPath,
        to: scenario.to,
      });

      expect(diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    }
  );
});
