import { sha256 } from "../hash.js";
import type { CommentTarget, ObjectRef, SchemaObject } from "../types.js";
import type { AstNode } from "./ast.js";
import {
  asRecord,
  listItems,
  objectWithArgsIdentity,
  qualifiedName,
  rangeVarName,
  readArray,
  readBoolean,
  readString,
  roleSpecName,
  stringList,
  stringValue,
  typeNameToSql,
} from "./ast.js";
import { formatQualifiedName, normalizeSql, quoteIdent } from "./identifiers.js";
import { makeObject } from "./statements.js";

const grantObjectKinds = new Map([
  ["OBJECT_DATABASE", "DATABASE"],
  ["OBJECT_DOMAIN", "DOMAIN"],
  ["OBJECT_FDW", "FOREIGN DATA WRAPPER"],
  ["OBJECT_FOREIGN_SERVER", "FOREIGN SERVER"],
  ["OBJECT_FUNCTION", "FUNCTION"],
  ["OBJECT_LANGUAGE", "LANGUAGE"],
  ["OBJECT_LARGEOBJECT", "LARGE OBJECT"],
  ["OBJECT_PROCEDURE", "PROCEDURE"],
  ["OBJECT_ROUTINE", "ROUTINE"],
  ["OBJECT_SCHEMA", "SCHEMA"],
  ["OBJECT_SEQUENCE", "SEQUENCE"],
  ["OBJECT_TABLE", "TABLE"],
  ["OBJECT_TABLESPACE", "TABLESPACE"],
  ["OBJECT_TYPE", "TYPE"],
]);

const allInSchemaKinds = new Map([
  ["OBJECT_FUNCTION", "ALL FUNCTIONS IN SCHEMA"],
  ["OBJECT_PROCEDURE", "ALL PROCEDURES IN SCHEMA"],
  ["OBJECT_ROUTINE", "ALL ROUTINES IN SCHEMA"],
  ["OBJECT_SEQUENCE", "ALL SEQUENCES IN SCHEMA"],
  ["OBJECT_TABLE", "ALL TABLES IN SCHEMA"],
]);

const defaultPrivilegeKinds = new Map([
  ["OBJECT_FUNCTION", "FUNCTIONS"],
  ["OBJECT_PROCEDURE", "ROUTINES"],
  ["OBJECT_ROUTINE", "ROUTINES"],
  ["OBJECT_SCHEMA", "SCHEMAS"],
  ["OBJECT_SEQUENCE", "SEQUENCES"],
  ["OBJECT_TABLE", "TABLES"],
  ["OBJECT_TYPE", "TYPES"],
]);

interface GrantTarget {
  identity: string;
  rendered: string;
  schema?: string;
}

const fullPrivilegeSets = new Map<string, string[]>([
  ["DATABASE", ["CONNECT", "CREATE", "TEMPORARY"]],
  ["DOMAIN", ["USAGE"]],
  ["FOREIGN DATA WRAPPER", ["USAGE"]],
  ["FOREIGN SERVER", ["USAGE"]],
  ["FUNCTION", ["EXECUTE"]],
  ["FUNCTIONS", ["EXECUTE"]],
  ["LANGUAGE", ["USAGE"]],
  ["LARGE OBJECT", ["SELECT", "UPDATE"]],
  ["PROCEDURE", ["EXECUTE"]],
  ["ROUTINE", ["EXECUTE"]],
  ["ROUTINES", ["EXECUTE"]],
  ["SCHEMA", ["CREATE", "USAGE"]],
  ["SCHEMAS", ["CREATE", "USAGE"]],
  ["SEQUENCE", ["SELECT", "UPDATE", "USAGE"]],
  ["SEQUENCES", ["SELECT", "UPDATE", "USAGE"]],
  ["TABLE", ["DELETE", "INSERT", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"]],
  ["TABLES", ["DELETE", "INSERT", "REFERENCES", "SELECT", "TRIGGER", "TRUNCATE", "UPDATE"]],
  ["TABLESPACE", ["CREATE"]],
  ["TYPE", ["USAGE"]],
  ["TYPES", ["USAGE"]],
]);

const columnPrivilegeNames: readonly string[] = ["INSERT", "REFERENCES", "SELECT", "UPDATE"];

const builtinPublicDefaults = new Map<string, string[]>([
  ["DOMAIN", ["USAGE"]],
  ["FUNCTION", ["EXECUTE"]],
  ["FUNCTIONS", ["EXECUTE"]],
  ["LANGUAGE", ["USAGE"]],
  ["PROCEDURE", ["EXECUTE"]],
  ["ROUTINE", ["EXECUTE"]],
  ["ROUTINES", ["EXECUTE"]],
  ["TYPE", ["USAGE"]],
  ["TYPES", ["USAGE"]],
]);

export function builtinPublicDefault(kindPhrase: string): string[] | undefined {
  const lookupKey = kindPhrase.startsWith("ALL ")
    ? (kindPhrase.split(" ")[1] ?? kindPhrase)
    : kindPhrase;
  return builtinPublicDefaults.get(lookupKey);
}

export function isBuiltinDefaultGrant(
  kindPhrase: string,
  grantee: string,
  privileges: string[]
): boolean {
  if (grantee !== "PUBLIC") {
    return false;
  }
  const defaults = builtinPublicDefault(kindPhrase);
  if (!defaults) {
    return false;
  }
  const normalized = normalizePrivileges(
    [...privileges].sort((left, right) => Number(left > right) - Number(left < right)),
    kindPhrase
  );
  return (
    normalized.join(",") === "ALL" ||
    normalized.join(",") === defaults.join(",") ||
    normalizePrivileges(defaults, kindPhrase).join(",") === normalized.join(",")
  );
}

function privilegeSetLookupKey(kindPhrase: string): string {
  return kindPhrase.startsWith("ALL ") ? (kindPhrase.split(" ")[1] ?? kindPhrase) : kindPhrase;
}

export function isSinglePrivilegeKind(kindPhrase: string): boolean {
  return fullPrivilegeSets.get(privilegeSetLookupKey(kindPhrase))?.length === 1;
}

function normalizePrivileges(privileges: string[], kindPhrase: string): string[] {
  const fullSet = fullPrivilegeSets.get(privilegeSetLookupKey(kindPhrase));
  if (!fullSet) {
    return privileges;
  }
  const granted = new Set(privileges);
  if (granted.has("ALL") || fullSet.every((privilege) => granted.has(privilege))) {
    return ["ALL"];
  }
  return privileges;
}

export interface PrivilegeMetadataInput {
  readonly columnPrivileges?: unknown;
  readonly privileges: unknown;
  readonly withGrantOption: boolean;
}

export interface PrivilegeMetadata {
  columnPrivileges?: Record<string, string[]>;
  grantOptionColumnPrivileges?: Record<string, string[]>;
  grantOptionPrivileges: string[];
  privileges: string[];
}

interface PrivilegeAccumulator {
  columnsByPrivilege: Map<string, Set<string>>;
  objectWidePrivileges: Set<string>;
}

export function mergePrivilegeMetadata(
  inputs: readonly PrivilegeMetadataInput[]
): PrivilegeMetadata | undefined {
  if (inputs.length === 0) {
    return;
  }
  const all: PrivilegeAccumulator = {
    columnsByPrivilege: new Map(),
    objectWidePrivileges: new Set(),
  };
  const grantable: PrivilegeAccumulator = {
    columnsByPrivilege: new Map(),
    objectWidePrivileges: new Set(),
  };
  for (const input of inputs) {
    if (!mergePrivilegeInput(input, all)) {
      return;
    }
    if (input.withGrantOption && !mergePrivilegeInput(input, grantable)) {
      return;
    }
  }
  const privileges = accumulatedPrivilegeSet(all);
  const grantOptions = accumulatedPrivilegeSet(grantable);
  if (!privileges) {
    return;
  }
  return {
    ...(privileges.columnPrivileges ? { columnPrivileges: privileges.columnPrivileges } : {}),
    ...(grantOptions?.columnPrivileges
      ? { grantOptionColumnPrivileges: grantOptions.columnPrivileges }
      : {}),
    grantOptionPrivileges: grantOptions?.privileges ?? [],
    privileges: privileges.privileges,
  };
}

function mergePrivilegeInput(
  input: PrivilegeMetadataInput,
  accumulator: PrivilegeAccumulator
): boolean {
  const privileges = normalizedPrivilegeNames(input.privileges);
  const columnPrivileges = normalizedColumnPrivileges(input.columnPrivileges);
  if (!privileges || columnPrivileges === null) {
    return false;
  }
  const usedColumnPrivileges = new Set<string>();
  for (const privilege of privileges) {
    const columns = columnPrivileges?.get(privilege);
    if (columns !== undefined) {
      usedColumnPrivileges.add(privilege);
    }
    mergePrivilegeValue(privilege, columns, accumulator);
  }
  return (
    columnPrivileges === undefined ||
    [...columnPrivileges.keys()].every((privilege) => usedColumnPrivileges.has(privilege))
  );
}

function normalizedPrivilegeNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return;
  }
  const privileges = value.filter(
    (privilege): privilege is string => typeof privilege === "string"
  );
  return privileges.length === value.length
    ? privileges.map((privilege) => privilege.toUpperCase())
    : undefined;
}

function mergePrivilegeValue(
  privilege: string,
  columns: readonly string[] | undefined,
  accumulator: PrivilegeAccumulator
): void {
  if (privilege === "ALL" && columns !== undefined) {
    for (const columnPrivilege of columnPrivilegeNames) {
      addColumnPrivilege(
        columnPrivilege,
        columns,
        accumulator.objectWidePrivileges,
        accumulator.columnsByPrivilege
      );
    }
    return;
  }
  if (columns !== undefined) {
    addColumnPrivilege(
      privilege,
      columns,
      accumulator.objectWidePrivileges,
      accumulator.columnsByPrivilege
    );
    return;
  }
  accumulator.objectWidePrivileges.add(privilege);
  accumulator.columnsByPrivilege.delete(privilege);
}

interface PrivilegeSetMetadata {
  columnPrivileges?: Record<string, string[]>;
  privileges: string[];
}

function accumulatedPrivilegeSet(
  accumulator: PrivilegeAccumulator
): PrivilegeSetMetadata | undefined {
  if (accumulator.objectWidePrivileges.has("ALL")) {
    return { privileges: ["ALL"] };
  }
  const privileges = [
    ...new Set([...accumulator.objectWidePrivileges, ...accumulator.columnsByPrivilege.keys()]),
  ].sort((left, right) => left.localeCompare(right));
  if (privileges.length === 0) {
    return;
  }
  const columnPrivileges: Record<string, string[]> = {};
  for (const [privilege, columns] of [...accumulator.columnsByPrivilege.entries()].sort(
    ([left], [right]) => left.localeCompare(right)
  )) {
    if (!accumulator.objectWidePrivileges.has(privilege)) {
      columnPrivileges[privilege] = [...columns].sort((left, right) => left.localeCompare(right));
    }
  }
  return {
    ...(Object.keys(columnPrivileges).length > 0 ? { columnPrivileges } : {}),
    privileges,
  };
}

export function privilegeMetadataFromRecord(
  metadata: Record<string, unknown>
): PrivilegeMetadata | undefined {
  const inputs = privilegeMetadataInputsFromRecord(metadata);
  return inputs ? mergePrivilegeMetadata(inputs) : undefined;
}

export function privilegeMetadataInputsFromRecord(
  metadata: Record<string, unknown>
): PrivilegeMetadataInput[] | undefined {
  if (!Array.isArray(metadata.grantOptionPrivileges)) {
    return;
  }
  const inputs: PrivilegeMetadataInput[] = [
    {
      columnPrivileges: metadata.columnPrivileges,
      privileges: metadata.privileges,
      withGrantOption: false,
    },
  ];
  if (metadata.grantOptionPrivileges.length > 0) {
    inputs.push({
      columnPrivileges: metadata.grantOptionColumnPrivileges,
      privileges: metadata.grantOptionPrivileges,
      withGrantOption: true,
    });
  }
  return inputs;
}

export function renderPrivilegeList(
  privileges: readonly string[],
  columnPrivileges?: Readonly<Record<string, readonly string[]>>
): string {
  return privileges
    .map((privilege) => {
      const columns = columnPrivileges?.[privilege];
      return columns && columns.length > 0
        ? `${privilege} (${columns.map(quoteIdent).join(", ")})`
        : privilege;
    })
    .join(", ");
}

function normalizedColumnPrivileges(value: unknown): Map<string, string[]> | null | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const result = new Map<string, string[]>();
  for (const [rawPrivilege, rawColumns] of Object.entries(value)) {
    if (
      !Array.isArray(rawColumns) ||
      rawColumns.length === 0 ||
      rawColumns.some((column) => typeof column !== "string")
    ) {
      return null;
    }
    result.set(
      rawPrivilege.toUpperCase(),
      [...new Set(rawColumns)].sort((left, right) => left.localeCompare(right))
    );
  }
  return result;
}

function addColumnPrivilege(
  privilege: string,
  columns: readonly string[],
  objectWidePrivileges: ReadonlySet<string>,
  columnsByPrivilege: Map<string, Set<string>>
): void {
  if (objectWidePrivileges.has("ALL") || objectWidePrivileges.has(privilege)) {
    return;
  }
  const mergedColumns = columnsByPrivilege.get(privilege) ?? new Set<string>();
  for (const column of columns) {
    mergedColumns.add(column);
  }
  columnsByPrivilege.set(privilege, mergedColumns);
}

export interface GrantObjectInput {
  columnPrivileges?: Record<string, string[]>;
  file?: string | undefined;
  grantee: string;
  grantOptionColumnPrivileges?: Record<string, string[]>;
  grantOptionPrivileges?: string[];
  kindPhrase: string;
  ordinal: number;
  privileges: string[];
  schema?: string | undefined;
  targetIdentity: string;
  targetRendered: string;
  verb: "GRANT" | "REVOKE";
  withGrantOption?: boolean;
}

export interface GrantSqlInput {
  columnPrivileges?: Record<string, string[]>;
  grantee: string;
  grantOptionColumnPrivileges?: Record<string, string[]>;
  grantOptionPrivileges: string[];
  kindPhrase: string;
  privileges: string[];
  targetRendered: string;
  verb: "GRANT" | "REVOKE";
}

export function renderGrantSql(input: GrantSqlInput): string {
  const keyword = input.verb === "GRANT" ? "TO" : "FROM";
  const statement = (list: string[], columns: Record<string, string[]> | undefined, suffix = "") =>
    `${input.verb} ${renderPrivilegeList(list, columns)} ON ${input.kindPhrase} ${input.targetRendered} ${keyword} ${renderRole(input.grantee)}${suffix}`;
  const base = statement(input.privileges, input.columnPrivileges);
  const grantable =
    input.verb === "GRANT" && input.grantOptionPrivileges.length > 0
      ? statement(
          input.grantOptionPrivileges,
          input.grantOptionColumnPrivileges,
          " WITH GRANT OPTION"
        )
      : undefined;
  const samePrivilegeSet =
    input.privileges.join("\u0000") === input.grantOptionPrivileges.join("\u0000") &&
    JSON.stringify(input.columnPrivileges ?? {}) ===
      JSON.stringify(input.grantOptionColumnPrivileges ?? {});
  return grantable && samePrivilegeSet
    ? grantable
    : [base, grantable].filter((value): value is string => value !== undefined).join(";\n");
}

export function buildGrantObject(input: GrantObjectInput): SchemaObject {
  const privilegeInputs: PrivilegeMetadataInput[] = [
    {
      columnPrivileges: input.columnPrivileges,
      privileges: input.privileges,
      withGrantOption: input.withGrantOption === true,
    },
  ];
  if (input.grantOptionPrivileges && input.grantOptionPrivileges.length > 0) {
    privilegeInputs[0] = {
      columnPrivileges: input.columnPrivileges,
      privileges: input.privileges,
      withGrantOption: false,
    };
    privilegeInputs.push({
      columnPrivileges: input.grantOptionColumnPrivileges,
      privileges: input.grantOptionPrivileges,
      withGrantOption: true,
    });
  }
  const merged = mergePrivilegeMetadata(privilegeInputs);
  if (!merged) {
    throw new Error("invalid grant privilege metadata");
  }
  const privileges = merged.columnPrivileges
    ? merged.privileges
    : normalizePrivileges(merged.privileges, input.kindPhrase);
  const grantOptionPrivileges = merged.grantOptionColumnPrivileges
    ? merged.grantOptionPrivileges
    : normalizePrivileges(merged.grantOptionPrivileges, input.kindPhrase);
  const canonicalSql = renderGrantSql({
    ...(merged.columnPrivileges ? { columnPrivileges: merged.columnPrivileges } : {}),
    ...(merged.grantOptionColumnPrivileges
      ? { grantOptionColumnPrivileges: merged.grantOptionColumnPrivileges }
      : {}),
    grantOptionPrivileges,
    grantee: input.grantee,
    kindPhrase: input.kindPhrase,
    privileges,
    targetRendered: input.targetRendered,
    verb: input.verb,
  });
  const ref: ObjectRef = {
    kind: "grant",
    name: `${input.verb.toLowerCase()}:${input.kindPhrase.toLowerCase().replaceAll(" ", "-")}:${input.targetIdentity}:${input.grantee}`,
  };
  if (input.schema) {
    ref.schema = input.schema;
  }
  return makeObject(ref, canonicalSql, input.ordinal, input.file, {
    ...(merged.columnPrivileges ? { columnPrivileges: merged.columnPrivileges } : {}),
    ...(merged.grantOptionColumnPrivileges
      ? { grantOptionColumnPrivileges: merged.grantOptionColumnPrivileges }
      : {}),
    grantOptionPrivileges,
    grantee: input.grantee,
    kindPhrase: input.kindPhrase,
    privileges,
    target: input.targetRendered,
    targetIdentity: input.targetIdentity,
    verb: input.verb,
  });
}

export interface DefaultPrivilegeObjectInput {
  file?: string | undefined;
  forRole?: string | undefined;
  grantee: string;
  grantOptionPrivileges?: string[];
  objectType: string;
  ordinal: number;
  privileges: string[];
  schema?: string | undefined;
  verb: "GRANT" | "REVOKE";
  withGrantOption?: boolean;
}

export function buildDefaultPrivilegeObject(input: DefaultPrivilegeObjectInput): SchemaObject {
  const scope = input.schema ? `in ${input.schema}` : "";
  const roleScope = input.forRole ? `for ${input.forRole}` : "for current-role";
  const merged = mergePrivilegeMetadata([
    {
      privileges: input.privileges,
      withGrantOption: input.withGrantOption === true,
    },
    ...(input.grantOptionPrivileges && input.grantOptionPrivileges.length > 0
      ? [
          {
            privileges: input.grantOptionPrivileges,
            withGrantOption: true,
          },
        ]
      : []),
  ]);
  if (!merged) {
    throw new Error("invalid default privilege metadata");
  }
  const privileges = normalizePrivileges(merged.privileges, input.objectType);
  const grantOptionPrivileges = normalizePrivileges(merged.grantOptionPrivileges, input.objectType);
  const prefix = [
    "ALTER DEFAULT PRIVILEGES",
    input.forRole ? `FOR ROLE ${renderRole(input.forRole)}` : "",
    input.schema ? `IN SCHEMA ${quoteIdent(input.schema)}` : "",
  ].filter(Boolean);
  const statement = (list: string[], suffix = "") =>
    [
      ...prefix,
      `${input.verb} ${list.join(", ")} ON ${input.objectType}`,
      `${input.verb === "GRANT" ? "TO" : "FROM"} ${renderRole(input.grantee)}${suffix}`,
    ].join(" ");
  const base = statement(privileges);
  const grantable =
    input.verb === "GRANT" && grantOptionPrivileges.length > 0
      ? statement(grantOptionPrivileges, " WITH GRANT OPTION")
      : undefined;
  const canonicalSql =
    grantable && privileges.join("\u0000") === grantOptionPrivileges.join("\u0000")
      ? grantable
      : [base, grantable].filter((value): value is string => value !== undefined).join(";\n");
  const ref: ObjectRef = {
    kind: "default-privilege",
    name: `${input.verb.toLowerCase()}:${roleScope}:${scope || "global"}:${input.objectType.toLowerCase()}:${input.grantee}`,
  };
  if (input.schema) {
    ref.schema = input.schema;
  }
  return makeObject(ref, canonicalSql, input.ordinal, input.file, {
    forRole: input.forRole,
    grantOptionPrivileges,
    grantee: input.grantee,
    objectType: input.objectType,
    privileges,
    schema: input.schema,
    verb: input.verb,
  });
}

export function grantObjectsFromAst(
  node: AstNode,
  statement: string,
  ordinal: number,
  file?: string
): SchemaObject[] {
  if (isRevokeGrantOptionFor(node)) {
    return [
      fallbackPrivilegeObject("grant", statement, ordinal, file, {
        unsupportedPrivilegeForm: "REVOKE GRANT OPTION FOR",
      }),
    ];
  }
  const isGrant = readBoolean(node.is_grant);
  const verb = isGrant ? "GRANT" : "REVOKE";
  const objtype = readString(node.objtype) ?? "OBJECT_TABLE";
  const allInSchema = readString(node.targtype) === "ACL_TARGET_ALL_IN_SCHEMA";
  const kindPhrase = allInSchema ? allInSchemaKinds.get(objtype) : grantObjectKinds.get(objtype);
  const privilegeMetadata = grantPrivilegeMetadata(node.privileges);
  const grantees = readArray(node.grantees)
    .map((item) => roleSpecName(item))
    .filter((role): role is string => role !== undefined);
  const targets = readArray(node.objects)
    .map((item) => grantTarget(item, objtype, allInSchema))
    .filter((target): target is GrantTarget => target !== undefined);
  if (!(kindPhrase && privilegeMetadata) || grantees.length === 0 || targets.length === 0) {
    return [fallbackPrivilegeObject("grant", statement, ordinal, file)];
  }
  const withGrantOption = isGrant && readBoolean(node.grant_option);
  const objects: SchemaObject[] = [];
  for (const target of targets) {
    for (const grantee of grantees) {
      objects.push(
        buildGrantObject({
          ...(privilegeMetadata.columnPrivileges
            ? { columnPrivileges: privilegeMetadata.columnPrivileges }
            : {}),
          file,
          grantee,
          kindPhrase,
          ordinal: ordinal + objects.length,
          privileges: privilegeMetadata.privileges,
          schema: target.schema,
          targetIdentity: target.identity,
          targetRendered: target.rendered,
          verb,
          withGrantOption,
        })
      );
    }
  }
  return objects;
}

export function isRevokeGrantOptionFor(node: AstNode): boolean {
  return !readBoolean(node.is_grant) && readBoolean(node.grant_option);
}

export function defaultPrivilegesFromAst(
  node: AstNode,
  statement: string,
  ordinal: number,
  file?: string
): SchemaObject[] {
  const action = asRecord(node.action);
  if (!action) {
    return [fallbackPrivilegeObject("default-privilege", statement, ordinal, file)];
  }
  const isGrant = readBoolean(action.is_grant);
  const verb = isGrant ? "GRANT" : "REVOKE";
  const withGrantOption = isGrant && readBoolean(action.grant_option);
  const objectType = defaultPrivilegeKinds.get(readString(action.objtype) ?? "OBJECT_TABLE");
  const privileges = grantPrivileges(action.privileges);
  const grantees = readArray(action.grantees)
    .map((item) => roleSpecName(item))
    .filter((role): role is string => role !== undefined);
  const { forRoles, schemas } = defaultPrivilegeScope(node.options);
  if (!objectType || grantees.length === 0) {
    return [fallbackPrivilegeObject("default-privilege", statement, ordinal, file)];
  }
  const roleScopes: (string | undefined)[] = forRoles.length > 0 ? forRoles : [undefined];
  const schemaScopes: (string | undefined)[] = schemas.length > 0 ? schemas : [undefined];
  const objects: SchemaObject[] = [];
  for (const forRole of roleScopes) {
    for (const schema of schemaScopes) {
      for (const grantee of grantees) {
        objects.push(
          buildDefaultPrivilegeObject({
            file,
            forRole,
            grantee,
            objectType,
            ordinal: ordinal + objects.length,
            privileges,
            schema,
            verb,
            withGrantOption,
          })
        );
      }
    }
  }
  return objects;
}

const commentObjectKinds = new Map<string, CommentTarget["kind"]>([
  ["OBJECT_COLUMN", "column"],
  ["OBJECT_DOMAIN", "domain"],
  ["OBJECT_EXTENSION", "extension"],
  ["OBJECT_FOREIGN_TABLE", "foreign-table"],
  ["OBJECT_FUNCTION", "function"],
  ["OBJECT_INDEX", "index"],
  ["OBJECT_MATVIEW", "materialized-view"],
  ["OBJECT_POLICY", "policy"],
  ["OBJECT_PROCEDURE", "procedure"],
  ["OBJECT_SCHEMA", "schema"],
  ["OBJECT_SEQUENCE", "sequence"],
  ["OBJECT_TABCONSTRAINT", "constraint"],
  ["OBJECT_TABLE", "table"],
  ["OBJECT_TRIGGER", "trigger"],
  ["OBJECT_TYPE", "type"],
  ["OBJECT_VIEW", "view"],
]);

const tableScopedCommentObjectTypes = new Set([
  "OBJECT_COLUMN",
  "OBJECT_POLICY",
  "OBJECT_TABCONSTRAINT",
  "OBJECT_TRIGGER",
]);

export function isInitdbDefaultComment(
  descriptor: string,
  description: string | null | undefined
): boolean {
  return descriptor === "schema public" && description === "standard public schema";
}

export function commentObjectFromAst(
  node: AstNode,
  statement: string,
  ordinal: number,
  file?: string
): SchemaObject | undefined {
  const objtype = readString(node.objtype);
  const kind = objtype ? commentObjectKinds.get(objtype) : undefined;
  if (!kind) {
    return;
  }
  const target = commentTarget(node.object, objtype ?? "", kind);
  if (!target) {
    return;
  }
  return buildCommentObject({
    description: readString(node.comment) ?? null,
    ...(file === undefined ? {} : { file }),
    ordinal,
    sql: statement,
    target,
  });
}

function commentTarget(
  object: unknown,
  objtype: string,
  kind: CommentTarget["kind"]
): CommentTarget | undefined {
  if (objtype === "OBJECT_FUNCTION" || objtype === "OBJECT_PROCEDURE") {
    return routineCommentTarget(object, kind);
  }
  if (objtype === "OBJECT_TYPE" || objtype === "OBJECT_DOMAIN") {
    return typeCommentTarget(object, kind);
  }
  return namedCommentTarget(object, objtype, kind);
}

function routineCommentTarget(
  object: unknown,
  kind: CommentTarget["kind"]
): CommentTarget | undefined {
  const identity = objectWithArgsIdentity(object);
  if (!identity) {
    return;
  }
  return {
    kind,
    name: identity.name,
    schema: identity.schema,
    signature: identity.signature,
  };
}

function typeCommentTarget(object: unknown, kind: CommentTarget["kind"]): CommentTarget {
  const typeNode = asRecord(object);
  const named = qualifiedName(asRecord(typeNode?.TypeName)?.names ?? typeNode?.names);
  return named
    ? { kind, name: named.name, schema: named.schema }
    : { kind, name: normalizeSql(typeNameToSql(object)) };
}

function namedCommentTarget(
  object: unknown,
  objtype: string,
  kind: CommentTarget["kind"]
): CommentTarget | undefined {
  const parts = stringList(object);
  if (parts.length === 0) {
    const single = stringValue(object) ?? readString(object);
    return single ? { kind, name: single } : undefined;
  }
  if (objtype === "OBJECT_SCHEMA") {
    return { kind, name: parts.join(".") };
  }
  if (objtype === "OBJECT_EXTENSION") {
    return { kind, name: parts.at(-1) ?? "" };
  }
  if (tableScopedCommentObjectTypes.has(objtype)) {
    const name = parts.at(-1);
    const table = parts.at(-2);
    if (!(name && table)) {
      return;
    }
    return {
      kind,
      name,
      schema: parts.at(-3) ?? "public",
      table,
    };
  }
  return {
    kind,
    name: parts.at(-1) ?? "",
    schema: parts.at(-2) ?? "public",
  };
}

export interface BuildCommentObjectInput {
  description: string | null;
  file?: string;
  ordinal: number;
  sql: string;
  target: CommentTarget;
}

export function buildCommentObject(input: BuildCommentObjectInput): SchemaObject {
  const descriptor = commentDescriptor(input.target);
  const ref: ObjectRef = {
    kind: "comment",
    name: sha256(descriptor).slice(0, 16),
    ...(input.target.schema === undefined ? {} : { schema: input.target.schema }),
    ...(input.target.table === undefined ? {} : { table: input.target.table }),
  };
  return makeObject(ref, input.sql, input.ordinal, input.file, {
    commentTarget: input.target,
    description: input.description,
    descriptor,
  });
}

export function commentDescriptor(target: CommentTarget): string {
  const kind = target.kind.replaceAll("-", " ");
  if (target.kind === "schema" || target.kind === "extension") {
    return `${kind} ${target.name}`;
  }
  if (target.kind === "function" || target.kind === "procedure") {
    return `${kind} ${target.schema ?? "public"}.${target.name}(${target.signature ?? ""})`;
  }
  if (
    target.kind === "column" ||
    target.kind === "constraint" ||
    target.kind === "policy" ||
    target.kind === "trigger"
  ) {
    return `${kind} ${target.schema ?? "public"}.${target.table ?? ""}.${target.name}`;
  }
  return `${kind} ${target.schema ?? "public"}.${target.name}`;
}

export function commentTargetSql(target: CommentTarget): string {
  const kind = target.kind.replaceAll("-", " ").toUpperCase();
  if (target.kind === "schema" || target.kind === "extension") {
    return `${kind} ${quoteIdent(target.name)}`;
  }
  if (target.kind === "function" || target.kind === "procedure") {
    return `${kind} ${formatQualifiedName(target.schema ?? "public", target.name)}(${target.signature ?? ""})`;
  }
  if (target.kind === "constraint" || target.kind === "policy" || target.kind === "trigger") {
    return `${kind} ${quoteIdent(target.name)} ON ${formatQualifiedName(target.schema ?? "public", target.table ?? "")}`;
  }
  if (target.kind === "column") {
    return `${kind} ${formatQualifiedName(target.schema ?? "public", target.table ?? "")}.${quoteIdent(target.name)}`;
  }
  return `${kind} ${formatQualifiedName(target.schema ?? "public", target.name)}`;
}

export function commentStatementSql(target: CommentTarget, description: string | null): string {
  const value = description === null ? "NULL" : `'${description.replaceAll("'", "''")}'`;
  return `COMMENT ON ${commentTargetSql(target)} IS ${value}`;
}

function grantPrivileges(value: unknown): string[] {
  return grantPrivilegeMetadata(value)?.privileges ?? ["ALL"];
}

function grantPrivilegeMetadata(value: unknown): PrivilegeMetadata | undefined {
  const privileges = readArray(value);
  if (privileges.length === 0) {
    return { grantOptionPrivileges: [], privileges: ["ALL"] };
  }
  return mergePrivilegeMetadata(
    privileges.map((item) => {
      const accessPrivilege = asRecord(asRecord(item)?.AccessPriv);
      const privilege = (readString(accessPrivilege?.priv_name) ?? "ALL").toUpperCase();
      const columns = stringList(accessPrivilege?.cols);
      return {
        ...(columns.length > 0 ? { columnPrivileges: { [privilege]: columns } } : {}),
        privileges: [privilege],
        withGrantOption: false,
      };
    })
  );
}

function grantTarget(
  value: unknown,
  objtype: string,
  allInSchema: boolean
): GrantTarget | undefined {
  if (allInSchema || objtype === "OBJECT_SCHEMA") {
    const schema = stringValue(value) ?? readString(asRecord(value)?.sval);
    if (!schema) {
      return;
    }
    return { identity: schema, rendered: quoteIdent(schema), schema };
  }
  if (
    objtype === "OBJECT_FUNCTION" ||
    objtype === "OBJECT_PROCEDURE" ||
    objtype === "OBJECT_ROUTINE"
  ) {
    const identity = objectWithArgsIdentity(value);
    if (!identity) {
      return;
    }
    return {
      identity: `${identity.schema}.${identity.name}(${identity.signature})`,
      rendered: `${formatQualifiedName(identity.schema, identity.name)}(${identity.signature})`,
      schema: identity.schema,
    };
  }
  const range = rangeVarName(value);
  if (range) {
    return {
      identity: `${range.schema}.${range.name}`,
      rendered: formatQualifiedName(range.schema, range.name),
      schema: range.schema,
    };
  }
  const named = qualifiedName(value);
  if (named) {
    return {
      identity: `${named.schema}.${named.name}`,
      rendered: formatQualifiedName(named.schema, named.name),
      schema: named.schema,
    };
  }
}

function defaultPrivilegeScope(options: unknown): { forRoles: string[]; schemas: string[] } {
  const forRoles: string[] = [];
  const schemas: string[] = [];
  for (const item of readArray(options)) {
    const defElem = asRecord(asRecord(item)?.DefElem);
    const name = readString(defElem?.defname);
    if (name === "roles") {
      for (const role of listItems(defElem?.arg)) {
        const roleName = roleSpecName(role);
        if (roleName) {
          forRoles.push(roleName);
        }
      }
    }
    if (name === "schemas") {
      for (const schema of stringList(defElem?.arg)) {
        schemas.push(schema.toLowerCase());
      }
    }
  }
  return { forRoles, schemas };
}

function renderRole(role: string): string {
  return role === "PUBLIC" ? "PUBLIC" : quoteIdent(role);
}

function fallbackPrivilegeObject(
  kind: "grant" | "default-privilege",
  statement: string,
  ordinal: number,
  file?: string,
  metadata: Record<string, unknown> = {}
): SchemaObject {
  const name = sha256(normalizeSql(statement)).slice(0, 16);
  return makeObject({ kind, name }, statement, ordinal, file, metadata);
}
