import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it, test } from "vitest";
import { auditModel } from "../../src/audit.js";
import { checkMigrationSql } from "../../src/check/migration.js";
import { resolveDatabaseUrl } from "../../src/database/url.js";
import { planSchemaDiff } from "../../src/planner/schema.js";
import { renderMigration } from "../../src/render/migration.js";
import { extractSourceModel } from "../../src/source/extract.js";
import { verifyMigration } from "../../src/verify/migration.js";

const databaseUrl = process.env.SUPASCHEMA_TEST_DATABASE_URL ?? resolveDatabaseUrl();

async function modelFromSql(sql: string) {
  const root = await mkdtemp(join(tmpdir(), "supa-levelup-"));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "001.sql"), sql);
  return await extractSourceModel(`dir:${root}`);
}

describe("audit report", () => {
  it("reports full coverage for a supported tree", async () => {
    const model = await extractSourceModel("dir:tests/fixtures/realshape/tree");
    const report = auditModel(model);

    expect(report.supported).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.objectsByKind.table).toBe(2);
    expect(report.objectsBySchema.app).toBeGreaterThan(0);
  });

  it("itemizes statements outside the contract", async () => {
    const model = await modelFromSql(
      "CREATE SCHEMA app;\nDO $$ BEGIN RAISE NOTICE 'side effect'; END $$;\n"
    );
    const report = auditModel(model);

    expect(report.supported).toBe(false);
    const codes = report.findings.map((finding) => finding.code);
    expect(codes).toContain("SUPA_EXTRACT_SIDE_EFFECT_UNSUPPORTED");
    expect(report.findings[0]?.samples[0]).toContain("DO $$");
  });
});

describe("foreign data wrapper tier", () => {
  const fdwSql =
    "CREATE SCHEMA app;\nCREATE SERVER files_server FOREIGN DATA WRAPPER file_fdw OPTIONS (host 'x');\nCREATE FOREIGN TABLE app.events (id text, payload text) SERVER files_server OPTIONS (filename '/tmp/events.csv');\n";

  it("models servers and foreign tables instead of failing closed", async () => {
    const model = await modelFromSql(fdwSql);

    expect(model.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const kinds = model.objects.map((object) => object.ref.kind);
    expect(kinds).toContain("foreign-server");
    expect(kinds).toContain("foreign-table");
  });

  it("renders guarded creates ordered server-before-table", async () => {
    const from = await modelFromSql("CREATE SCHEMA app;\n");
    const to = await modelFromSql(fdwSql);
    const plan = planSchemaDiff(from, to);
    const rendered = renderMigration(plan);

    expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(rendered).toContain("CREATE SERVER IF NOT EXISTS files_server");
    expect(rendered).toContain("CREATE FOREIGN TABLE IF NOT EXISTS app.events");
    expect(rendered.indexOf("CREATE SERVER")).toBeLessThan(
      rendered.indexOf("CREATE FOREIGN TABLE")
    );
  });

  it("gates foreign-object drops behind destructive hints", async () => {
    const from = await modelFromSql(fdwSql);
    const to = await modelFromSql("CREATE SCHEMA app;\n");
    const plan = planSchemaDiff(from, to);

    expect(plan.diagnostics.map((item) => item.code)).toContain(
      "SUPA_PLAN_DESTRUCTIVE_HINT_REQUIRED"
    );
  });
});

describe.skipIf(!databaseUrl)("verify environment pack", () => {
  test("applies auth/cron-dependent trees against bare temporary databases", {
    timeout: 30_000,
  }, async () => {
    const treeSql =
      "CREATE SCHEMA app;\nCREATE TABLE app.notes (id bigint PRIMARY KEY, owner_id uuid);\nALTER TABLE app.notes ENABLE ROW LEVEL SECURITY;\nCREATE POLICY notes_owner ON app.notes FOR SELECT TO authenticated USING (owner_id = auth.uid());\nCREATE VIEW app.cron_health WITH (security_invoker = true) AS SELECT jobid, status FROM cron.job_run_details;\n";
    const root = await mkdtemp(join(tmpdir(), "supa-envpack-"));
    await writeFile(join(root, "001.sql"), treeSql);
    const migration = join(await mkdtemp(join(tmpdir(), "supa-envpack-mig-")), "noop.sql");
    await writeFile(migration, "SET lock_timeout = '5s';\n");

    const diagnostics = await verifyMigration({
      config: { managedSchemas: ["auth", "storage", "cron"] },
      databaseUrl,
      ensureEnvironment: true,
      ensureRoles: true,
      from: `dir:${root.replaceAll("\\", "/")}`,
      migrationPath: migration,
      to: `dir:${root.replaceAll("\\", "/")}`,
    });

    expect(diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });

  test("fails fast with a capability diagnostic for a NOCREATEDB role", async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const role = `supa_nocreate_${process.pid}`;
    await admin.query(`DROP ROLE IF EXISTS ${role}`);
    await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'supa-test' NOCREATEDB`);
    try {
      const url = new URL(databaseUrl);
      url.username = role;
      url.password = "supa-test";
      const root = await mkdtemp(join(tmpdir(), "supa-preflight-"));
      await writeFile(join(root, "001.sql"), "CREATE SCHEMA app;\n");
      const migration = join(await mkdtemp(join(tmpdir(), "supa-preflight-mig-")), "noop.sql");
      await writeFile(migration, "SET lock_timeout = '5s';\n");

      const diagnostics = await verifyMigration({
        databaseUrl: url.toString(),
        from: `dir:${root.replaceAll("\\", "/")}`,
        migrationPath: migration,
        to: `dir:${root.replaceAll("\\", "/")}`,
      });

      expect(diagnostics.map((item) => item.code)).toContain("SUPA_VERIFY_ROLE_CAPABILITY");
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });
});

describe.skipIf(!databaseUrl)("bootstrap ordering proof", () => {
  test("creates the full real-shape tree from empty and verifies catalog parity", async () => {
    const emptyRoot = await mkdtemp(join(tmpdir(), "supa-empty-"));
    const tree = "dir:tests/fixtures/realshape/tree";
    const from = await extractSourceModel(`dir:${emptyRoot.replaceAll("\\", "/")}`);
    const to = await extractSourceModel(tree);
    const plan = planSchemaDiff(from, to);
    expect(plan.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    const rendered = renderMigration(plan);
    const migration = join(await mkdtemp(join(tmpdir(), "supa-bootstrap-mig-")), "bootstrap.sql");
    await writeFile(migration, rendered);

    expect(await checkMigrationSql(rendered)).toEqual([]);
    const diagnostics = await verifyMigration({
      databaseUrl,
      from: `dir:${emptyRoot.replaceAll("\\", "/")}`,
      migrationPath: migration,
      to: tree,
    });

    expect(diagnostics.filter((item) => item.severity === "error")).toEqual([]);
  });
});
