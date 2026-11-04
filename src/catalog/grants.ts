import { asRecord, astStatements, objectWithArgsIdentity, readArray } from "../sql/ast.js";
import { formatQualifiedName } from "../sql/identifiers.js";
import { parseSqlAst } from "../sql/parser.js";
import {
  buildDefaultPrivilegeObject,
  buildGrantObject,
  isBuiltinDefaultGrant,
  mergePrivilegeMetadata,
} from "../sql/privileges.js";
import type { SchemaObject } from "../types.js";
import {
  type CatalogQuery,
  catalogSchemaFilter,
  notExtensionMember,
  text,
  textArray,
} from "./query.js";

const defaultPrivilegeObjectTypes = new Map([
  ["S", "SEQUENCES"],
  ["T", "TYPES"],
  ["f", "FUNCTIONS"],
  ["n", "SCHEMAS"],
  ["r", "TABLES"],
]);

interface CatalogGrant {
  columnPrivileges?: Record<string, string[]>;
  grantee: string;
  kindPhrase: string;
  privileges: string[];
  schema?: string;
  targetIdentity: string;
  targetRendered: string;
  withGrantOption: boolean;
}

type CatalogGrantGroups = Map<string, CatalogGrant[]>;

interface CatalogDefaultPrivilege {
  forRole?: string;
  grantee: string;
  objectType: string;
  privileges: string[];
  schema?: string;
  withGrantOption: boolean;
}

type CatalogDefaultPrivilegeGroups = Map<string, CatalogDefaultPrivilege[]>;

function addCatalogGrant(groups: CatalogGrantGroups, grant: CatalogGrant): void {
  const identity = [grant.kindPhrase, grant.targetIdentity, grant.grantee].join(":");
  const grants = groups.get(identity) ?? [];
  grants.push(grant);
  groups.set(identity, grants);
}

function buildCatalogGrants(groups: CatalogGrantGroups): SchemaObject[] {
  const objects: SchemaObject[] = [];
  for (const [identity, grants] of groups) {
    const first = grants[0];
    if (!first) {
      continue;
    }
    const merged = mergePrivilegeMetadata(
      grants.map((grant) => ({
        ...(grant.columnPrivileges ? { columnPrivileges: grant.columnPrivileges } : {}),
        privileges: grant.privileges,
        withGrantOption: grant.withGrantOption,
      }))
    );
    if (!merged) {
      throw new Error(`Catalog grant ${identity} has invalid privilege metadata`);
    }
    objects.push(
      buildGrantObject({
        ...(merged.columnPrivileges ? { columnPrivileges: merged.columnPrivileges } : {}),
        ...(merged.grantOptionColumnPrivileges
          ? { grantOptionColumnPrivileges: merged.grantOptionColumnPrivileges }
          : {}),
        grantOptionPrivileges: merged.grantOptionPrivileges,
        grantee: first.grantee,
        kindPhrase: first.kindPhrase,
        ordinal: 0,
        privileges: merged.privileges,
        ...(first.schema ? { schema: first.schema } : {}),
        targetIdentity: first.targetIdentity,
        targetRendered: first.targetRendered,
        verb: "GRANT",
      })
    );
  }
  return objects;
}

function catalogGrantOption(value: unknown, identity: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`Catalog grant ${identity} has an invalid grant-option state`);
  }
  return value;
}

export async function collectGrants(pool: CatalogQuery): Promise<SchemaObject[]> {
  const objects: SchemaObject[] = [];
  const relationGrantGroups: CatalogGrantGroups = new Map();
  const relationGrants = await pool.query(`
    select n.nspname as schema, c.relname as name, c.relkind as relkind,
      case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end as grantee,
      array_agg(distinct acl.privilege_type order by acl.privilege_type) as privileges,
      acl.is_grantable as is_grantable
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace,
    lateral aclexplode(c.relacl) as acl
    where c.relacl is not null
      and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
      and ${catalogSchemaFilter(pool)}
      and ${notExtensionMember("c", "pg_class")}
      and acl.grantee <> c.relowner
      and not exists (
        select 1 from pg_init_privs i, lateral aclexplode(i.initprivs) ia
        where i.objoid = c.oid and i.classoid = 'pg_class'::regclass
          and i.objsubid = 0
          and ia.grantor = acl.grantor
          and ia.grantee = acl.grantee
          and ia.privilege_type = acl.privilege_type
          and ia.is_grantable = acl.is_grantable
      )
    group by n.nspname, c.relname, c.relkind, acl.grantee, acl.is_grantable
    order by n.nspname, c.relname, grantee, acl.is_grantable
  `);
  for (const row of relationGrants.rows) {
    const schema = text(row.schema);
    const name = text(row.name);
    const kindPhrase = text(row.relkind) === "S" ? "SEQUENCE" : "TABLE";
    const targetIdentity = `${schema}.${name}`;
    addCatalogGrant(relationGrantGroups, {
      grantee: text(row.grantee),
      kindPhrase,
      privileges: textArray(row.privileges),
      schema,
      targetIdentity,
      targetRendered: formatQualifiedName(schema, name),
      withGrantOption: catalogGrantOption(row.is_grantable, targetIdentity),
    });
  }

  const columnGrants = await pool.query(`
    select n.nspname as schema, c.relname as name, c.relkind as relkind,
      case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end as grantee,
      acl.privilege_type as privilege,
      array_agg(distinct a.attname order by a.attname) as columns,
      acl.is_grantable as is_grantable
    from pg_attribute a
    join pg_class c on c.oid = a.attrelid
    join pg_namespace n on n.oid = c.relnamespace,
    lateral aclexplode(a.attacl) as acl
    where a.attacl is not null
      and a.attnum > 0
      and not a.attisdropped
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and ${catalogSchemaFilter(pool)}
      and ${notExtensionMember("c", "pg_class")}
      and acl.grantee <> c.relowner
      and not exists (
        select 1 from pg_init_privs i, lateral aclexplode(i.initprivs) ia
        where i.objoid = c.oid and i.classoid = 'pg_class'::regclass
          and i.objsubid = a.attnum
          and ia.grantor = acl.grantor
          and ia.grantee = acl.grantee
          and ia.privilege_type = acl.privilege_type
          and ia.is_grantable = acl.is_grantable
      )
    group by n.nspname, c.relname, c.relkind, acl.grantee,
      acl.privilege_type, acl.is_grantable
    order by n.nspname, c.relname, grantee, acl.privilege_type, acl.is_grantable
  `);
  for (const row of columnGrants.rows) {
    const schema = text(row.schema);
    const name = text(row.name);
    const privilege = text(row.privilege);
    const targetIdentity = `${schema}.${name}`;
    addCatalogGrant(relationGrantGroups, {
      columnPrivileges: { [privilege]: textArray(row.columns) },
      grantee: text(row.grantee),
      kindPhrase: "TABLE",
      privileges: [privilege],
      schema,
      targetIdentity,
      targetRendered: formatQualifiedName(schema, name),
      withGrantOption: catalogGrantOption(row.is_grantable, targetIdentity),
    });
  }
  objects.push(...buildCatalogGrants(relationGrantGroups));

  const schemaGrantGroups: CatalogGrantGroups = new Map();
  const schemaGrants = await pool.query(`
    select n.nspname as name,
      case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end as grantee,
      array_agg(distinct acl.privilege_type order by acl.privilege_type) as privileges,
      acl.is_grantable as is_grantable
    from pg_namespace n,
    lateral aclexplode(n.nspacl) as acl
    where n.nspacl is not null
      and ${catalogSchemaFilter(pool)}
      and acl.grantee <> n.nspowner
      and not exists (
        select 1 from pg_init_privs i, lateral aclexplode(i.initprivs) ia
        where i.objoid = n.oid and i.classoid = 'pg_namespace'::regclass
          and i.objsubid = 0
          and ia.grantor = acl.grantor
          and ia.grantee = acl.grantee
          and ia.privilege_type = acl.privilege_type
          and ia.is_grantable = acl.is_grantable
      )
    group by n.nspname, acl.grantee, acl.is_grantable
    order by n.nspname, grantee, acl.is_grantable
  `);
  for (const row of schemaGrants.rows) {
    const name = text(row.name);
    addCatalogGrant(schemaGrantGroups, {
      grantee: text(row.grantee),
      kindPhrase: "SCHEMA",
      privileges: textArray(row.privileges),
      schema: name,
      targetIdentity: name,
      targetRendered: `"${name}"`,
      withGrantOption: catalogGrantOption(row.is_grantable, name),
    });
  }
  objects.push(...buildCatalogGrants(schemaGrantGroups));

  const functionGrantGroups: CatalogGrantGroups = new Map();
  const functionGrants = await pool.query(`
    select n.nspname as schema, p.proname as name,
      oidvectortypes(p.proargtypes) as args,
      case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end as grantee,
      array_agg(distinct acl.privilege_type order by acl.privilege_type) as privileges,
      acl.is_grantable as is_grantable
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace,
    lateral aclexplode(p.proacl) as acl
    where p.proacl is not null
      and ${catalogSchemaFilter(pool)}
      and ${notExtensionMember("p", "pg_proc")}
      and acl.grantee <> p.proowner
      and not exists (
        select 1 from pg_init_privs i, lateral aclexplode(i.initprivs) ia
        where i.objoid = p.oid and i.classoid = 'pg_proc'::regclass
          and i.objsubid = 0
          and ia.grantor = acl.grantor
          and ia.grantee = acl.grantee
          and ia.privilege_type = acl.privilege_type
          and ia.is_grantable = acl.is_grantable
      )
    group by n.nspname, p.proname, args, acl.grantee, acl.is_grantable
    order by n.nspname, p.proname, grantee, acl.is_grantable
  `);
  for (const row of functionGrants.rows) {
    const schema = text(row.schema);
    const name = text(row.name);
    const args = text(row.args);
    const grantee = text(row.grantee);
    const privileges = textArray(row.privileges);
    const targetIdentity = await routineIdentity(schema, name, args);
    const withGrantOption = catalogGrantOption(row.is_grantable, targetIdentity);
    if (!withGrantOption && isBuiltinDefaultGrant("FUNCTION", grantee, privileges)) {
      continue;
    }
    addCatalogGrant(functionGrantGroups, {
      grantee,
      kindPhrase: "FUNCTION",
      privileges,
      schema,
      targetIdentity,
      targetRendered: `${formatQualifiedName(schema, name)}(${args})`,
      withGrantOption,
    });
  }
  objects.push(...buildCatalogGrants(functionGrantGroups));

  const revokedFunctionDefaults = await pool.query(`
    select n.nspname as schema, p.proname as name, oidvectortypes(p.proargtypes) as args
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where p.proacl is not null
      and ${catalogSchemaFilter(pool)}
      and ${notExtensionMember("p", "pg_proc")}
      and not exists (
        select 1 from aclexplode(p.proacl) acl
        where acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
      )
    order by n.nspname, p.proname
  `);
  for (const row of revokedFunctionDefaults.rows) {
    const schema = text(row.schema);
    const name = text(row.name);
    const args = text(row.args);
    objects.push(
      buildGrantObject({
        grantee: "PUBLIC",
        kindPhrase: "FUNCTION",
        ordinal: 0,
        privileges: ["ALL"],
        schema,
        targetIdentity: await routineIdentity(schema, name, args),
        targetRendered: `${formatQualifiedName(schema, name)}(${args})`,
        verb: "REVOKE",
      })
    );
  }
  const typeGrantGroups: CatalogGrantGroups = new Map();
  const typeGrants = await pool.query(`
    select n.nspname as schema, t.typname as name, t.typtype as typtype,
      case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end as grantee,
      array_agg(distinct acl.privilege_type order by acl.privilege_type) as privileges,
      acl.is_grantable as is_grantable
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace,
    lateral aclexplode(t.typacl) as acl
    where t.typacl is not null
      and t.typtype in ('e', 'd', 'c', 'r')
      and ${catalogSchemaFilter(pool)}
      and ${notExtensionMember("t", "pg_type")}
      and acl.grantee <> t.typowner
      and not exists (
        select 1 from pg_init_privs i, lateral aclexplode(i.initprivs) ia
        where i.objoid = t.oid and i.classoid = 'pg_type'::regclass
          and i.objsubid = 0
          and ia.grantor = acl.grantor
          and ia.grantee = acl.grantee
          and ia.privilege_type = acl.privilege_type
          and ia.is_grantable = acl.is_grantable
      )
    group by n.nspname, t.typname, t.typtype, acl.grantee, acl.is_grantable
    order by n.nspname, t.typname, grantee, acl.is_grantable
  `);
  for (const row of typeGrants.rows) {
    const schema = text(row.schema);
    const name = text(row.name);
    const grantee = text(row.grantee);
    const privileges = textArray(row.privileges);
    const kindPhrase = text(row.typtype) === "d" ? "DOMAIN" : "TYPE";
    const targetIdentity = `${schema}.${name}`;
    const withGrantOption = catalogGrantOption(row.is_grantable, targetIdentity);
    if (!withGrantOption && isBuiltinDefaultGrant(kindPhrase, grantee, privileges)) {
      continue;
    }
    addCatalogGrant(typeGrantGroups, {
      grantee,
      kindPhrase,
      privileges,
      schema,
      targetIdentity,
      targetRendered: formatQualifiedName(schema, name),
      withGrantOption,
    });
  }
  objects.push(...buildCatalogGrants(typeGrantGroups));
  return objects;
}

export async function collectRoutineExecuteGrantees(
  pool: CatalogQuery
): Promise<Map<string, Set<string>>> {
  const rows = await pool.query(`
    select n.nspname as schema, p.proname as name,
      oidvectortypes(p.proargtypes) as args,
      array_agg(case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end) as grantees
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace,
    lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) as acl
    where acl.privilege_type = 'EXECUTE'
      and acl.grantee <> p.proowner
      and ${catalogSchemaFilter(pool)}
      and ${notExtensionMember("p", "pg_proc")}
    group by n.nspname, p.proname, args
  `);
  return new Map(
    await Promise.all(
      rows.rows.map(
        async (row): Promise<[string, Set<string>]> => [
          await routineIdentity(text(row.schema), text(row.name), text(row.args)),
          new Set(textArray(row.grantees)),
        ]
      )
    )
  );
}

async function routineIdentity(schema: string, name: string, args: string): Promise<string> {
  const sql = `DROP FUNCTION pg_temp.catalog_routine_signature(${args});`;
  const parsed = await parseSqlAst(sql);
  const dropStatement = asRecord(astStatements(parsed.ast, sql)[0]?.node.DropStmt);
  const identity = objectWithArgsIdentity(readArray(dropStatement?.objects)[0]);
  if (!identity) {
    throw new Error(`Catalog routine signature for ${schema}.${name}(${args}) did not parse`);
  }
  return `${schema}.${name}(${identity.signature})`;
}

export async function collectDefaultPrivileges(pool: CatalogQuery): Promise<SchemaObject[]> {
  return [
    ...(await collectGrantedDefaultPrivileges(pool)),
    ...(await collectRevokedDefaultPrivileges(pool)),
  ];
}

async function collectGrantedDefaultPrivileges(pool: CatalogQuery): Promise<SchemaObject[]> {
  const grantGroups: CatalogDefaultPrivilegeGroups = new Map();
  const rows = await pool.query(`
    select pg_get_userbyid(d.defaclrole) as for_role,
      d.defaclrole = current_user::regrole as is_current_role,
      case when d.defaclnamespace = 0 then null else n.nspname end as schema,
      d.defaclobjtype as objtype,
      case when acl.grantee = 0 then 'PUBLIC' else pg_get_userbyid(acl.grantee) end as grantee,
      array_agg(distinct acl.privilege_type order by acl.privilege_type) as privileges,
      acl.is_grantable as is_grantable
    from pg_default_acl d
    left join pg_namespace n on n.oid = d.defaclnamespace,
    lateral aclexplode(d.defaclacl) as acl
    where (d.defaclnamespace = 0 or (${catalogSchemaFilter(pool)}))
      and ${notExtensionMember("d", "pg_default_acl")}
      and not exists (
        select 1
        from pg_extension ext
        where ext.extnamespace = d.defaclnamespace
      )
    group by d.defaclrole, schema, d.defaclobjtype, acl.grantee, acl.is_grantable
    order by for_role, schema, d.defaclobjtype, grantee, acl.is_grantable
  `);
  for (const row of rows.rows) {
    const objectType = defaultPrivilegeObjectTypes.get(text(row.objtype));
    if (!objectType) {
      continue;
    }
    const ownerRole = text(row.for_role);
    const forRole = row.is_current_role === true ? undefined : ownerRole;
    const grantee = text(row.grantee);
    const privileges = textArray(row.privileges);
    const identity = `${ownerRole}:${text(row.objtype)}:${grantee}`;
    const withGrantOption = catalogGrantOption(row.is_grantable, identity);

    if (
      grantee === ownerRole ||
      (!withGrantOption && isBuiltinDefaultGrant(objectType, grantee, privileges))
    ) {
      continue;
    }
    const schema = row.schema === null ? undefined : text(row.schema);
    const key = [forRole ?? "", schema ?? "", objectType, grantee].join(":");
    const group = grantGroups.get(key) ?? [];
    group.push({
      ...(forRole === undefined ? {} : { forRole }),
      grantee,
      objectType,
      privileges,
      ...(schema === undefined ? {} : { schema }),
      withGrantOption,
    });
    grantGroups.set(key, group);
  }
  return buildCatalogDefaultPrivileges(grantGroups);
}

function buildCatalogDefaultPrivileges(grantGroups: CatalogDefaultPrivilegeGroups): SchemaObject[] {
  const objects: SchemaObject[] = [];
  for (const [identity, grants] of grantGroups) {
    const first = grants[0];
    if (!first) {
      continue;
    }
    const merged = mergePrivilegeMetadata(
      grants.map((grant) => ({
        privileges: grant.privileges,
        withGrantOption: grant.withGrantOption,
      }))
    );
    if (!merged) {
      throw new Error(`Catalog default privilege ${identity} has invalid privilege metadata`);
    }
    objects.push(
      buildDefaultPrivilegeObject({
        forRole: first.forRole,
        grantOptionPrivileges: merged.grantOptionPrivileges,
        grantee: first.grantee,
        objectType: first.objectType,
        ordinal: 0,
        privileges: merged.privileges,
        schema: first.schema,
        verb: "GRANT",
      })
    );
  }
  return objects;
}

async function collectRevokedDefaultPrivileges(pool: CatalogQuery): Promise<SchemaObject[]> {
  const objects: SchemaObject[] = [];
  const revokedDefaults = await pool.query(`
    select pg_get_userbyid(d.defaclrole) as for_role,
      d.defaclrole = current_user::regrole as is_current_role,
      case when d.defaclnamespace = 0 then null else n.nspname end as schema,
      d.defaclobjtype as objtype
    from pg_default_acl d
    left join pg_namespace n on n.oid = d.defaclnamespace
    where d.defaclobjtype in ('f', 'T')
      and (d.defaclnamespace = 0 or (${catalogSchemaFilter(pool)}))
      and ${notExtensionMember("d", "pg_default_acl")}
      and not exists (
        select 1
        from pg_extension ext
        where ext.extnamespace = d.defaclnamespace
      )
      and not exists (
        select 1 from aclexplode(d.defaclacl) acl where acl.grantee = 0
      )
    order by for_role, schema, objtype
  `);
  for (const row of revokedDefaults.rows) {
    const objectType = defaultPrivilegeObjectTypes.get(text(row.objtype));
    if (!objectType) {
      continue;
    }
    const forRole = row.is_current_role === true ? undefined : text(row.for_role);
    objects.push(
      buildDefaultPrivilegeObject({
        forRole,
        grantee: "PUBLIC",
        objectType,
        ordinal: 0,
        privileges: ["ALL"],
        schema: row.schema === null ? undefined : text(row.schema),
        verb: "REVOKE",
      })
    );
  }
  return objects;
}
