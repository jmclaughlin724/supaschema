import { describe, expect, it } from "vitest";
import { extractRoutineExecuteGrantees } from "../../src/catalog/extract.js";
import {
  collectDefaultPrivileges,
  collectGrants,
  collectRoutineExecuteGrantees,
} from "../../src/catalog/grants.js";
import type { CatalogQuery } from "../../src/catalog/query.js";
import { applySql, withTemporaryDatabases } from "../../src/database/admin.js";
import { resolveDatabaseUrl } from "../../src/database/url.js";
import { extractObjectsFromSql } from "../../src/sql/extract.js";

const databaseUrl = process.env.SUPASCHEMA_TEST_DATABASE_URL ?? resolveDatabaseUrl();

type GrantQueryName = "column" | "function" | "relation" | "revoked-functions" | "schema" | "type";

interface CatalogCall {
  name: GrantQueryName;
  sql: string;
}

function grantQueryName(sql: string): GrantQueryName {
  if (sql.includes("lateral aclexplode(c.relacl)")) {
    return "relation";
  }
  if (sql.includes("lateral aclexplode(a.attacl)")) {
    return "column";
  }
  if (sql.includes("lateral aclexplode(n.nspacl)")) {
    return "schema";
  }
  if (sql.includes("lateral aclexplode(p.proacl)")) {
    return "function";
  }
  if (sql.includes("from pg_proc p")) {
    return "revoked-functions";
  }
  if (sql.includes("lateral aclexplode(t.typacl)")) {
    return "type";
  }
  throw new Error(`Unexpected catalog query: ${sql}`);
}

function grantPool(
  fixtures: Partial<Record<GrantQueryName, Record<string, unknown>[]>>,
  calls: CatalogCall[] = []
): { calls: CatalogCall[]; pool: CatalogQuery } {
  return {
    calls,
    pool: {
      query(sql: string) {
        const name = grantQueryName(sql);
        calls.push({ name, sql });
        return Promise.resolve({ rows: fixtures[name] ?? [] });
      },
    },
  };
}

describe("catalog grant extraction", () => {
  it("collects relation then column ACLs and merges scoped privileges", async () => {
    const { calls, pool } = grantPool({
      column: [
        {
          columns: ["name", "id"],
          grantee: "app_user",
          is_grantable: false,
          name: "items",
          privilege: "SELECT",
          relkind: "r",
          schema: "app",
        },
      ],
      relation: [
        {
          grantee: "app_user",
          is_grantable: false,
          name: "items",
          privileges: ["INSERT"],
          relkind: "r",
          schema: "app",
        },
      ],
    });

    const objects = await collectGrants(pool);

    expect(calls.map((call) => call.name)).toEqual([
      "relation",
      "column",
      "schema",
      "function",
      "revoked-functions",
      "type",
    ]);
    const relationSql = calls.find((call) => call.name === "relation")?.sql ?? "";
    expect(relationSql).toContain("c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')");
    expect(relationSql).toContain("i.objsubid = 0");
    expect(relationSql).toContain("ia.grantor = acl.grantor");
    expect(relationSql).toContain("ia.grantee = acl.grantee");
    expect(relationSql).toContain("ia.privilege_type = acl.privilege_type");
    expect(relationSql).toContain("ia.is_grantable = acl.is_grantable");

    const columnSql = calls.find((call) => call.name === "column")?.sql ?? "";
    expect(columnSql).toContain("a.attnum > 0");
    expect(columnSql).toContain("not a.attisdropped");
    expect(columnSql).toContain("i.objsubid = a.attnum");
    expect(columnSql).toContain("ia.grantor = acl.grantor");
    expect(columnSql).toContain("ia.grantee = acl.grantee");
    expect(columnSql).toContain("ia.privilege_type = acl.privilege_type");
    expect(columnSql).toContain("ia.is_grantable = acl.is_grantable");

    expect(objects).toHaveLength(1);
    expect(objects[0]?.metadata).toMatchObject({
      columnPrivileges: { SELECT: ["id", "name"] },
      grantOptionPrivileges: [],
      grantee: "app_user",
      privileges: ["INSERT", "SELECT"],
    });
    expect(objects[0]?.sql).toBe(
      'GRANT INSERT, SELECT ("id", "name") ON TABLE "app"."items" TO "app_user"'
    );
  });

  it("lets an object-wide privilege dominate its column-scoped form", async () => {
    const { pool } = grantPool({
      column: [
        {
          columns: ["id"],
          grantee: "app_user",
          is_grantable: false,
          name: "items",
          privilege: "SELECT",
          relkind: "r",
          schema: "app",
        },
      ],
      relation: [
        {
          grantee: "app_user",
          is_grantable: false,
          name: "items",
          privileges: ["SELECT"],
          relkind: "r",
          schema: "app",
        },
      ],
    });

    const [grant] = await collectGrants(pool);

    expect(grant?.metadata.privileges).toEqual(["SELECT"]);
    expect(grant?.metadata).not.toHaveProperty("columnPrivileges");
    expect(grant?.sql).toBe('GRANT SELECT ON TABLE "app"."items" TO "app_user"');
  });

  it("canonicalizes expanded catalog column ACLs like a declared GRANT ALL", async () => {
    const columns = ["name", "id"];
    const { pool } = grantPool({
      column: ["INSERT", "REFERENCES", "SELECT", "UPDATE"].map((privilege) => ({
        columns,
        grantee: "app_user",
        is_grantable: false,
        name: "items",
        privilege,
        relkind: "r",
        schema: "app",
      })),
    });

    const [catalogGrant] = await collectGrants(pool);
    const declared = await extractObjectsFromSql(
      "GRANT ALL (id, name) ON TABLE app.items TO app_user;"
    );
    const [declaredGrant] = declared.objects;

    expect(declared.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
    expect(catalogGrant?.metadata).toMatchObject({
      columnPrivileges: declaredGrant?.metadata.columnPrivileges,
      privileges: declaredGrant?.metadata.privileges,
    });
    expect(catalogGrant?.sql).toBe(declaredGrant?.sql);
  });

  it("preserves uniform grant options for every positive ACL kind", async () => {
    const { pool } = grantPool({
      function: [
        {
          args: "integer",
          grantee: "app_user",
          is_grantable: true,
          name: "run_task",
          privileges: ["EXECUTE"],
          schema: "app",
        },
      ],
      relation: [
        {
          grantee: "app_user",
          is_grantable: true,
          name: "remote_items",
          privileges: ["SELECT"],
          relkind: "f",
          schema: "app",
        },
      ],
      schema: [
        {
          grantee: "app_user",
          is_grantable: true,
          name: "app",
          privileges: ["USAGE"],
        },
      ],
      type: [
        {
          grantee: "app_user",
          is_grantable: true,
          name: "status",
          privileges: ["USAGE"],
          schema: "app",
          typtype: "e",
        },
      ],
    });

    const objects = await collectGrants(pool);

    expect(objects).toHaveLength(4);
    expect(
      objects.every(
        (object) =>
          JSON.stringify(object.metadata.grantOptionPrivileges) ===
          JSON.stringify(object.metadata.privileges)
      )
    ).toBe(true);
    expect(objects.every((object) => object.sql.endsWith(" WITH GRANT OPTION"))).toBe(true);
    expect(
      objects.find((object) => object.metadata.targetIdentity === "app.remote_items")?.sql
    ).toBe('GRANT SELECT ON TABLE "app"."remote_items" TO "app_user" WITH GRANT OPTION');
  });

  it("preserves mixed grant-option states for one semantic grant", async () => {
    const { pool } = grantPool({
      relation: [
        {
          grantee: "app_user",
          is_grantable: false,
          name: "items",
          privileges: ["INSERT"],
          relkind: "r",
          schema: "app",
        },
        {
          grantee: "app_user",
          is_grantable: true,
          name: "items",
          privileges: ["SELECT"],
          relkind: "r",
          schema: "app",
        },
      ],
    });

    const [grant] = await collectGrants(pool);

    expect(grant?.metadata).toMatchObject({
      grantOptionPrivileges: ["SELECT"],
      privileges: ["INSERT", "SELECT"],
    });
    expect(grant?.sql).toBe(
      'GRANT INSERT, SELECT ON TABLE "app"."items" TO "app_user";\n' +
        'GRANT SELECT ON TABLE "app"."items" TO "app_user" WITH GRANT OPTION'
    );
  });
});

describe("applied routine EXECUTE grantees", () => {
  it("groups non-owner EXECUTE grantees from explicit and default routine ACLs", async () => {
    const calls: string[] = [];
    const pool: CatalogQuery = {
      query(sql) {
        calls.push(sql);
        return Promise.resolve({
          rows: [
            {
              args: "uuid, text",
              grantees: ["PUBLIC", "service_role"],
              name: "store_secret",
              schema: "app",
            },
            { args: "", grantees: "{PUBLIC}", name: "ping", schema: "app" },
          ],
        });
      },
    };

    const granteesByRoutine = await collectRoutineExecuteGrantees(pool);

    expect(granteesByRoutine).toEqual(
      new Map([
        ["app.store_secret(uuid, text)", new Set(["PUBLIC", "service_role"])],
        ["app.ping()", new Set(["PUBLIC"])],
      ])
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("aclexplode(coalesce(p.proacl, acldefault('f', p.proowner)))");
    expect(calls[0]).toContain("acl.grantee <> p.proowner");
  });

  it("keys catalog routine signatures the way declarative REVOKE targets are keyed", async () => {
    const pool: CatalogQuery = {
      query() {
        return Promise.resolve({
          rows: [
            {
              args: 'app."Mood", double precision[]',
              grantees: ["anon"],
              name: "set_mood",
              schema: "app",
            },
          ],
        });
      },
    };
    const declared = await extractObjectsFromSql(
      'REVOKE ALL ON FUNCTION app.set_mood(app."Mood", double precision[]) FROM anon;'
    );
    const declaredIdentity = declared.objects.find((object) => object.metadata.verb === "REVOKE")
      ?.metadata.targetIdentity;

    const granteesByRoutine = await collectRoutineExecuteGrantees(pool);

    expect(typeof declaredIdentity).toBe("string");
    expect([...granteesByRoutine.keys()]).toEqual([declaredIdentity]);
    expect(granteesByRoutine.get(String(declaredIdentity))).toEqual(new Set(["anon"]));
  });

  it.skipIf(!databaseUrl)(
    "reads PUBLIC EXECUTE from a default routine ACL and omits a revoked routine",
    async () => {
      if (databaseUrl === undefined) {
        throw new Error("expected a verification database URL");
      }
      await withTemporaryDatabases(databaseUrl, 1, async ([url]) => {
        if (!url) {
          throw new Error("expected temporary database URL");
        }
        await applySql(
          url,
          `CREATE SCHEMA app;
           CREATE TYPE app."Mood" AS ENUM ('calm');
           CREATE FUNCTION app.default_acl(p_id uuid) RETURNS uuid LANGUAGE sql AS $$ SELECT p_id $$;
           CREATE FUNCTION app.mood_echo(p_mood app."Mood") RETURNS app."Mood" LANGUAGE sql AS $$ SELECT p_mood $$;
           CREATE FUNCTION app.revoked(p_at timestamptz) RETURNS timestamptz LANGUAGE sql AS $$ SELECT p_at $$;
           REVOKE ALL ON FUNCTION app.revoked(timestamptz) FROM PUBLIC;`
        );

        const granteesByRoutine = await extractRoutineExecuteGrantees({ databaseUrl: url });

        expect(granteesByRoutine).toBeInstanceOf(Map);
        expect(granteesByRoutine).toEqual(
          new Map([
            ["app.default_acl(uuid)", new Set(["PUBLIC"])],
            ["app.mood_echo(app.Mood)", new Set(["PUBLIC"])],
          ])
        );
      });
    }
  );
});

describe("catalog default privilege extraction", () => {
  it("filters extension-owned default ACL rows through pg_depend", async () => {
    const calls: string[] = [];
    const pool: CatalogQuery = {
      query(sql) {
        calls.push(sql);
        return Promise.resolve({ rows: [] });
      },
    };

    await collectDefaultPrivileges(pool);

    expect(calls).toHaveLength(2);
    expect(
      calls.every((sql) => sql.includes("d.defaclrole = current_user::regrole as is_current_role"))
    ).toBe(true);
    expect(
      calls.every((sql) => sql.includes("ext_member.classid = 'pg_default_acl'::regclass"))
    ).toBe(true);
    expect(calls.every((sql) => sql.includes("ext.extnamespace = d.defaclnamespace"))).toBe(true);
  });

  it("normalizes the catalog executor to the omitted current-role scope", async () => {
    const pool: CatalogQuery = {
      query(sql: string) {
        if (!sql.includes("lateral aclexplode(d.defaclacl)")) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({
          rows: [
            {
              for_role: "postgres",
              grantee: "app_user",
              is_current_role: true,
              is_grantable: false,
              objtype: "r",
              privileges: ["SELECT"],
              schema: "app",
            },
          ],
        });
      },
    };

    const objects = await collectDefaultPrivileges(pool);

    expect(objects).toHaveLength(1);
    expect(objects[0]?.ref.name).toContain("for current-role");
    expect(objects[0]?.sql).not.toContain("FOR ROLE");
    expect(objects[0]?.metadata.forRole).toBeUndefined();
  });

  it("preserves default ACL grant options", async () => {
    const pool: CatalogQuery = {
      query(sql: string) {
        if (!sql.includes("lateral aclexplode(d.defaclacl)")) {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({
          rows: [
            {
              for_role: "app_owner",
              grantee: "app_user",
              is_grantable: true,
              objtype: "r",
              privileges: ["SELECT"],
              schema: "app",
            },
          ],
        });
      },
    };

    const [grant] = await collectDefaultPrivileges(pool);

    expect(grant?.metadata).toMatchObject({
      grantOptionPrivileges: ["SELECT"],
      privileges: ["SELECT"],
    });
    expect(grant?.sql).toBe(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "app_owner" IN SCHEMA "app" ' +
        'GRANT SELECT ON TABLES TO "app_user" WITH GRANT OPTION'
    );
  });
});
