import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it, test } from "vitest";
import { checkMigrationSql } from "../../src/check/migration.js";
import { loadConfig, type SupaschemaConfig } from "../../src/config/schema.js";
import { resolveDatabaseUrl } from "../../src/database/url.js";
import { planSchemaDiff } from "../../src/planner/schema.js";
import { renderMigration } from "../../src/render/migration.js";
import { extractSourceModel } from "../../src/source/extract.js";
import { resolveSourceDefaults } from "../../src/source/resolve.js";
import { generateDatabaseTypes } from "../../src/typegen/database.js";
import { collectSchemaShapes } from "../../src/typegen/model.js";
import { generateZodSchemas } from "../../src/typegen/zod.js";
import type { Diagnostic, SchemaModel } from "../../src/types.js";
import { verifyMigration } from "../../src/verify/migration.js";
import {
  expectedMigrationFragments,
  expectedTypesFragments,
  expectedZodFragments,
} from "./expectations.js";

const databaseUrl = process.env.SUPASCHEMA_TEST_DATABASE_URL ?? resolveDatabaseUrl();

const sampleRoot = "tests/fixtures/sample-project";

const errorsOf = (diagnostics: Diagnostic[]): Diagnostic[] =>
  diagnostics.filter((item) => item.severity === "error");

async function modelFor(source: string, config: SupaschemaConfig): Promise<SchemaModel> {
  const model = await extractSourceModel(source, { config, cwd: sampleRoot });
  const errors = errorsOf(model.diagnostics);
  if (errors.length > 0) {
    throw new Error(`extraction errors for ${source}: ${JSON.stringify(errors)}`);
  }
  return model;
}

describe("supabase sample project config", () => {
  it("wires the supaschema-owned surfaces to the user-named layout", async () => {
    const config = await loadConfig(sampleRoot);

    expect(config.schemaPaths).toEqual(["supabase/schemas-next"]);
    expect(config.migrationsDir).toBe("supabase/migrations");
    expect(config.typesFile).toBe("packages/db/src/types/database.types.ts");
    expect(config.zodFile).toBe("packages/db/src/types/database.zod.ts");
    expect(config.sources).toEqual({ from: "dir:supabase/schemas" });
    expect(config.transactionMode).toBe("per-migration");
  });
});

describe("supabase sample project schema-edit migration", () => {
  it("renders an accurate, additive, replay-safe migration for the schema edit", async () => {
    const config = await loadConfig(sampleRoot);
    const sources = await resolveSourceDefaults({}, config, async () => undefined);
    const from = await modelFor(sources.from, config);
    const to = await modelFor(sources.to, config);

    const plan = planSchemaDiff(from, to, { config });
    expect(errorsOf(plan.diagnostics)).toEqual([]);

    expect(plan.operations.filter((operation) => operation.kind === "drop")).toEqual([]);
    expect(plan.operations.some((operation) => operation.blocked === true)).toBe(false);

    const sql = renderMigration(plan, { config });
    for (const fragment of expectedMigrationFragments) {
      expect(sql, fragment).toContain(fragment);
    }

    expect(errorsOf(await checkMigrationSql(sql, { config }))).toEqual([]);
  });

  it("generates accurate TypeScript and Zod into the packages/db/src/types layout", async () => {
    const config = await loadConfig(sampleRoot);
    const sources = await resolveSourceDefaults({}, config, async () => undefined);
    const model = await modelFor(sources.to, config);
    const shapes = await collectSchemaShapes(model);

    const types = generateDatabaseTypes(shapes);
    for (const fragment of expectedTypesFragments) {
      expect(types, fragment).toContain(fragment);
    }

    const zod = generateZodSchemas(shapes, "./database.types.js");
    for (const fragment of expectedZodFragments) {
      expect(zod, fragment).toContain(fragment);
    }

    const consumer = await mkdtemp(join(tmpdir(), "supa-sample-types-"));
    const typesPath = resolve(consumer, config.typesFile);
    const zodPath = resolve(consumer, config.zodFile);
    await mkdir(dirname(typesPath), { recursive: true });
    await writeFile(typesPath, types);
    await mkdir(dirname(zodPath), { recursive: true });
    await writeFile(zodPath, zod);

    expect(existsSync(join(consumer, "packages/db/src/types/database.types.ts"))).toBe(true);
    expect(existsSync(join(consumer, "packages/db/src/types/database.zod.ts"))).toBe(true);
    expect(await readFile(typesPath, "utf8")).toContain(expectedTypesFragments[0]);
  });
});

describe.skipIf(!databaseUrl)("supabase sample project verify", () => {
  test("proves the rendered migration converges from -> to under per-migration mode", {
    timeout: 60_000,
  }, async () => {
    if (!databaseUrl) {
      return;
    }
    const config = await loadConfig(sampleRoot);
    const sources = await resolveSourceDefaults({}, config, async () => undefined);
    const from = await modelFor(sources.from, config);
    const to = await modelFor(sources.to, config);
    const sql = renderMigration(planSchemaDiff(from, to, { config }), { config });

    const directory = await mkdtemp(join(tmpdir(), "supa-sample-verify-"));
    const migrationPath = join(directory, "migration.sql");
    await writeFile(migrationPath, sql);

    const diagnostics = await verifyMigration({
      config,
      cwd: sampleRoot,
      databaseUrl,
      from: sources.from,
      migrationPath,
      to: sources.to,
    });

    expect(errorsOf(diagnostics)).toEqual([]);
  });
});
