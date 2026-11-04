import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "../../src/database/url.js";
import { extractSourceModel } from "../../src/source/extract.js";
import { generateDatabaseTypes } from "../../src/typegen/database.js";
import {
  chaseColumnType,
  collectSchemaShapes,
  type SchemaShapes,
} from "../../src/typegen/model.js";
import { generateZodSchemas } from "../../src/typegen/zod.js";

const execFileAsync = promisify(execFile);
const databaseUrl = process.env.SUPASCHEMA_TEST_DATABASE_URL ?? resolveDatabaseUrl();

async function modelFor(sql: string) {
  const root = await mkdtemp(join(tmpdir(), "supa-check-zod-"));
  await writeFile(join(root, "001_app.sql"), sql);
  const model = await extractSourceModel(`dir:${root}`);
  const errors = model.diagnostics.filter((item) => item.severity === "error");
  if (errors.length > 0) {
    throw new Error(`expected source extraction to succeed: ${JSON.stringify(errors)}`);
  }
  return model;
}

async function zodFor(sql: string): Promise<string> {
  const model = await modelFor(sql);
  return generateZodSchemas(await collectSchemaShapes(model));
}

function sliceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  expect(start, `expected marker ${startMarker}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(endMarker, start);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

const boundsSql = `CREATE TABLE public.products (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  price numeric NOT NULL CHECK (price >= 0),
  age integer CHECK (age > 0 AND age < 150),
  offset_value integer CHECK (0 < offset_value),
  delta integer CHECK (delta >= -5),
  ratio real CHECK (ratio <= 0.5),
  ratio_strict real CHECK (ratio_strict > 0.1),
  rank integer CHECK (rank BETWEEN 1 AND 10),
  code integer CHECK (code <> 7),
  name text NOT NULL CHECK (char_length(name) >= 3),
  bio text CHECK (char_length(bio) <= 80),
  status text CHECK (status IN ('active', 'archived')),
  tier text CHECK (tier NOT IN ('banned')),
  active boolean NOT NULL CHECK (active),
  scaled numeric(5, 1) CHECK (scaled >= 100),
  precise double precision CHECK (precise <= 0.5),
  fine real CHECK (fine <> 16777217),
  grade char(8) CHECK (grade IN ('active')),
  label char(10) CHECK (char_length(label) <= 4),
  padded char(6) CHECK (char_length(padded) >= 2)
);
`;

const mixedSql = `CREATE SCHEMA app;
CREATE TYPE app.mood AS ENUM ('happy', 'sad');
CREATE DOMAIN app.positive_amount AS integer;
CREATE TABLE app.listings (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  min_price integer,
  max_price integer,
  start_at timestamptz,
  end_at timestamptz,
  amount app.positive_amount CHECK (amount > 0),
  mood app.mood CHECK (mood IN ('happy')),
  handle citext CHECK (char_length(handle) >= 2),
  alias citext CHECK (alias IN ('a')),
  note text CHECK (note IS NOT NULL),
  flexible integer CHECK (flexible > 0 OR flexible < -10),
  mixed integer CHECK (mixed > 0 AND coalesce(mixed, 0) < 100),
  casted text CHECK (casted::text = 'x'),
  doubled integer GENERATED ALWAYS AS (1 + 1) STORED CHECK (doubled >= 0),
  CONSTRAINT listings_price_order CHECK (min_price <= max_price),
  CONSTRAINT listings_time_order CHECK (start_at < end_at)
);
CREATE VIEW app.listing_prices AS SELECT min_price FROM app.listings;
`;

const alteredSql = `CREATE TABLE public.audits (
  inline_v integer CHECK (inline_v >= 1),
  table_v integer,
  altered_v integer,
  ordered integer,
  dup integer CHECK (dup > 0),
  CONSTRAINT audits_table_v_check CHECK (table_v >= 1),
  CONSTRAINT z_upper CHECK (ordered <= 10),
  CONSTRAINT a_lower CHECK (ordered >= 1),
  CONSTRAINT dup_again CHECK (dup > 0)
);
ALTER TABLE public.audits ADD CONSTRAINT audits_altered_v_check CHECK (altered_v >= 1);
ALTER TABLE public.audits ADD CONSTRAINT audits_soft_check CHECK (altered_v <= 9) NOT VALID;
`;

const runtimeSql = `CREATE TABLE public.orders (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  price numeric NOT NULL CHECK (price >= 0),
  name text CHECK (char_length(name) <= 4),
  min_qty integer,
  max_qty integer,
  CHECK (min_qty <= max_qty)
);
`;

const domainSql = `CREATE SCHEMA app;
CREATE DOMAIN app.positive_integer AS integer CHECK (VALUE > 0);
CREATE DOMAIN app.bounded_integer AS app.positive_integer CHECK (VALUE > 0 AND value <= 10);
CREATE DOMAIN app.answer AS integer CHECK (VALUE = 42);
CREATE DOMAIN app.short_text AS text CHECK (char_length(VALUE) <= 4);
CREATE DOMAIN app.status_text AS text CHECK ((value::text) IN ('open', 'closed'));
CREATE DOMAIN app.rounded_amount AS numeric(5, 1) CHECK (VALUE >= 100);
CREATE DOMAIN app.real_ratio AS real CHECK (VALUE <= 0.5);
CREATE DOMAIN app.padded_code AS char(6) CHECK (VALUE IN ('active'));
CREATE DOMAIN app.unclear_integer AS integer CHECK (VALUE > 0 OR VALUE < -10);
CREATE TABLE app.domain_values (
  amount app.bounded_integer,
  answer app.answer,
  short_label app.short_text,
  status app.status_text,
  amounts app.bounded_integer[],
  rounded app.rounded_amount,
  ratio app.real_ratio,
  padded app.padded_code,
  unclear app.unclear_integer
);
`;

const castSql = `CREATE EXTENSION IF NOT EXISTS citext;
CREATE TABLE public.cast_checks (
  plain text CHECK ((plain::text) IN ('x', 'y')),
  named text CHECK (char_length(named::text) >= 2),
  handle citext CHECK (char_length(handle::citext) >= 2),
  widened varchar CHECK ((widened::text) IN ('x')),
  sized varchar(5) CHECK ((sized::varchar(3)) IN ('x')),
  padded char(5) CHECK ((padded::text) IN ('x')),
  integer_text integer CHECK ((integer_text::text) IN ('1'))
);
`;

const equalitySql = `CREATE TABLE public.matches (
  exact integer CHECK (exact = 7),
  mirrored bigint CHECK (8 = mirrored),
  fractional integer CHECK (fractional = 7.5),
  floating double precision CHECK (floating = 7),
  arbitrary numeric CHECK (arbitrary = 7),
  rounded numeric(5, 1) CHECK (rounded = 7),
  single_precision real CHECK (single_precision = 7)
);
`;

const wireSoundnessSql = `CREATE TABLE public.wire_values (
  strict_numeric numeric CHECK (strict_numeric > 7),
  unequal_numeric numeric CHECK (unequal_numeric <> 7),
  sized_list varchar(3) CHECK (sized_list IN ('abc')),
  sized_length varchar(3) CHECK (char_length(sized_length) <= 3),
  sized_cast varchar(3) CHECK ((sized_cast::varchar) IN ('abc')),
  collated_list text COLLATE public.case_insensitive CHECK (collated_list IN ('active')),
  lower_numeric numeric,
  upper_numeric numeric,
  lte_numeric numeric,
  lte_numeric_other numeric,
  gte_numeric numeric,
  gte_numeric_other numeric,
  lower_bigint bigint,
  upper_bigint bigint,
  equal_bigint bigint,
  equal_bigint_other bigint,
  lte_bigint bigint,
  lte_bigint_other bigint,
  gte_bigint bigint,
  gte_bigint_other bigint,
  CHECK (lower_numeric < upper_numeric),
  CHECK (lte_numeric <= lte_numeric_other),
  CHECK (gte_numeric >= gte_numeric_other),
  CHECK (lower_bigint < upper_bigint),
  CHECK (equal_bigint = equal_bigint_other),
  CHECK (lte_bigint <= lte_bigint_other),
  CHECK (gte_bigint >= gte_bigint_other)
);
`;

const domainSoundnessSql = `CREATE SCHEMA app;
CREATE SCHEMA other;
CREATE TYPE app.code AS ENUM ('x');
CREATE DOMAIN public.code AS integer CHECK (VALUE = 1);
CREATE DOMAIN app.outer_code AS code CHECK (VALUE > 0);
CREATE DOMAIN public.ambiguous_code AS integer CHECK (VALUE = 1);
CREATE DOMAIN other.ambiguous_code AS integer CHECK (VALUE = 2);
CREATE DOMAIN app.ambiguous_outer AS ambiguous_code CHECK (VALUE > 0);
CREATE DOMAIN app.collated_status AS text COLLATE public.case_insensitive
  CHECK (VALUE IN ('active'));
CREATE DOMAIN app.sized_status AS varchar(3)
  CHECK (VALUE IN ('abc') AND char_length(VALUE) <= 3);
CREATE TABLE app.domain_edges (
  collided app.outer_code,
  ambiguous app.ambiguous_outer,
  collated app.collated_status,
  sized app.sized_status
);
`;

describe("check constraint zod refinements", () => {
  it("translates numeric, length, list, and boolean checks into column refinements", async () => {
    const zod = await zodFor(boundsSql);
    const row = sliceBetween(zod, "Row: z.object({", "Insert: z.object({");

    expect(row).toContain("price: z.number().gte(0),");
    expect(row).toContain("age: z.number().gt(0).lt(150).nullable(),");
    expect(row).toContain("offset_value: z.number().gt(0).nullable(),");
    expect(row).toContain("delta: z.number().gte(-5).nullable(),");
    expect(row).toContain("ratio: z.number().nullable(),");
    expect(row).toContain("ratio_strict: z.number().nullable(),");
    expect(row).toContain("rank: z.number().gte(1).lte(10).nullable(),");
    expect(row).toContain("code: z.number().refine((value) => value !== 7).nullable(),");
    expect(row).toContain("name: z.string().min(3),");
    expect(row).toContain("bio: z.string().refine((value) => [...value].length <= 80).nullable(),");
    expect(row).toContain(
      'status: z.string().refine((value) => ["active", "archived"].includes(value)).nullable(),'
    );
    expect(row).toContain(
      'tier: z.string().refine((value) => !["banned"].includes(value)).nullable(),'
    );
    expect(row).toContain("active: z.boolean().refine((value) => value === true),");
  });

  it("omits refinements that can reject values PostgreSQL accepts after coercion", async () => {
    const zod = await zodFor(boundsSql);
    const row = sliceBetween(zod, "Row: z.object({", "Insert: z.object({");

    expect(row).toContain("ratio: z.number().nullable(),");
    expect(row).toContain("scaled: z.number().nullable(),");
    expect(row).toContain("fine: z.number().nullable(),");
    expect(row).toContain("grade: z.string().nullable(),");
    expect(row).toContain("label: z.string().nullable(),");
    expect(row).toContain("padded: z.string().nullable(),");
    expect(row).toContain("precise: z.number().lte(0.5).nullable(),");
    expect(row).not.toContain("ratio: z.number().lte");
    expect(row).not.toContain("scaled: z.number().gte");
    expect(row).not.toContain("fine: z.number().refine");
    expect(row).not.toContain("grade: z.string().refine");
    expect(row).not.toContain("label: z.string().refine");
  });

  it("keeps refinements on write schemas ahead of optionality wrappers", async () => {
    const zod = await zodFor(boundsSql);
    const insert = sliceBetween(zod, "Insert: z.object({", "Update: z.object({");
    const update = sliceBetween(zod, "Update: z.object({", "Enums: {");

    expect(insert).toContain("price: z.number().gte(0),");
    expect(insert).toContain("age: z.number().gt(0).lt(150).nullable().optional(),");
    expect(update).toContain("price: z.number().gte(0).optional(),");
    expect(update).toContain("age: z.number().gt(0).lt(150).nullable().optional(),");
  });

  it("skips untranslatable expressions instead of approximating them", async () => {
    const zod = await zodFor(mixedSql);
    const listings = sliceBetween(zod, "listings: {", "listing_prices: {");
    const row = sliceBetween(listings, "Row: z.object({", "Insert: z.object({");

    expect(row).toContain("note: z.string().nullable(),");
    expect(row).toContain("flexible: z.number().nullable(),");
    expect(row).toContain("mixed: z.number().gt(0).nullable(),");
    expect(row).toContain("casted: z.string().nullable(),");
    expect(row).toContain("alias: z.string().nullable(),");
    expect(row).toContain("start_at: z.string().nullable(),");
    expect(row).toContain("end_at: z.string().nullable(),");
    const moodLine = row.split("\n").find((line) => line.includes("mood:"));
    expect(moodLine).toBeDefined();
    expect(moodLine).not.toContain("refine");
  });

  it("translates domain-backed and citext length checks", async () => {
    const zod = await zodFor(mixedSql);
    const listings = sliceBetween(zod, "listings: {", "listing_prices: {");
    const row = sliceBetween(listings, "Row: z.object({", "Insert: z.object({");

    expect(row).toContain("amount: z.number().gt(0).nullable(),");
    expect(row).toContain("handle: z.string().min(2).nullable(),");
  });

  it("inherits every scalar CREATE DOMAIN check in the declared chain", async () => {
    const zod = await zodFor(domainSql);
    const table = sliceBetween(zod, "domain_values: {", "Enums: {");
    const row = sliceBetween(table, "Row: z.object({", "Insert: z.object({");
    const amount = row.split("\n").find((line) => line.includes("amount:"));

    expect(amount).toContain(".gt(0)");
    expect(amount).toContain(".lte(10)");
    expect(amount?.split(".gt(0)")).toHaveLength(2);
    expect(row).toContain("answer: z.number().refine((value) => value === 42).nullable(),");
    expect(row).toContain(
      "short_label: z.string().refine((value) => [...value].length <= 4).nullable(),"
    );
    expect(row).toContain(
      'status: z.string().refine((value) => ["open", "closed"].includes(value)).nullable(),'
    );
  });

  it("keeps domain checks off arrays and wire-coerced or unsupported domain values", async () => {
    const zod = await zodFor(domainSql);
    const row = sliceBetween(zod, "Row: z.object({", "Insert: z.object({");

    expect(row).toContain("amounts: z.array(z.number()).nullable(),");
    expect(row).toContain("rounded: z.number().nullable(),");
    expect(row).toContain("ratio: z.number().nullable(),");
    expect(row).toContain("padded: z.string().nullable(),");
    expect(row).toContain("unclear: z.number().nullable(),");
  });

  it("unwraps only scalar typmod-free casts to the same safe text base", async () => {
    const zod = await zodFor(castSql);
    const row = sliceBetween(zod, "Row: z.object({", "Insert: z.object({");

    expect(row).toContain(
      'plain: z.string().refine((value) => ["x", "y"].includes(value)).nullable(),'
    );
    expect(row).toContain("named: z.string().min(2).nullable(),");
    expect(row).toContain("handle: z.string().min(2).nullable(),");
    expect(row).toContain("widened: z.string().nullable(),");
    expect(row).toContain("sized: z.string().nullable(),");
    expect(row).toContain("padded: z.string().nullable(),");
    expect(row).toContain("integer_text: z.number().nullable(),");
  });

  it("translates scalar equality only for exact integer-family targets", async () => {
    const zod = await zodFor(equalitySql);
    const row = sliceBetween(zod, "Row: z.object({", "Insert: z.object({");

    expect(row).toContain("exact: z.number().refine((value) => value === 7).nullable(),");
    expect(row).toContain("mirrored: z.number().refine((value) => value === 8).nullable(),");
    expect(row).toContain("fractional: z.number().nullable(),");
    expect(row).toContain("floating: z.number().nullable(),");
    expect(row).toContain("arbitrary: z.number().nullable(),");
    expect(row).toContain("rounded: z.number().nullable(),");
    expect(row).toContain("single_precision: z.number().nullable(),");
  });

  it("omits refinements that observe values before wire or typmod coercion", async () => {
    const zod = await zodFor(wireSoundnessSql);
    const row = sliceBetween(zod, "Row: z.object({", "Insert: z.object({");

    expect(Number("7.0000000000000001")).toBe(7);
    expect(row).toContain("strict_numeric: z.number().nullable(),");
    expect(row).toContain("unequal_numeric: z.number().nullable(),");
    expect(row).toContain("sized_list: z.string().nullable(),");
    expect(row).toContain("sized_length: z.string().nullable(),");
    expect(row).toContain("sized_cast: z.string().nullable(),");
    expect(row).toContain("collated_list: z.string().nullable(),");
    expect(row).not.toContain('value["lower_numeric"]');
    expect(row).not.toContain('value["lte_numeric"]');
    expect(row).not.toContain('value["gte_numeric"]');
    expect(row).not.toContain('value["lower_bigint"]');
    expect(row).not.toContain('value["equal_bigint"]');
    expect(row).not.toContain('value["lte_bigint"]');
    expect(row).not.toContain('value["gte_bigint"]');
  });

  it("fails loose for cross-family or ambiguous domain lookup", async () => {
    const zod = await zodFor(domainSoundnessSql);
    const row = sliceBetween(zod, "Row: z.object({", "Insert: z.object({");

    expect(row).toContain("collided: z.unknown().nullable(),");
    expect(row).toContain("ambiguous: z.unknown().nullable(),");
    expect(row).toContain("collated: z.string().nullable(),");
    expect(row).toContain("sized: z.string().nullable(),");
  });

  it("prefers a same-schema domain over same-named domains in other schemas", () => {
    const shapes: SchemaShapes = {
      compositesByBareName: new Map(),
      compositesByQualifiedName: new Map(),
      domains: new Map([
        ["app.code", { baseType: "integer", checkConstraints: [] }],
        ["other.code", { baseType: "text", checkConstraints: [] }],
      ]),
      enumsByBareName: new Map(),
      enumsByQualifiedName: new Map(),
      schemas: new Map(),
    };

    expect(chaseColumnType(shapes, "app", "code")).toEqual({
      arrayDepth: 0,
      baseTypeName: "integer",
      domainChain: ["app.code"],
      kind: "number",
      sawTypmod: false,
    });
  });

  it("treats composite, relation, and cyclic domain resolution conservatively", () => {
    const shapes: SchemaShapes = {
      compositesByBareName: new Map([["payload", [{ name: "payload", schema: "app" }]]]),
      compositesByQualifiedName: new Map([["app.payload", { name: "payload", schema: "app" }]]),
      domains: new Map([
        ["public.payload", { baseType: "integer", checkConstraints: [] }],
        ["public.record_value", { baseType: "integer", checkConstraints: [] }],
        ["public.first", { baseType: "public.second", checkConstraints: [] }],
        ["public.second", { baseType: "public.first", checkConstraints: [] }],
      ]),
      enumsByBareName: new Map(),
      enumsByQualifiedName: new Map(),
      schemas: new Map([
        [
          "app",
          {
            composites: [{ columns: [], name: "payload" }],
            enums: [],
            functions: [],
            tables: [
              {
                checkConstraints: [],
                columns: [],
                name: "record_value",
                relationships: [],
                uniqueColumnSets: [],
              },
            ],
            views: [],
          },
        ],
      ]),
    };

    expect(chaseColumnType(shapes, "app", "payload")).toMatchObject({
      domainChain: [],
      kind: "unknown",
    });
    expect(chaseColumnType(shapes, "app", "record_value")).toMatchObject({
      domainChain: [],
      kind: "unknown",
    });
    expect(chaseColumnType(shapes, "public", "public.first")).toEqual({
      arrayDepth: 0,
      baseTypeName: "public.first",
      domainChain: ["public.first", "public.second"],
      kind: "unknown",
      sawTypmod: false,
    });
  });

  it("emits guarded object refinements for wire-exact numeric column pairs only", async () => {
    const zod = await zodFor(mixedSql);
    const listings = sliceBetween(zod, "listings: {", "listing_prices: {");
    const pairFragment =
      '.refine((value) => value["min_price"] == null || value["max_price"] == null || value["min_price"] <= value["max_price"])';

    expect(listings.split(pairFragment)).toHaveLength(4);
    expect(listings).toContain(`})${pairFragment},`);
    expect(listings).not.toContain('value["start_at"]');
  });

  it("keeps generated column checks on Row and out of write schemas", async () => {
    const zod = await zodFor(mixedSql);
    const listings = sliceBetween(zod, "listings: {", "listing_prices: {");
    const row = sliceBetween(listings, "Row: z.object({", "Insert: z.object({");
    const insert = sliceBetween(listings, "Insert: z.object({", "Update: z.object({");

    expect(row).toContain("doubled: z.number().gte(0).nullable(),");
    expect(insert).not.toContain("doubled");
  });

  it("leaves view schemas untouched by table checks", async () => {
    const zod = await zodFor(mixedSql);
    const view = sliceBetween(zod, "listing_prices: {", "Enums: {");

    expect(view).toContain("min_price: z.number().nullable(),");
    expect(view).not.toContain("refine");
  });

  it("translates inline, table-level, and ALTER-added checks through one lane", async () => {
    const zod = await zodFor(alteredSql);
    const row = sliceBetween(zod, "Row: z.object({", "Insert: z.object({");

    expect(row).toContain("inline_v: z.number().gte(1).nullable(),");
    expect(row).toContain("table_v: z.number().gte(1).nullable(),");
    expect(row).toContain("altered_v: z.number().gte(1)");
  });

  it("orders fragments by constraint name and dedupes identical checks", async () => {
    const zod = await zodFor(alteredSql);
    const row = sliceBetween(zod, "Row: z.object({", "Insert: z.object({");

    expect(row).toContain("ordered: z.number().gte(1).lte(10).nullable(),");
    expect(row).toContain("dup: z.number().gt(0).nullable(),");
  });

  it("keeps NOT VALID checks on write schemas and off Row", async () => {
    const zod = await zodFor(alteredSql);
    const row = sliceBetween(zod, "Row: z.object({", "Insert: z.object({");
    const insert = sliceBetween(zod, "Insert: z.object({", "Update: z.object({");
    const update = sliceBetween(zod, "Update: z.object({", "Enums: {");

    expect(row).toContain("altered_v: z.number().gte(1).nullable(),");
    expect(insert).toContain("altered_v: z.number().gte(1).lte(9).nullable().optional(),");
    expect(update).toContain("altered_v: z.number().gte(1).lte(9).nullable().optional(),");
  });

  it("type-checks refined schemas against the generated Database contract", async () => {
    const model = await modelFor(runtimeSql);
    const shapes = await collectSchemaShapes(model);
    const types = generateDatabaseTypes(shapes);
    const zod = generateZodSchemas(shapes, "./database.types.js");
    const zodWithoutImport = zod.split("\n").slice(1).join("\n");
    const source = `${types}${zodWithoutImport}
const orderInsert: TablesInsert<"orders"> = SupaschemaZod.public.Tables.orders.Insert.parse({ price: 1 });
const orderRow: Tables<"orders"> = SupaschemaZod.public.Tables.orders.Row.parse({
  id: 1,
  price: 0,
  name: null,
  min_qty: null,
  max_qty: null,
});
void orderInsert;
void orderRow;
`;
    const tmpRoot = join(process.cwd(), ".tmp");
    await mkdir(tmpRoot, { recursive: true });
    const root = await mkdtemp(join(tmpRoot, "supa-check-ts-"));
    const file = join(root, "generated-types.ts");
    await writeFile(file, source);
    await writeFile(
      join(root, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            skipLibCheck: true,
            strict: true,
            target: "ES2022",
          },
          files: ["generated-types.ts"],
        },
        null,
        2
      )}\n`
    );
    const { stderr, stdout } = await execFileAsync(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "@typescript", "native", "bin", "tsc"),
        "--project",
        join(root, "tsconfig.json"),
        "--pretty",
        "false",
      ],
      { cwd: root, maxBuffer: 1024 * 1024 }
    );
    expect(`${stdout}${stderr}`).toBe("");
  }, 20_000);

  it("enforces translated checks at runtime with SQL null semantics", async () => {
    const zod = await zodFor(runtimeSql);
    const tmpRoot = join(process.cwd(), ".tmp");
    await mkdir(tmpRoot, { recursive: true });
    const moduleRoot = await mkdtemp(join(tmpRoot, "supa-check-runtime-"));
    await writeFile(join(moduleRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(join(moduleRoot, "schemas.ts"), zod);
    await writeFile(
      join(moduleRoot, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            outDir: "dist",
            skipLibCheck: true,
            strict: true,
            target: "ES2022",
          },
          files: ["schemas.ts"],
        },
        null,
        2
      )}\n`
    );
    await execFileAsync(
      process.execPath,
      [
        join(process.cwd(), "node_modules", "@typescript", "native", "bin", "tsc"),
        "--project",
        join(moduleRoot, "tsconfig.json"),
        "--pretty",
        "false",
      ],
      { cwd: moduleRoot, maxBuffer: 1024 * 1024 }
    );
    const modulePath = join(moduleRoot, "dist", "schemas.js");
    const imported = await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
    const orders = imported.SupaschemaZod.public.Tables.orders;

    expect(orders.Insert.safeParse({ price: -1 }).success).toBe(false);
    expect(orders.Insert.safeParse({ price: 0 }).success).toBe(true);
    expect(orders.Insert.safeParse({ price: 1, name: null }).success).toBe(true);
    expect(orders.Insert.safeParse({ price: 1, name: "😀😀😀" }).success).toBe(true);
    expect(orders.Insert.safeParse({ price: 1, name: "abcde" }).success).toBe(false);
    expect(orders.Insert.safeParse({ price: 1, min_qty: 5, max_qty: 3 }).success).toBe(false);
    expect(orders.Insert.safeParse({ price: 1, min_qty: 3, max_qty: 5 }).success).toBe(true);
    expect(orders.Insert.safeParse({ price: 1, min_qty: 5 }).success).toBe(true);
    expect(orders.Insert.safeParse({ price: 1, min_qty: null, max_qty: 3 }).success).toBe(true);
    expect(orders.Update.safeParse({ max_qty: 3 }).success).toBe(true);
    expect(
      orders.Row.safeParse({ id: 1, price: 0, name: null, min_qty: null, max_qty: null }).success
    ).toBe(true);
  }, 20_000);

  it.skipIf(!databaseUrl)(
    "accepts values that PostgreSQL rounds before CHECK evaluation",
    { timeout: 20_000 },
    async () => {
      if (!databaseUrl) {
        return;
      }
      const client = new Client({ connectionString: databaseUrl });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query(`CREATE TEMP TABLE check_wire_rounding (
          ratio real CHECK (ratio <= 0.5),
          scaled numeric(3, 1) CHECK (scaled <= 0.5)
        ) ON COMMIT DROP`);
        const result = await client.query(
          "INSERT INTO check_wire_rounding (ratio, scaled) VALUES ($1, $2) RETURNING ratio, scaled",
          [0.500_000_01, 0.54]
        );

        expect(result.rows[0]?.ratio).toBe(0.5);
        expect(Number(result.rows[0]?.scaled)).toBe(0.5);
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
    }
  );
});
