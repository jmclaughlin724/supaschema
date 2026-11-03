import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "../../src/types.js";

interface PgState {
  clientConstructions: number;
  poolConstructions: number;
  poolEndCalls: number;
  poolOptions: unknown[];
  queryError: Error | undefined;
  queryTexts: string[];
}

const pgState = vi.hoisted(
  (): PgState => ({
    clientConstructions: 0,
    poolConstructions: 0,
    poolEndCalls: 0,
    poolOptions: [],
    queryError: undefined,
    queryTexts: [],
  })
);

vi.mock("pg", () => {
  class FakePool {
    constructor(options: unknown) {
      pgState.poolConstructions += 1;
      pgState.poolOptions.push(options);
    }

    on(): this {
      return this;
    }

    query(text: unknown): Promise<{ rows: never[] }> {
      pgState.queryTexts.push(typeof text === "string" ? text : String(text));
      if (pgState.queryError !== undefined) {
        return Promise.reject(pgState.queryError);
      }
      return Promise.resolve({ rows: [] });
    }

    end(): Promise<void> {
      pgState.poolEndCalls += 1;
      return Promise.resolve();
    }
  }

  class FakeClient {
    constructor(_options: unknown) {
      pgState.clientConstructions += 1;
    }
  }

  return {
    Client: FakeClient,
    Pool: FakePool,
    default: { Client: FakeClient, Pool: FakePool },
  };
});

const { resolveConfig } = await import("../../src/config/schema.js");
const { registerDiffCommands } = await import("../../src/cli/diff.js");
const { buildSchemaPlanningContext, resolveGenerationSourceDefaults } = await import(
  "../../src/planner/context.js"
);
const { astStatements } = await import("../../src/sql/ast.js");
const { parseSqlAst } = await import("../../src/sql/parser.js");
const { syncMigrations } = await import("../../src/workflow/sync.js");
const { Command } = await import("commander");

const catalogPassword = ["catalog", "credential", "value"].join("-");
const validMigration = `CREATE SCHEMA app;
CREATE TABLE app.accounts (id bigint);
`;

interface Fixture {
  config: ReturnType<typeof resolveConfig>;
  migrationsSource: string;
  root: string;
}

type GenerationCommand = "diff" | "plan";
type SourceSide = "from" | "to";

const generationCommandCases = [{ command: "plan" }, { command: "diff" }] satisfies {
  command: GenerationCommand;
}[];

let previousDatabaseUrl: string | undefined;

beforeEach(() => {
  previousDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
  pgState.clientConstructions = 0;
  pgState.poolConstructions = 0;
  pgState.poolEndCalls = 0;
  pgState.poolOptions.length = 0;
  pgState.queryError = undefined;
  pgState.queryTexts.length = 0;
});

afterEach(() => {
  process.exitCode = undefined;
  if (previousDatabaseUrl === undefined) {
    delete process.env.SUPASCHEMA_DATABASE_URL;
  } else {
    process.env.SUPASCHEMA_DATABASE_URL = previousDatabaseUrl;
  }
});

async function createFixture(migrationSql: string | null = validMigration): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "supa-generation-sources-"));
  await mkdir(join(root, "migrations"));
  await mkdir(join(root, "schemas"));
  if (migrationSql !== null) {
    await writeFile(join(root, "migrations", "20260101000000_source.sql"), migrationSql);
  }
  return {
    config: resolveConfig({ migrationsDir: "migrations", schemaPaths: ["schemas"] }),
    migrationsSource: "migrations:migrations",
    root,
  };
}

function databaseSource(): string {
  const url = new URL("postgresql://example.test/app");
  url.username = "catalog_reader";
  url.password = catalogPassword;
  return `database:${url.toString()}`;
}

async function runGenerationCommand({
  command,
  config,
  failOnDiff = false,
  from,
  to,
}: {
  command: GenerationCommand;
  config: ReturnType<typeof resolveConfig>;
  failOnDiff?: boolean;
  from: string;
  to: string;
}): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerDiffCommands(program, {
    cliVersion: "test",
    configPath: () => undefined,
    loadCliConfig: () => Promise.resolve(config),
    printDiagnostics: (items) => diagnostics.push(...items),
    resolveCliDatabaseUrl: () => Promise.resolve(undefined),
  });
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  try {
    await program.parseAsync([
      "node",
      "supaschema",
      command,
      "--from",
      from,
      "--to",
      to,
      ...(command === "diff" ? ["--out", "stdout", ...(failOnDiff ? ["--fail-on-diff"] : [])] : []),
    ]);
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
  return diagnostics;
}

function modelForSide(
  context: Awaited<ReturnType<typeof buildSchemaPlanningContext>>,
  side: SourceSide
) {
  return side === "from" ? context.from : context.to;
}

async function isReadOnlyCatalogQuery(query: string): Promise<boolean> {
  const parsed = await parseSqlAst(query);
  return (
    parsed.diagnostics.every((item) => item.severity !== "error") &&
    astStatements(parsed.ast, query).every((statement) => statement.tag === "SelectStmt")
  );
}

describe("generation source planning", () => {
  it.each([{ side: "from" }, { side: "to" }] satisfies {
    side: SourceSide;
  }[])("extracts an explicit database source on the $side side", async ({ side }) => {
    const fixture = await createFixture();
    const source = databaseSource();
    const context = await buildSchemaPlanningContext({
      checkMigrationBaseline: false,
      config: fixture.config,
      cwd: fixture.root,
      from: side === "from" ? source : "empty:",
      to: side === "to" ? source : "empty:",
    });

    const model = modelForSide(context, side);
    expect(context.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(model?.source).toBe(source);
    expect(model?.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(pgState.poolConstructions).toBe(1);
    expect(pgState.poolEndCalls).toBe(1);
    expect(pgState.clientConstructions).toBe(0);
  });

  it("extracts a database to-source with read-only catalog access and no apply client", async () => {
    const fixture = await createFixture();

    const context = await buildSchemaPlanningContext({
      checkMigrationBaseline: false,
      config: fixture.config,
      cwd: fixture.root,
      from: "empty:",
      to: databaseSource(),
    });

    expect(context.to?.diagnostics).toEqual([]);
    expect(pgState.queryTexts.length).toBeGreaterThan(0);
    const querySafety = await Promise.all(pgState.queryTexts.map(isReadOnlyCatalogQuery));
    expect(querySafety.every(Boolean)).toBe(true);
    expect(pgState.poolConstructions).toBe(1);
    expect(pgState.poolEndCalls).toBe(1);
    expect(pgState.clientConstructions).toBe(0);
  });

  it("extracts a matching migrations replay before-state for lineage adoption", async () => {
    const fixture = await createFixture();
    const context = await buildSchemaPlanningContext({
      config: fixture.config,
      cwd: fixture.root,
      from: fixture.migrationsSource,
      to: "empty:",
    });

    expect(context.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(context.from?.source).toBe(fixture.migrationsSource);
    expect(context.from?.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(context.from?.objects.map((object) => object.key)).toEqual([
      "schema:app",
      "table:app.accounts",
    ]);
    expect(pgState.poolConstructions).toBe(0);
    expect(pgState.clientConstructions).toBe(0);
  });

  it("rejects migrations replay on the to side before extraction", async () => {
    const fixture = await createFixture();
    const context = await buildSchemaPlanningContext({
      checkMigrationBaseline: false,
      config: fixture.config,
      cwd: fixture.root,
      from: "empty:",
      to: fixture.migrationsSource,
    });

    expect(context.diagnostics.map((item) => item.code)).toEqual([
      "SUPA_SOURCE_MIGRATIONS_TARGET_UNSUPPORTED",
    ]);
    expect(context.to).toBeUndefined();
    expect(pgState.poolConstructions).toBe(0);
    expect(pgState.clientConstructions).toBe(0);
  });

  it("rejects a migrations before-state outside the configured migrations directory", async () => {
    const fixture = await createFixture();
    await mkdir(join(fixture.root, "other-migrations"));
    await writeFile(
      join(fixture.root, "other-migrations", "20260101000000_source.sql"),
      validMigration
    );
    const context = await buildSchemaPlanningContext({
      config: fixture.config,
      cwd: fixture.root,
      from: "migrations:other-migrations",
      to: databaseSource(),
    });

    expect(context.diagnostics.map((item) => item.code)).toEqual([
      "SUPA_MIGRATION_BASELINE_UNSUPPORTED",
    ]);
    expect(context.from).toBeUndefined();
    expect(context.to).toBeUndefined();
    expect(pgState.poolConstructions).toBe(0);
    expect(pgState.clientConstructions).toBe(0);
  });

  it("redacts credentials from catalog extraction diagnostics", async () => {
    const fixture = await createFixture();
    const source = databaseSource();
    pgState.queryError = new Error(`catalog connection failed for ${source}`);

    const context = await buildSchemaPlanningContext({
      checkMigrationBaseline: false,
      config: fixture.config,
      cwd: fixture.root,
      from: source,
      to: "empty:",
    });

    const diagnostics = context.from?.diagnostics ?? [];
    const serialized = JSON.stringify(diagnostics);
    expect(diagnostics.map((item) => item.code)).toContain("SUPA_CATALOG_EXTRACT_FAILED");
    expect(serialized).toContain("[redacted]");
    expect(serialized).not.toContain(catalogPassword);
    expect(pgState.poolEndCalls).toBe(1);
  });

  it("does not connect from an ambient database URL during zero-source resolution", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-generation-defaults-"));
    process.env.SUPASCHEMA_DATABASE_URL = databaseSource().slice("database:".length);

    const resolved = await resolveGenerationSourceDefaults(
      { cwd: root },
      resolveConfig({ migrationsDir: "migrations", schemaPaths: ["schemas"] }),
      async () => false
    );

    expect(resolved.from).toBe("empty:");
    expect(resolved.to).toBe("dir:schemas");
    expect(resolved.diagnostics).toEqual([]);
    expect(pgState.poolConstructions).toBe(0);
    expect(pgState.clientConstructions).toBe(0);
  });

  it.each(generationCommandCases)(
    "accepts a matching migrations replay before-state through $command",
    async ({ command }) => {
      const fixture = await createFixture();
      await writeFile(
        join(fixture.root, "schemas", "app.sql"),
        "CREATE SCHEMA app;\nCREATE TABLE app.accounts (id bigint);\nCREATE TABLE app.profiles (id bigint PRIMARY KEY);\n"
      );
      const migrationsSource = `migrations:${join(fixture.root, "migrations")}`;
      const diagnostics = await runGenerationCommand({
        command,
        config: {
          ...fixture.config,
          migrationsDir: join(fixture.root, "migrations"),
          schemaPaths: [join(fixture.root, "schemas")],
        },
        from: migrationsSource,
        to: `dir:${join(fixture.root, "schemas")}`,
      });

      expect(diagnostics.filter((item) => item.severity === "error")).toEqual([]);
      expect(process.exitCode ?? 0).toBe(0);
      expect(pgState.poolConstructions).toBe(0);
      expect(pgState.poolEndCalls).toBe(0);
      expect(pgState.clientConstructions).toBe(0);
    }
  );

  it("rejects migrations replay as a diff --fail-on-diff source", async () => {
    const fixture = await createFixture();
    const migrationsDir = join(fixture.root, "migrations");
    const schemaDir = join(fixture.root, "schemas");
    const diagnostics = await runGenerationCommand({
      command: "diff",
      config: {
        ...fixture.config,
        migrationsDir,
        schemaPaths: [schemaDir],
      },
      failOnDiff: true,
      from: `migrations:${migrationsDir}`,
      to: `dir:${schemaDir}`,
    });

    expect(process.exitCode).toBe(2);
    expect(diagnostics.map((item) => item.code)).toEqual([
      "SUPA_SOURCE_MIGRATIONS_DRIFT_UNSUPPORTED",
    ]);
    expect(pgState.poolConstructions).toBe(0);
    expect(pgState.clientConstructions).toBe(0);
  });

  it("rejects migrations replay in direct drift planning", async () => {
    const fixture = await createFixture();
    const context = await buildSchemaPlanningContext({
      config: fixture.config,
      cwd: fixture.root,
      from: fixture.migrationsSource,
      mode: "drift",
      to: "empty:",
    });

    expect(context.diagnostics.map((item) => item.code)).toEqual([
      "SUPA_SOURCE_MIGRATIONS_DRIFT_UNSUPPORTED",
    ]);
    expect(context.from).toBeUndefined();
  });

  it("keeps automatic migration replay out of the drift gate", async () => {
    const fixture = await createFixture();
    const config = resolveConfig({ migrationsDir: "migrations", schemaPaths: ["schemas"] });

    const drift = await resolveGenerationSourceDefaults(
      { cwd: fixture.root, mode: "drift" },
      config,
      async () => true
    );
    expect(drift.from).toBe("git:HEAD");
    expect(drift.diagnostics.filter((item) => item.severity === "error")).toEqual([]);

    const driftWithoutGit = await resolveGenerationSourceDefaults(
      { cwd: fixture.root, mode: "drift" },
      config,
      async () => false
    );
    expect(driftWithoutGit.from).toBe("empty:");

    const generation = await resolveGenerationSourceDefaults(
      { cwd: fixture.root },
      config,
      async () => true
    );
    expect(generation.from).toBe(fixture.migrationsSource);
  });

  it("resolves the automatic baseline from the same corpus the plan reads under --replace", async () => {
    const fixture = await createFixture();
    const replacedMigration = join(fixture.root, "migrations", "20260101000000_source.sql");
    const config = resolveConfig({ migrationsDir: "migrations", schemaPaths: ["schemas"] });

    const withoutExclusion = await resolveGenerationSourceDefaults(
      { cwd: fixture.root },
      config,
      async () => true
    );
    expect(withoutExclusion.from).toBe(fixture.migrationsSource);

    const withExclusion = await resolveGenerationSourceDefaults(
      {
        cwd: fixture.root,
        excludeMigrationFiles: [
          replacedMigration,
          replacedMigration.replace(".sql", ".concurrent.sql"),
        ],
      },
      config,
      async () => true
    );
    expect(withExclusion.from).toBe("git:HEAD");
  });

  it("does not enforce the generation baseline gate in drift planning", async () => {
    const fixture = await createFixture();
    const context = await buildSchemaPlanningContext({
      config: fixture.config,
      cwd: fixture.root,
      from: "empty:",
      mode: "drift",
      to: "empty:",
    });

    expect(context.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(context.from).toBeDefined();
  });

  it.each(generationCommandCases)(
    "rejects migrations replay as the $command target",
    async ({ command }) => {
      const fixture = await createFixture();
      const migrationsSource = `migrations:${join(fixture.root, "migrations")}`;
      const diagnostics = await runGenerationCommand({
        command,
        config: fixture.config,
        from: databaseSource(),
        to: migrationsSource,
      });

      expect(process.exitCode).toBe(2);
      expect(diagnostics.map((item) => item.code)).toEqual([
        "SUPA_SOURCE_MIGRATIONS_TARGET_UNSUPPORTED",
      ]);
      expect(pgState.poolConstructions).toBe(0);
      expect(pgState.poolEndCalls).toBe(0);
      expect(pgState.clientConstructions).toBe(0);
    }
  );

  it.each([{ reverse: false }, { reverse: true }] satisfies {
    reverse: boolean;
  }[])(
    "rejects migrations replay through no-target sync with reverse=$reverse",
    async ({ reverse }) => {
      const fixture = await createFixture();
      const migrationsDirectory = join(fixture.root, "migrations");
      const outputDirectory = join(fixture.root, "output-migrations");
      await mkdir(outputDirectory);
      const database = databaseSource();
      const migrations = `migrations:${migrationsDirectory}`;
      const from = reverse ? migrations : database;
      const to = reverse ? database : migrations;
      const result = await syncMigrations({
        config: {
          migrationsDir: outputDirectory,
          schemaPaths: [join(fixture.root, "schemas")],
          sync: { targets: {} },
          workflow: {
            migration_sync: "manual",
            rls_safety: "disabled",
            type_generation: "disabled",
            type_safety: "disabled",
            zod_generation: "disabled",
          },
        },
        directory: outputDirectory,
        from,
        pipeline: true,
        to,
      });

      expect(result.applied).toBe(false);
      expect(
        result.diagnostics.filter((item) => item.severity === "error").map((item) => item.code)
      ).toEqual([
        reverse
          ? "SUPA_MIGRATION_BASELINE_UNSUPPORTED"
          : "SUPA_SOURCE_MIGRATIONS_TARGET_UNSUPPORTED",
      ]);
      expect(result.report).toContain("generation source resolution failed");
      expect(pgState.poolConstructions).toBe(0);
      expect(pgState.poolEndCalls).toBe(0);
      expect(pgState.clientConstructions).toBe(0);
    }
  );
});
