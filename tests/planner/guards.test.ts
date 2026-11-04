import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, test } from "vitest";
import { resolveDatabaseUrl } from "../../src/database/url.js";
import { planSchemaDiff } from "../../src/planner/schema.js";
import { extractSourceModel } from "../../src/source/extract.js";
import { extractObjectsFromSql } from "../../src/sql/extract.js";
import type { MigrationPlan, SchemaModel, SupaschemaConfig } from "../../src/types.js";
import { verifyMigration } from "../../src/verify/migration.js";

const databaseUrl = process.env.SUPASCHEMA_TEST_DATABASE_URL ?? resolveDatabaseUrl();

async function model(
  sql: string,
  source: string,
  config?: Partial<SupaschemaConfig>
): Promise<SchemaModel> {
  const extracted = await extractObjectsFromSql(sql, config ? { config } : {});
  return {
    diagnostics: extracted.diagnostics,
    fingerprint: source,
    objects: extracted.objects,
    source,
  };
}

async function diff(
  fromSql: string,
  toSql: string,
  config?: Partial<SupaschemaConfig>
): Promise<MigrationPlan> {
  const from = await model(fromSql, "test:from", config);
  const to = await model(toSql, "test:to", config);
  return planSchemaDiff(from, to, config ? { config } : {});
}

describe("rename hint guards", () => {
  const fromSql = "CREATE TABLE app.accounts (id integer);\nCREATE VIEW app.v AS SELECT 1 AS one;";

  it("blocks rename hints that change the object kind", async () => {
    const plan = await diff(fromSql, "CREATE VIEW app.v AS SELECT 1 AS one;", {
      hints: { destructive: [], renames: [{ from: "table:app.accounts", to: "view:app.v" }] },
    });

    expect(plan.diagnostics.some((item) => item.code === "SUPA_PLAN_RENAME_KIND_MISMATCH")).toBe(
      true
    );
  });

  it("blocks rename hints that move an object between schemas", async () => {
    const plan = await diff(
      fromSql,
      "CREATE SCHEMA archive;\nCREATE TABLE archive.accounts (id integer);",
      {
        hints: {
          destructive: [],
          renames: [{ from: "table:app.accounts", to: "table:archive.accounts" }],
        },
      }
    );

    expect(
      plan.diagnostics.some((item) => item.code === "SUPA_PLAN_RENAME_SET_SCHEMA_UNSUPPORTED")
    ).toBe(true);
  });

  it("reports rename hints that match nothing", async () => {
    const plan = await diff(fromSql, fromSql, {
      hints: { destructive: [], renames: [{ from: "table:app.missing", to: "table:app.other" }] },
    });

    expect(plan.diagnostics.some((item) => item.code === "SUPA_PLAN_RENAME_HINT_UNMATCHED")).toBe(
      true
    );
  });
});

describe("cross-schema dependency ordering", () => {
  it("creates the referenced schema and table before the dependent view", async () => {
    const plan = await diff(
      "",
      [
        "CREATE SCHEMA app;",
        "CREATE SCHEMA reporting;",
        "CREATE VIEW reporting.account_rollup AS SELECT id FROM app.accounts;",
        "CREATE TABLE app.accounts (id integer);",
      ].join("\n")
    );

    const order = plan.operations.map((operation) => operation.key);
    expect(order.indexOf("schema:app")).toBeLessThan(order.indexOf("table:app.accounts"));
    expect(order.indexOf("table:app.accounts")).toBeLessThan(
      order.indexOf("view:reporting.account_rollup")
    );
    expect(order.indexOf("schema:reporting")).toBeLessThan(
      order.indexOf("view:reporting.account_rollup")
    );
  });

  it("creates referenced key constraints before dependent foreign keys", async () => {
    const plan = await diff(
      "",
      [
        "CREATE SCHEMA commissions;",
        "CREATE TABLE commissions.commission_plan_versions (id uuid PRIMARY KEY, template_id uuid REFERENCES commissions.commission_templates(id));",
        "CREATE TABLE commissions.commission_templates (id uuid PRIMARY KEY);",
      ].join("\n")
    );
    const order = plan.operations.map((operation) => operation.key);

    expect(order.indexOf("table:commissions.commission_templates")).toBeLessThan(
      order.indexOf("constraint:commissions.commission_templates_pkey:commission_templates")
    );
    expect(
      order.indexOf("constraint:commissions.commission_templates_pkey:commission_templates")
    ).toBeLessThan(
      order.indexOf(
        "constraint:commissions.commission_plan_versions_template_id_fkey:commission_plan_versions"
      )
    );
  });

  it("adds table columns before constraints that reference those columns", async () => {
    const plan = await diff(
      [
        "CREATE SCHEMA credentials;",
        "CREATE TABLE credentials.service_operator_oauth_credentials (id uuid PRIMARY KEY);",
      ].join("\n"),
      [
        "CREATE SCHEMA credentials;",
        [
          "CREATE TABLE credentials.service_operator_oauth_credentials (",
          "id uuid PRIMARY KEY,",
          "secret_id text,",
          "token_hash text,",
          "CONSTRAINT credentials_secret_xor_hash CHECK ((secret_id IS NULL) <> (token_hash IS NULL))",
          ");",
        ].join("\n"),
      ].join("\n")
    );
    const order = plan.operations.map((operation) => operation.key);

    expect(order.indexOf("table:credentials.service_operator_oauth_credentials")).toBeLessThan(
      order.indexOf(
        "constraint:credentials.credentials_secret_xor_hash:service_operator_oauth_credentials"
      )
    );
  });
});

describe("routine dependency proof guards", () => {
  const fromSql = `
    CREATE TABLE app.accounts (id bigint PRIMARY KEY);
    CREATE FUNCTION app.dynamic_lookup()
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM id FROM app.accounts;
      EXECUTE 'select id from app.accounts';
    END;
    $$;
  `;
  const toSql = `
    CREATE TABLE app.accounts (id bigint PRIMARY KEY, label text DEFAULT ''::text NOT NULL);
    CREATE FUNCTION app.dynamic_lookup()
    RETURNS void
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM id FROM app.accounts;
      EXECUTE 'select id from app.accounts';
    END;
    $$;
  `;

  it("does not block additive relation changes when dynamic SQL dependencies are parsed", async () => {
    const plan = await diff(fromSql, toSql);
    const operation = plan.operations.find((item) => item.key === "table:app.accounts");

    expect(operation?.blocked).toBe(false);
    expect(plan.diagnostics.map((item) => item.code)).not.toContain(
      "SUPA_ROUTINE_DEPENDENCY_PROOF_REQUIRED"
    );
  });

  it("does not block unrelated relation changes for pure dynamic routines without structural proof", async () => {
    const plan = await diff(
      `
        CREATE TABLE app.accounts (id bigint PRIMARY KEY);
        CREATE FUNCTION app.dynamic_lookup(query_sql text)
        RETURNS void
        LANGUAGE plpgsql
        AS $$
        BEGIN
          EXECUTE query_sql;
        END;
        $$;
      `,
      `
        CREATE TABLE app.accounts (id bigint PRIMARY KEY, label text DEFAULT ''::text NOT NULL);
        CREATE FUNCTION app.dynamic_lookup(query_sql text)
        RETURNS void
        LANGUAGE plpgsql
        AS $$
        BEGIN
          EXECUTE query_sql;
        END;
        $$;
      `
    );
    const operation = plan.operations.find((item) => item.key === "table:app.accounts");

    expect(operation?.blocked).toBe(false);
    expect(plan.diagnostics.map((item) => item.code)).not.toContain(
      "SUPA_ROUTINE_DEPENDENCY_PROOF_REQUIRED"
    );
  });

  it("blocks overlapping relation changes when an existing routine has unproven dynamic SQL", async () => {
    const plan = await diff(
      `
        CREATE TABLE app.accounts (id bigint PRIMARY KEY);
        CREATE FUNCTION app.dynamic_lookup(query_sql text)
        RETURNS void
        LANGUAGE plpgsql
        AS $$
        BEGIN
          PERFORM id FROM app.accounts;
          EXECUTE query_sql;
        END;
        $$;
      `,
      `
        CREATE TABLE app.accounts (id bigint PRIMARY KEY, label text DEFAULT ''::text NOT NULL);
        CREATE FUNCTION app.dynamic_lookup(query_sql text)
        RETURNS void
        LANGUAGE plpgsql
        AS $$
        BEGIN
          PERFORM id FROM app.accounts;
          EXECUTE query_sql;
        END;
        $$;
      `
    );
    const operation = plan.operations.find((item) => item.key === "table:app.accounts");

    expect(operation?.blocked).toBe(true);
    expect(plan.diagnostics.map((item) => item.code)).toContain(
      "SUPA_ROUTINE_DEPENDENCY_PROOF_REQUIRED"
    );
  });

  it("does not block relation changes when the overlapping unproven routine is created in the same plan", async () => {
    const plan = await diff(
      "CREATE TABLE app.accounts (id bigint PRIMARY KEY);",
      `
        CREATE TABLE app.accounts (id bigint PRIMARY KEY, label text DEFAULT ''::text NOT NULL);
        CREATE FUNCTION app.dynamic_lookup()
        RETURNS void
        LANGUAGE plpgsql
        AS $$
        BEGIN
          PERFORM label FROM app.accounts;
          EXECUTE 'select 1';
        END;
        $$;
      `
    );
    const operation = plan.operations.find((item) => item.key === "table:app.accounts");

    expect(operation?.blocked).toBe(false);
    expect(plan.diagnostics.map((item) => item.code)).not.toContain(
      "SUPA_ROUTINE_DEPENDENCY_PROOF_REQUIRED"
    );
  });
});

describe("managed schema policy", () => {
  const managedSql = "CREATE TABLE auth.mirror (id integer);";

  it("keeps only configured managed-schema overlays after source filtering", async () => {
    const managedSchemaOverlays = [
      "policy:storage.loan_documents_require_mfa:objects",
      "policy:storage.tenant_document_read:objects",
      "policy:storage.tenant_document_upload:objects",
    ];
    const root = await mkdtemp(join(tmpdir(), "supa-managed-overlays-"));
    await writeFile(
      join(root, "storage.sql"),
      [
        "CREATE SCHEMA storage;",
        "CREATE TABLE storage.objects (id uuid);",
        "CREATE POLICY loan_documents_require_mfa ON storage.objects USING (true);",
        "CREATE POLICY tenant_document_read ON storage.objects USING (true);",
        "CREATE POLICY tenant_document_upload ON storage.objects USING (true);",
        "CREATE POLICY provider_internal ON storage.objects USING (true);",
        "GRANT SELECT ON TABLE storage.objects TO authenticated;",
        "COMMENT ON TABLE storage.objects IS 'provider owned';",
      ].join("\n")
    );

    const extracted = await extractSourceModel(`dir:${root}`, {
      config: {
        managedSchemaOverlays,
        managedSchemas: ["storage"],
        schemas: { exclude: ["storage"], include: [] },
      },
    });

    expect(
      extracted.objects
        .map((object) => object.key)
        .toSorted((left, right) => left.localeCompare(right))
    ).toEqual(managedSchemaOverlays.toSorted((left, right) => left.localeCompare(right)));
  });

  it("blocks schemas listed in managedSchemas", async () => {
    const extracted = await extractObjectsFromSql(managedSql, {
      config: { adapter: "auto", managedSchemas: ["auth"] },
    });

    expect(extracted.diagnostics.some((item) => item.code === "SUPA_SUPABASE_MANAGED_SCHEMA")).toBe(
      true
    );
  });

  it("does not infer managed schemas from provider-shaped paths", async () => {
    const extracted = await extractObjectsFromSql(managedSql, {
      config: {
        adapter: "auto",
        managedSchemas: [],
        migrationsDir: "supabase/migrations",
        schemaPaths: ["supabase/schemas"],
      },
    });

    expect(extracted.diagnostics.some((item) => item.code === "SUPA_SUPABASE_MANAGED_SCHEMA")).toBe(
      false
    );
  });

  it("supports project-specific managed schema names", async () => {
    const extracted = await extractObjectsFromSql(managedSql, {
      config: { adapter: "auto", managedSchemas: ["auth"] },
    });

    expect(extracted.diagnostics.some((item) => item.code === "SUPA_SUPABASE_MANAGED_SCHEMA")).toBe(
      true
    );
  });
});

describe.skipIf(!databaseUrl)("non-idempotent migration detection", () => {
  test("fails verification when the migration does not produce the target state", {
    timeout: 60_000,
  }, async () => {
    if (!databaseUrl) {
      return;
    }
    const directory = await mkdtemp(join(tmpdir(), "supa-drift-"));
    await writeFile(join(directory, "from.sql"), "CREATE SCHEMA app;");
    await writeFile(
      join(directory, "to.sql"),
      "CREATE SCHEMA app;\nCREATE TABLE app.expected (id integer);"
    );
    const migrationPath = join(directory, "migration.sql");
    await writeFile(migrationPath, "CREATE TABLE IF NOT EXISTS app.unexpected (id integer);\n");

    const diagnostics = await verifyMigration({
      databaseUrl,
      from: `dump:${join(directory, "from.sql")}`,
      migrationPath,
      to: `dump:${join(directory, "to.sql")}`,
    });

    const mismatch = diagnostics.find((item) => item.code === "SUPA_VERIFY_FINGERPRINT_MISMATCH");
    expect(mismatch).toBeDefined();
    expect(mismatch?.hint).toContain("missing from migration result: table:app.expected");
    expect(mismatch?.hint).toContain("not present in target: table:app.unexpected");
  });
});

describe("dependency cycle ordering fallback", () => {
  it("keeps acyclic operations dependency-ordered when a cycle exists elsewhere", async () => {
    const plan = await diff(
      "CREATE SCHEMA app;",
      [
        "CREATE SCHEMA app;",
        "ALTER TABLE app.child ADD CONSTRAINT child_parent_fkey FOREIGN KEY (parent_id) REFERENCES app.parent (id);",
        "CREATE TABLE app.child (parent_id integer);",
        "CREATE FUNCTION app.v_total() RETURNS integer LANGUAGE sql AS $$ SELECT total FROM app.v $$;",
        "CREATE VIEW app.v AS SELECT app.v_total() AS total;",
        "CREATE TABLE app.parent (id integer, CONSTRAINT parent_pkey PRIMARY KEY (id));",
      ].join("\n")
    );

    expect(plan.diagnostics.some((item) => item.code === "SUPA_PLAN_DEPENDENCY_CYCLE")).toBe(true);
    const keys = plan.operations.map((operation) => operation.key);
    const fkIndex = keys.findIndex((key) => key.startsWith("constraint:app.child_parent_fkey"));
    const pkIndex = keys.findIndex((key) => key.startsWith("constraint:app.parent_pkey"));
    expect(fkIndex).toBeGreaterThanOrEqual(0);
    expect(pkIndex).toBeGreaterThanOrEqual(0);
    expect(fkIndex).toBeGreaterThan(pkIndex);
  });
});
