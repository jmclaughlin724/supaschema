import { Client } from "pg";
import { describe, expect, test } from "vitest";
import { extractCatalogModel } from "../../src/catalog/extract.js";
import { resolveDatabaseUrl } from "../../src/database/url.js";
import { planSchemaDiff } from "../../src/planner/schema.js";
import { extractObjectsFromSql } from "../../src/sql/extract.js";
import { splitSqlStatements } from "../../src/sql/split.js";
import type { SchemaModel } from "../../src/types.js";

const databaseUrl = process.env.SUPASCHEMA_TEST_DATABASE_URL ?? resolveDatabaseUrl();

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return state / 4_294_967_296;
  };
}

const columnTypes = [
  "integer",
  "bigint",
  "text",
  "boolean",
  "numeric(10, 2)",
  "timestamptz",
  "varchar(40)",
  "uuid",
  "jsonb",
];

const defaultsByType = new Map([
  ["bigint", "0"],
  ["boolean", "false"],
  ["integer", "42"],
  ["jsonb", "'{}'::jsonb"],
  ["text", "'unset'"],
  ["timestamptz", "now()"],
]);

function generateTree(seed: number): string {
  const random = mulberry32(seed);
  const pick = <T>(items: T[]): T => {
    const item = items[Math.floor(random() * items.length)];
    if (item === undefined) {
      throw new Error("empty pick pool");
    }
    return item;
  };
  const statements: string[] = ["CREATE SCHEMA fuzz;"];
  const enumValues = ["alpha", "beta", "gamma", "delta"].slice(0, 2 + Math.floor(random() * 3));
  statements.push(
    `CREATE TYPE fuzz.status AS ENUM (${enumValues.map((value) => `'${value}'`).join(", ")});`
  );
  const tableCount = 2 + Math.floor(random() * 4);
  const tables: { columns: string[]; name: string }[] = [];
  for (let tableIndex = 0; tableIndex < tableCount; tableIndex += 1) {
    const name = `t_${seed}_${tableIndex}`;
    const columnCount = 2 + Math.floor(random() * 5);
    const columns: string[] = [];
    const lines: string[] = ["  id bigint PRIMARY KEY"];
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
      const columnName = `c${columnIndex}`;
      const type = pick(columnTypes);
      const parts = [`  ${columnName} ${type}`];
      const baseType = type.split("(")[0] ?? type;
      const defaultValue = defaultsByType.get(baseType);
      if (defaultValue !== undefined && random() < 0.4) {
        parts.push(`DEFAULT ${defaultValue}`);
        if (random() < 0.5) {
          parts.push("NOT NULL");
        }
      }
      columns.push(columnName);
      lines.push(parts.join(" "));
    }
    if (random() < 0.4) {
      lines.push("  current fuzz.status DEFAULT 'alpha'");
      columns.push("current");
    }
    statements.push(`CREATE TABLE fuzz.${name} (\n${lines.join(",\n")}\n);`);
    tables.push({ columns, name });
    if (random() < 0.6) {
      const column = pick(columns);
      statements.push(`CREATE INDEX ${name}_${column}_idx ON fuzz.${name} (${column});`);
    }
    if (random() < 0.4) {
      statements.push(`ALTER TABLE fuzz.${name} ENABLE ROW LEVEL SECURITY;`);
      statements.push(`CREATE POLICY ${name}_select ON fuzz.${name} FOR SELECT USING (id > 0);`);
    }
    if (random() < 0.4) {
      statements.push(`COMMENT ON TABLE fuzz.${name} IS 'fuzz table ${tableIndex}';`);
    }
    if (random() < 0.5) {
      statements.push(`GRANT SELECT ON TABLE fuzz.${name} TO PUBLIC;`);
    }
  }
  const viewSource = pick(tables);
  statements.push(
    `CREATE VIEW fuzz.v_${seed} AS SELECT id FROM fuzz.${viewSource.name} WHERE id > 0;`
  );
  statements.push(
    `CREATE FUNCTION fuzz.count_${seed}() RETURNS bigint LANGUAGE sql STABLE AS $$ SELECT count(*) FROM fuzz.${viewSource.name} $$;`
  );
  return statements.join("\n");
}

const strictKinds = new Set([
  "schema",
  "enum",
  "table",
  "index",
  "policy",
  "rls",
  "function",
  "grant",
  "comment",
]);

describe.skipIf(!databaseUrl)("seeded round-trip fuzz", () => {
  const seeds = [11, 42, 1337, 2026, 90_210];
  test.each(seeds)(
    "round-trips generated tree (seed %i) through a live catalog without false changes",
    {
      timeout: 60_000,
    },
    async (seed) => {
      if (!databaseUrl) {
        return;
      }
      const sql = generateTree(seed);
      const extracted = await extractObjectsFromSql(sql, { config: { managedSchemas: [] } });
      expect(extracted.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
      const dir: SchemaModel = {
        diagnostics: [],
        fingerprint: `fuzz:${seed}`,
        objects: extracted.objects,
        source: `fuzz:${seed}`,
      };
      const admin = new Client({ connectionString: databaseUrl });
      await admin.connect();
      const databaseName = `supaschema_fuzz_${seed}_${process.pid}`;
      try {
        await admin.query(`CREATE DATABASE "${databaseName}"`);
        const url = new URL(databaseUrl);
        url.pathname = `/${databaseName}`;
        const client = new Client({ connectionString: url.toString() });
        await client.connect();
        try {
          for (const statement of splitSqlStatements(sql)) {
            await client.query(statement);
          }
        } finally {
          await client.end();
        }
        const live = await extractCatalogModel({ databaseUrl: url.toString() });
        expect(live.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
        const plan = planSchemaDiff(live, dir, { config: { managedSchemas: [] } });
        const falseChanges = plan.operations
          .filter((operation) => operation.kind !== "drop")
          .filter((operation) => strictKinds.has(operation.ref.kind))
          .map((operation) => `${operation.kind}:${operation.key}`);
        expect(falseChanges, `seed ${seed} drifted`).toEqual([]);
      } finally {
        await admin
          .query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
          .catch((error) => {
            console.error(`fuzz cleanup failed for ${databaseName}`, error);
          });
        await admin.end();
      }
    }
  );
});
