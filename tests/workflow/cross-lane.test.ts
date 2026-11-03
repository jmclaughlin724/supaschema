import { Client } from "pg";
import { describe, expect, test } from "vitest";
import { resolveDatabaseUrl } from "../../src/database/url.js";
import { planSchemaDiff } from "../../src/planner/schema.js";
import { extractSourceModel } from "../../src/source/extract.js";
import { splitSqlStatements } from "../../src/sql/split.js";

const databaseUrl = process.env.SUPASCHEMA_TEST_DATABASE_URL ?? resolveDatabaseUrl();

const strictKinds = new Set([
  "schema",
  "extension",
  "enum",
  "type",
  "domain",
  "table",
  "sequence",
  "index",
  "trigger",
  "policy",
  "rls",
  "function",
  "procedure",
  "grant",
  "comment",
]);

async function collectFalseChanges(
  treeDir: string,
  prepare: string[] = [],
  cleanup: string[] = []
): Promise<string[]> {
  if (!databaseUrl) {
    throw new Error("a test database URL is required");
  }
  const admin = new Client({ connectionString: databaseUrl });
  await admin.connect();
  const databaseName = `supaschema_parity_${process.pid}_${Date.now().toString(16)}`;
  try {
    for (const statement of prepare) {
      await admin.query(statement);
    }
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(databaseUrl);
    url.pathname = `/${databaseName}`;
    const dir = await extractSourceModel(`dir:${treeDir}`);
    const dirErrors = dir.diagnostics.filter((item) => item.severity === "error");
    if (dirErrors.length > 0) {
      throw new Error(`expected dir extraction to succeed: ${JSON.stringify(dirErrors)}`);
    }
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      const ordered = [...dir.objects].sort((left, right) => left.ordinal - right.ordinal);
      for (const object of ordered) {
        for (const statement of splitSqlStatements(object.sql)) {
          await client.query(statement);
        }
      }
    } finally {
      await client.end();
    }
    const live = await extractSourceModel(`database:${url.toString()}`);
    const liveErrors = live.diagnostics.filter((item) => item.severity === "error");
    if (liveErrors.length > 0) {
      throw new Error(`expected live extraction to succeed: ${JSON.stringify(liveErrors)}`);
    }
    const plan = planSchemaDiff(live, dir);

    return plan.operations
      .filter((operation) => operation.kind !== "drop")
      .filter((operation) => strictKinds.has(operation.ref.kind))
      .map((operation) => `${operation.kind}:${operation.key}`);
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`).catch((error) => {
      console.error(`cross-lane cleanup failed for ${databaseName}`, error);
    });
    for (const statement of cleanup) {
      await admin.query(statement).catch((error) => {
        console.error("cross-lane role cleanup failed", error);
      });
    }
    await admin.end();
  }
}

describe.skipIf(!databaseUrl)("cross-lane identity parity", () => {
  test("diffs the basic tree against its own live catalog without false changes", {
    timeout: 30_000,
  }, async () => {
    expect(await collectFalseChanges("tests/fixtures/basic/to")).toEqual([]);
  });

  test("diffs the hard-case parity tree against its own live catalog without false changes", {
    timeout: 30_000,
  }, async () => {
    const falseChanges = await collectFalseChanges("tests/fixtures/parity/tree", [
      `DO $supa$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'app_parity_role') THEN CREATE ROLE app_parity_role NOLOGIN; END IF; END $supa$;`,
    ]);
    expect(falseChanges).toEqual([]);
  });

  test("diffs hostile quoted identifiers and apostrophes without false changes", {
    timeout: 30_000,
  }, async () => {
    expect(await collectFalseChanges("tests/fixtures/parity/hostile")).toEqual([]);
  });
});
