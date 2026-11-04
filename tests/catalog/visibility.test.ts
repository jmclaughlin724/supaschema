import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, test } from "vitest";
import { extractCatalogModel } from "../../src/catalog/extract.js";
import { applySql, withTemporaryDatabases } from "../../src/database/admin.js";
import { resolveDatabaseUrl } from "../../src/database/url.js";
import { extractSourceModel } from "../../src/source/extract.js";

const databaseUrl = process.env.SUPASCHEMA_TEST_DATABASE_URL ?? resolveDatabaseUrl();

describe.skipIf(!databaseUrl)("catalog visibility", () => {
  test("excludes underscore schemas owned by Supabase platform roles without a schema allowlist", async () => {
    const runtimeRole = "supabase_admin";
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const existingRole = await admin.query("select 1 from pg_roles where rolname = $1", [
      runtimeRole,
    ]);
    const createdRole = existingRole.rowCount === 0;
    if (createdRole) {
      await admin.query(`CREATE ROLE ${runtimeRole} NOLOGIN`);
    }
    await admin.end();
    try {
      await withTemporaryDatabases(databaseUrl, 1, async ([url]) => {
        if (!url) {
          throw new Error("expected temporary database URL");
        }
        await applySql(
          url,
          `CREATE SCHEMA _runtime;
           CREATE TABLE _runtime.tenants (id uuid PRIMARY KEY);
           ALTER TABLE _runtime.tenants OWNER TO ${runtimeRole};
           CREATE SCHEMA app;
           CREATE TABLE app.visible (id bigint PRIMARY KEY);`
        );

        const model = await extractCatalogModel({ databaseUrl: url });
        const keys = new Set(model.objects.map((object) => object.key));

        expect(keys.has("schema:_runtime")).toBe(false);
        expect(keys.has("table:_runtime.tenants")).toBe(false);
        expect(keys.has("schema:app")).toBe(true);
        expect(keys.has("table:app.visible")).toBe(true);
      });
    } finally {
      if (createdRole) {
        const cleanup = new Client({ connectionString: databaseUrl });
        await cleanup.connect();
        await cleanup.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
        await cleanup.end();
      }
    }
  });

  test("subtracts _bootstrap inventory from live database sources", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-bootstrap-inventory-"));
    const schemaRoot = join(root, "supabase", "schemas");
    await mkdir(join(schemaRoot, "_bootstrap"), { recursive: true });
    await writeFile(
      join(schemaRoot, "_bootstrap", "01_extensions.sql"),
      "CREATE SCHEMA IF NOT EXISTS extensions;\n"
    );

    await withTemporaryDatabases(databaseUrl, 1, async ([url]) => {
      if (!url) {
        throw new Error("expected temporary database URL");
      }
      await applySql(
        url,
        `CREATE SCHEMA extensions;
         CREATE SCHEMA app;
         CREATE TABLE app.visible (id bigint PRIMARY KEY);`
      );

      const model = await extractSourceModel(`database:${url}`, {
        config: { managedSchemas: [], schemaPaths: ["supabase/schemas"] },
        cwd: root,
      });
      const keys = new Set(model.objects.map((object) => object.key));

      expect(keys.has("schema:extensions")).toBe(false);
      expect(keys.has("schema:app")).toBe(true);
      expect(keys.has("table:app.visible")).toBe(true);
    });
  });

  test("preserves unpopulated materialized views as WITH NO DATA", async () => {
    await withTemporaryDatabases(databaseUrl, 1, async ([url]) => {
      if (!url) {
        throw new Error("expected temporary database URL");
      }
      await applySql(
        url,
        `CREATE SCHEMA app;
         CREATE TABLE app.source_rows (id bigint PRIMARY KEY);
         CREATE MATERIALIZED VIEW app.mv_source_rows AS SELECT id FROM app.source_rows WITH NO DATA;`
      );

      const model = await extractCatalogModel({ databaseUrl: url });
      const matview = model.objects.find(
        (object) => object.key === "materialized-view:app.mv_source_rows"
      );

      expect(matview?.sql).toContain("WITH NO DATA");
      expect(matview?.metadata.withNoData).toBe(true);
    });
  });

  test("skips the initdb default public schema comment but keeps custom ones", async () => {
    await withTemporaryDatabases(databaseUrl, 2, async ([defaultUrl, customUrl]) => {
      if (!(defaultUrl && customUrl)) {
        throw new Error("expected temporary database URLs");
      }

      const fresh = await extractCatalogModel({ databaseUrl: defaultUrl });
      expect(fresh.objects.some((object) => object.metadata.descriptor === "schema public")).toBe(
        false
      );

      await applySql(customUrl, "COMMENT ON SCHEMA public IS 'workspace docs';");
      const customized = await extractCatalogModel({ databaseUrl: customUrl });
      const comment = customized.objects.find(
        (object) => object.metadata.descriptor === "schema public"
      );
      expect(comment?.metadata.description).toBe("workspace docs");
      expect(comment?.ref.schema).toBeUndefined();
    });
  });
});
