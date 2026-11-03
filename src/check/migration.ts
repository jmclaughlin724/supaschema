import { resolveConfig } from "../config/schema.js";
import { diagnostic } from "../diagnostics/diagnostics.js";
import { notNullProofConstraintName } from "../migrations/not-null.js";
import type { AstNode, AstStatement } from "../sql/ast.js";
import {
  asRecord,
  astStatements,
  columnFacts,
  functionIdentity,
  objectWithArgsIdentity,
  qualifiedName,
  rangeVarName,
  readArray,
  readBoolean,
  readString,
  stringList,
} from "../sql/ast.js";
import {
  routineSearchPath,
  routineSecurityDefiner,
  securityDefinerSearchPathIssue,
} from "../sql/facts.js";
import { deparseFidelityDiagnostics } from "../sql/normalize-deparse.js";
import { parseSqlAst } from "../sql/parser.js";
import {
  extractStatementDependencies,
  type RoutineDependencyResult,
} from "../sql/routine-dependencies.js";
import type { CheckOptions, Diagnostic } from "../types.js";
import { runConfiguredValidators } from "../validators.js";
import {
  enumValueUseDiagnostics,
  escalateNontransactional,
  newEnumAdditionState,
  recordEnumAdditions,
} from "./hazards.js";

const guardedCreateChecks: { code: string; kind: string; tag: string }[] = [
  { code: "SUPA_CHECK_CREATE_SCHEMA_GUARD", kind: "SCHEMA", tag: "CreateSchemaStmt" },
  { code: "SUPA_CHECK_CREATE_EXTENSION_GUARD", kind: "EXTENSION", tag: "CreateExtensionStmt" },
  { code: "SUPA_CHECK_CREATE_TABLE_GUARD", kind: "TABLE", tag: "CreateStmt" },
  { code: "SUPA_CHECK_CREATE_SEQUENCE_GUARD", kind: "SEQUENCE", tag: "CreateSeqStmt" },
  { code: "SUPA_CHECK_CREATE_INDEX_GUARD", kind: "INDEX", tag: "IndexStmt" },
];

const volatileDefaultFunctions = new Set([
  "clock_timestamp",
  "gen_random_uuid",
  "nextval",
  "random",
  "timeofday",
  "uuid_generate_v1",
  "uuid_generate_v4",
]);

type StatementCheck = (
  node: AstNode,
  statement: AstStatement,
  previous: AstStatement | undefined
) => Diagnostic[];

const statementChecks: Partial<Record<string, StatementCheck>> = {
  AlterTableStmt: (node, statement, previous) =>
    checkAlterTableStatement(node, statement.text, previous),
  CompositeTypeStmt: (_node, statement) => checkTypeCreationStatement(statement.text),
  CreateDomainStmt: (_node, statement) => checkTypeCreationStatement(statement.text),
  CreateEnumStmt: (_node, statement) => checkTypeCreationStatement(statement.text),
  CreateFunctionStmt: (node, statement) => checkFunctionStatement(node, statement.text),
  CreatePolicyStmt: (_node, statement, previous) => checkPolicyStatement(previous, statement.text),
  CreateRangeStmt: (_node, statement) => checkTypeCreationStatement(statement.text),
  CreateTableAsStmt: (node, statement) => checkMaterializedViewStatement(node, statement.text),
  CreateTrigStmt: (node, statement, previous) =>
    checkTriggerStatement(node, previous, statement.text),
  DeleteStmt: (_node, statement) => checkDmlStatement(statement.text),
  DropStmt: (node, statement) => checkDropStatement(node, statement.text),
  IndexStmt: (node, statement) => checkConcurrentStatement(node, statement.text, "index"),
  InsertStmt: (node, statement) => checkInsertStatement(node, statement.text),
  RefreshMatViewStmt: (node, statement) =>
    checkConcurrentStatement(node, statement.text, "refresh"),
  UpdateStmt: (_node, statement) => checkDmlStatement(statement.text),
  VariableSetStmt: (node, statement) => checkVariableSetStatement(node, statement.text),
  ViewStmt: (node, statement) => checkViewStatement(node, statement.text),
};

export async function checkMigrationSql(
  sql: string,
  options: CheckOptions = {}
): Promise<Diagnostic[]> {
  const config = resolveConfig(options.config);
  const diagnostics: Diagnostic[] = [];
  if (options.parse ?? true) {
    const parsed = await parseSqlAst(sql);
    diagnostics.push(...parsed.diagnostics);
    if (parsed.ast !== undefined) {
      const statements = astStatements(parsed.ast, sql);
      const enumAdditions = newEnumAdditionState();
      for (const [index, statement] of statements.entries()) {
        diagnostics.push(
          ...escalateNontransactional(checkStatement(statement, statements[index - 1]), config),
          ...enumValueUseDiagnostics(statement, enumAdditions, config)
        );
        recordEnumAdditions(statement, enumAdditions);
      }
      diagnostics.push(...(await forwardReferenceOrderDiagnostics(statements)));
      diagnostics.push(...functionPublicExecuteDiagnostics(statements));
      diagnostics.push(...(await deparseFidelityDiagnostics(sql)));
    }
  }
  const validatorOptions: CheckOptions = {};
  if (options.config !== undefined) {
    validatorOptions.config = options.config;
  }
  if (options.cwd !== undefined) {
    validatorOptions.cwd = options.cwd;
  }
  diagnostics.push(...(await runConfiguredValidators(sql, validatorOptions)));
  return diagnostics;
}

interface StatementOrderFacts {
  columnReferences: Set<string>;
  createdColumns: Set<string>;
  createdRelations: Set<string>;
  createdRelationsWithUnknownColumns: Set<string>;
  droppedColumns: Set<string>;
  droppedRelationSchemas: Map<string, string>;
  droppedRelations: Set<string>;
  droppedSchemas: Set<string>;
  references: Set<string>;
  statement: AstStatement;
}

async function forwardReferenceOrderDiagnostics(
  statements: readonly AstStatement[]
): Promise<Diagnostic[]> {
  const facts: StatementOrderFacts[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const statement of statements) {
    const dependencies = await extractStatementDependencies(statement);
    const droppedRelations = droppedRelationFacts(statement);
    diagnostics.push(...dependencies.diagnostics);
    diagnostics.push(...securityDefinerSearchPathDiagnostics(statement, dependencies.routine));
    facts.push({
      columnReferences: new Set(dependencies.columnReferences),
      createdColumns: createdColumnIdentities(statement),
      createdRelations: createdRelationIdentities(statement),
      createdRelationsWithUnknownColumns: createdRelationsWithUnknownColumns(statement),
      droppedColumns: droppedColumnIdentities(statement),
      droppedRelations: droppedRelations.identities,
      droppedRelationSchemas: droppedRelations.schemas,
      droppedSchemas: cascadingDroppedSchemaIdentities(statement),
      references: new Set(dependencies.references),
      statement,
    });
  }
  const laterRelations = new Set<string>();
  const laterRelationsWithUnknownColumns = new Set<string>();
  const laterColumns = new Set<string>();
  for (let index = facts.length - 1; index >= 0; index -= 1) {
    const current = facts[index];
    if (!current) {
      continue;
    }
    const presentDrops = new Set(
      [...current.droppedRelations].filter((relation) =>
        relationPresentBeforeDrop(
          facts,
          index,
          relation,
          current.droppedRelationSchemas.get(relation) ?? "public"
        )
      )
    );
    removeAll(
      laterRelations,
      [...presentDrops].filter((relation) => !laterRelationsWithUnknownColumns.has(relation))
    );
    removeColumnsForRelations(laterColumns, presentDrops, (relation, identity) =>
      columnExistedBeforeDrop(
        facts,
        index,
        relation,
        current.droppedRelationSchemas.get(relation) ?? "public",
        identity
      )
    );
    const forwardRelations = [...current.references].filter((reference) =>
      laterRelations.has(reference)
    );
    const forwardColumns = [...current.columnReferences].filter((reference) =>
      laterColumns.has(reference)
    );
    if (forwardRelations.length > 0 || forwardColumns.length > 0) {
      diagnostics.push(
        diagnostic(
          "SUPA_CHECK_FORWARD_REFERENCE_ORDER",
          "error",
          "migration statement references an object or column created later in the same file",
          {
            hint: [...forwardRelations, ...forwardColumns]
              .sort((left, right) => Number(left > right) - Number(left < right))
              .join(", "),
            statement: current.statement.text,
          }
        )
      );
    }
    addAll(laterRelations, current.createdRelations);
    addAll(laterRelationsWithUnknownColumns, current.createdRelationsWithUnknownColumns);
    addAll(laterColumns, current.createdColumns);
  }
  return diagnostics;
}

function securityDefinerSearchPathDiagnostics(
  statement: AstStatement,
  routine: RoutineDependencyResult | undefined
): Diagnostic[] {
  if (statement.tag !== "CreateFunctionStmt") {
    return [];
  }
  const node = asRecord(statement.node.CreateFunctionStmt);
  if (!node) {
    return [];
  }
  const issue = securityDefinerSearchPathIssue({
    routineDependencyConfidence: routine?.confidence,
    routineSearchPath: routineSearchPath(node.options),
    routineUnqualifiedReferences: routine?.unqualifiedReferences,
    securityDefiner: routineSecurityDefiner(node.options),
  });
  return issue
    ? [
        diagnostic(
          "SUPA_CHECK_SECURITY_DEFINER_SEARCH_PATH",
          "warning",
          `SECURITY DEFINER routine ${issue.message}`,
          { hint: issue.hint, statement: statement.text }
        ),
      ]
    : [];
}

function createdRelationIdentities(statement: AstStatement): Set<string> {
  const node = asRecord(statement.node[statement.tag]);
  const identities = new Set<string>();
  if (!node) {
    return identities;
  }
  if (statement.tag === "CreateStmt") {
    addRangeVarIdentity(identities, node.relation);
  }
  if (statement.tag === "CreateForeignTableStmt") {
    addRangeVarIdentity(identities, asRecord(node.base)?.relation);
  }
  if (statement.tag === "ViewStmt") {
    addRangeVarIdentity(identities, node.view);
  }
  if (statement.tag === "CreateTableAsStmt") {
    addRangeVarIdentity(identities, asRecord(node.into)?.rel);
  }
  return identities;
}

function createdColumnIdentities(statement: AstStatement): Set<string> {
  const node = asRecord(statement.node[statement.tag]);
  if (!node) {
    return new Set();
  }
  switch (statement.tag) {
    case "CreateStmt":
      return tableColumnIdentities(node.relation, node.tableElts);
    case "CreateForeignTableStmt": {
      const base = asRecord(node.base) ?? node;
      return tableColumnIdentities(base.relation, base.tableElts);
    }
    case "CreateTableAsStmt":
      return tableAsColumnIdentities(node);
    case "AlterTableStmt":
      return addedColumnIdentities(node);
    default:
      return new Set();
  }
}

function tableColumnIdentities(relationNode: unknown, tableElts: unknown): Set<string> {
  const identities = new Set<string>();
  const relation = relationIdentity(relationNode);
  if (relation) {
    addTableColumnFacts(identities, relation, tableElts);
  }
  return identities;
}

function tableAsColumnIdentities(node: AstNode): Set<string> {
  const identities = new Set<string>();
  const relation = relationIdentity(asRecord(node.into)?.rel);
  const columns = createdTableAsColumnNames(node);
  if (!(relation && columns)) {
    return identities;
  }
  for (const column of columns) {
    identities.add(`${relation}.${column}`);
  }
  return identities;
}

function addedColumnIdentities(node: AstNode): Set<string> {
  const identities = new Set<string>();
  const relation = relationIdentity(node.relation);
  if (!relation) {
    return identities;
  }
  for (const item of readArray(node.cmds)) {
    const command = asRecord(asRecord(item)?.AlterTableCmd);
    if (readString(command?.subtype) !== "AT_AddColumn") {
      continue;
    }
    const facts = columnFacts(asRecord(command?.def));
    if (facts) {
      identities.add(`${relation}.${facts.name}`);
    }
  }
  return identities;
}

function createdRelationsWithUnknownColumns(statement: AstStatement): Set<string> {
  const node = asRecord(statement.node[statement.tag]);
  const identities = new Set<string>();
  if (!node) {
    return identities;
  }
  if (statement.tag === "CreateStmt" && readArray(node.inhRelations).length > 0) {
    addRangeVarIdentity(identities, node.relation);
  }
  if (statement.tag === "CreateTableAsStmt" && createdTableAsColumnNames(node) === undefined) {
    addRangeVarIdentity(identities, asRecord(node.into)?.rel);
  }
  return identities;
}

function createdTableAsColumnNames(node: AstNode): string[] | undefined {
  const into = asRecord(node.into);
  const declared = stringList(into?.colNames);
  if (declared.length > 0) {
    return declared;
  }
  const select = asRecord(asRecord(node.query)?.SelectStmt);
  const targets = readArray(select?.targetList);
  if (targets.length === 0) {
    return;
  }
  const columns: string[] = [];
  for (const item of targets) {
    const target = asRecord(asRecord(item)?.ResTarget);
    const name = readString(target?.name) ?? simpleColumnReferenceName(target?.val);
    if (!name) {
      return;
    }
    columns.push(name);
  }
  return columns;
}

function simpleColumnReferenceName(value: unknown): string | undefined {
  const column = asRecord(asRecord(value)?.ColumnRef);
  const fields = stringList(column?.fields);
  return fields.at(-1);
}

function addTableColumnFacts(identities: Set<string>, relation: string, tableElts: unknown): void {
  for (const item of readArray(tableElts)) {
    const facts = columnFacts(asRecord(item));
    if (facts) {
      identities.add(`${relation}.${facts.name}`);
    }
  }
}

function droppedColumnIdentities(statement: AstStatement): Set<string> {
  const node = asRecord(statement.node[statement.tag]);
  const identities = new Set<string>();
  if (!node || statement.tag !== "AlterTableStmt") {
    return identities;
  }
  const relation = relationIdentity(node.relation);
  if (!relation) {
    return identities;
  }
  for (const item of readArray(node.cmds)) {
    const command = asRecord(asRecord(item)?.AlterTableCmd);
    if (readString(command?.subtype) !== "AT_DropColumn") {
      continue;
    }
    const name = readString(command?.name);
    if (name) {
      identities.add(`${relation}.${name}`);
    }
  }
  return identities;
}

function addRangeVarIdentity(into: Set<string>, value: unknown): void {
  const identity = relationIdentity(value);
  if (identity) {
    into.add(identity);
  }
}

const RELATION_DROP_REMOVE_TYPES = new Set([
  "OBJECT_FOREIGN_TABLE",
  "OBJECT_MATVIEW",
  "OBJECT_SEQUENCE",
  "OBJECT_TABLE",
  "OBJECT_VIEW",
]);

interface DroppedRelationFacts {
  identities: Set<string>;
  schemas: Map<string, string>;
}

function droppedRelationFacts(statement: AstStatement): DroppedRelationFacts {
  const identities = new Set<string>();
  const schemas = new Map<string, string>();
  if (statement.tag !== "DropStmt") {
    return { identities, schemas };
  }
  const node = asRecord(statement.node.DropStmt);
  if (!(node && RELATION_DROP_REMOVE_TYPES.has(readString(node.removeType) ?? ""))) {
    return { identities, schemas };
  }
  for (const object of readArray(node.objects)) {
    const name = qualifiedName(object);
    if (name) {
      const identity = `${name.schema}.${name.name}`;
      identities.add(identity);
      schemas.set(identity, name.schema);
    }
  }
  return { identities, schemas };
}

function cascadingDroppedSchemaIdentities(statement: AstStatement): Set<string> {
  if (statement.tag !== "DropStmt") {
    return new Set();
  }
  const node = asRecord(statement.node.DropStmt);
  if (
    !node ||
    readString(node.removeType) !== "OBJECT_SCHEMA" ||
    readString(node.behavior) !== "DROP_CASCADE"
  ) {
    return new Set();
  }
  return new Set(stringList(node.objects));
}

function relationIdentity(value: unknown): string | undefined {
  const name = rangeVarName(value);
  return name ? `${name.schema}.${name.name}` : undefined;
}

function addAll<T>(into: Set<T>, values: Iterable<T>): void {
  for (const value of values) {
    into.add(value);
  }
}

function removeAll<T>(from: Set<T>, values: Iterable<T>): void {
  for (const value of values) {
    from.delete(value);
  }
}

function removeColumnsForRelations(
  columns: Set<string>,
  relations: ReadonlySet<string>,
  existedBeforeDrop: (relation: string, identity: string) => boolean
): void {
  for (const identity of [...columns]) {
    for (const relation of relations) {
      if (!identity.startsWith(`${relation}.`)) {
        continue;
      }
      if (existedBeforeDrop(relation, identity)) {
        columns.delete(identity);
      }
      break;
    }
  }
}

function relationPresentBeforeDrop(
  facts: readonly StatementOrderFacts[],
  dropIndex: number,
  relation: string,
  schema: string
): boolean {
  for (let index = dropIndex - 1; index >= 0; index -= 1) {
    const fact = facts[index];
    if (!fact) {
      continue;
    }
    if (fact.droppedRelations.has(relation)) {
      return false;
    }
    if (fact.droppedSchemas.has(schema)) {
      return false;
    }
    if (fact.createdRelations.has(relation)) {
      return true;
    }
  }
  return true;
}

function columnExistedBeforeDrop(
  facts: readonly StatementOrderFacts[],
  dropIndex: number,
  relation: string,
  schema: string,
  identity: string
): boolean {
  for (let index = dropIndex - 1; index >= 0; index -= 1) {
    const fact = facts[index];
    if (!fact) {
      continue;
    }
    if (fact.droppedRelations.has(relation)) {
      return false;
    }
    if (fact.droppedSchemas.has(schema)) {
      return false;
    }
    if (fact.droppedColumns.has(identity)) {
      return false;
    }
    if (fact.createdColumns.has(identity)) {
      return true;
    }
  }
  return false;
}

function functionPublicExecuteDiagnostics(statements: readonly AstStatement[]): Diagnostic[] {
  const publicRoutines = new Map<string, AstStatement>();
  const revoked = new Set<string>();
  for (const statement of statements) {
    recordPublicRoutine(statement, publicRoutines);
    recordPublicExecuteRevoke(statement, revoked);
  }
  const diagnostics: Diagnostic[] = [];
  for (const [identity, statement] of publicRoutines) {
    if (revoked.has(identity)) {
      continue;
    }
    diagnostics.push(
      diagnostic(
        "SUPA_CHECK_FUNCTION_PUBLIC_EXECUTE",
        "warning",
        "public-schema function does not revoke default PUBLIC EXECUTE in this migration",
        {
          hint: "Add REVOKE EXECUTE ON FUNCTION ... FROM PUBLIC before granting only intended roles.",
          statement: statement.text,
        }
      )
    );
  }
  return diagnostics;
}

function recordPublicRoutine(
  statement: AstStatement,
  publicRoutines: Map<string, AstStatement>
): void {
  if (statement.tag !== "CreateFunctionStmt") {
    return;
  }
  const node = asRecord(statement.node.CreateFunctionStmt);
  const identity = functionIdentity(node?.funcname, node?.parameters);
  if (identity?.schema === "public") {
    publicRoutines.set(routineIdentityKey(identity), statement);
  }
}

function recordPublicExecuteRevoke(statement: AstStatement, revoked: Set<string>): void {
  if (statement.tag !== "GrantStmt") {
    return;
  }
  const node = asRecord(statement.node.GrantStmt);
  if (!node || readBoolean(node.is_grant) || readString(node.objtype) !== "OBJECT_FUNCTION") {
    return;
  }
  if (!grantTouchesPublicExecute(node)) {
    return;
  }
  for (const object of readArray(node.objects)) {
    const identity = objectWithArgsRoutineIdentity(object);
    if (identity) {
      revoked.add(identity);
    }
  }
}

function objectWithArgsRoutineIdentity(value: unknown): string | undefined {
  const identity = objectWithArgsIdentity(value);
  if (!identity) {
    return;
  }
  return routineIdentityKey(identity);
}

function routineIdentityKey(identity: { name: string; schema: string; signature: string }): string {
  return `${identity.schema}.${identity.name}(${identity.signature})`;
}

function grantTouchesPublicExecute(node: AstNode): boolean {
  return grantHasPublicGrantee(node) && grantHasExecutePrivilege(node);
}

function grantHasPublicGrantee(node: AstNode): boolean {
  return readArray(node.grantees).some((item) => {
    const role = asRecord(asRecord(item)?.RoleSpec);
    return readString(role?.roletype) === "ROLESPEC_PUBLIC";
  });
}

function grantHasExecutePrivilege(node: AstNode): boolean {
  const privileges = readArray(node.privileges);
  if (privileges.length === 0) {
    return true;
  }
  return privileges.some((item) => {
    const privilege = asRecord(asRecord(item)?.AccessPriv);
    return readString(privilege?.priv_name)?.toLowerCase() === "execute";
  });
}

function checkStatement(statement: AstStatement, previous: AstStatement | undefined): Diagnostic[] {
  const node = asRecord(statement.node[statement.tag]);
  if (!node) {
    return [];
  }
  const diagnostics = statementChecks[statement.tag]?.(node, statement, previous) ?? [];
  diagnostics.push(...checkGuardedCreateStatement(statement.tag, node, statement.text));
  return diagnostics;
}

function checkGuardedCreateStatement(tag: string, node: AstNode, text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const guarded of guardedCreateChecks) {
    if (tag === guarded.tag && !readBoolean(node.if_not_exists)) {
      diagnostics.push(
        diagnostic(
          guarded.code,
          "error",
          `${guarded.kind} creation must use IF NOT EXISTS or a catalog guard`,
          { statement: text }
        )
      );
    }
  }
  return diagnostics;
}

function checkVariableSetStatement(node: AstNode, text: string): Diagnostic[] {
  if (readString(node.name) !== "search_path") {
    return [];
  }
  return [
    diagnostic(
      "SUPA_CHECK_SEARCH_PATH",
      "error",
      "migrations must not depend on session search_path",
      {
        hint: "Use schema-qualified object references and function-level SET search_path where needed.",
        statement: text,
      }
    ),
  ];
}

function checkViewStatement(node: AstNode, text: string): Diagnostic[] {
  if (readBoolean(node.replace)) {
    return [];
  }
  return [
    diagnostic("SUPA_CHECK_CREATE_VIEW_REPLACE", "error", "VIEW creation must use OR REPLACE", {
      statement: text,
    }),
  ];
}

function checkTypeCreationStatement(text: string): Diagnostic[] {
  return [
    diagnostic(
      "SUPA_CHECK_CREATE_TYPE_GUARD",
      "error",
      "TYPE and DOMAIN creation must be wrapped in a catalog guard",
      { statement: text }
    ),
  ];
}

function checkMaterializedViewStatement(node: AstNode, text: string): Diagnostic[] {
  if (
    readString(node.objtype) !== "OBJECT_MATVIEW" ||
    readBoolean(node.if_not_exists) ||
    readBoolean(asRecord(node.into)?.if_not_exists)
  ) {
    return [];
  }
  return [
    diagnostic(
      "SUPA_CHECK_CREATE_MATERIALIZED_VIEW_GUARD",
      "error",
      "MATERIALIZED VIEW creation must use IF NOT EXISTS or a catalog guard",
      { statement: text }
    ),
  ];
}

function checkPolicyStatement(previous: AstStatement | undefined, text: string): Diagnostic[] {
  if (previousDrops(previous, "OBJECT_POLICY")) {
    return [];
  }
  return [
    diagnostic(
      "SUPA_CHECK_POLICY_REPLACEMENT",
      "error",
      "CREATE POLICY has no OR REPLACE form and must be preceded by DROP POLICY IF EXISTS",
      { statement: text }
    ),
  ];
}

function checkTriggerStatement(
  node: AstNode,
  previous: AstStatement | undefined,
  text: string
): Diagnostic[] {
  if (readBoolean(node.replace) || previousDrops(previous, "OBJECT_TRIGGER")) {
    return [];
  }
  return [
    diagnostic(
      "SUPA_CHECK_CREATE_TRIGGER_REPLACEMENT",
      "error",
      "CREATE TRIGGER must be preceded by DROP TRIGGER IF EXISTS",
      { statement: text }
    ),
  ];
}

function checkConcurrentStatement(
  node: AstNode,
  text: string,
  kind: "index" | "refresh"
): Diagnostic[] {
  if (!readBoolean(node.concurrent)) {
    return [];
  }
  const isIndex = kind === "index";
  return [
    diagnostic(
      isIndex ? "SUPA_CHECK_NONTRANSACTIONAL_INDEX" : "SUPA_CHECK_NONTRANSACTIONAL_REFRESH",
      "warning",
      isIndex
        ? "CREATE INDEX CONCURRENTLY cannot run inside a transaction block"
        : "REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run inside a transaction block",
      {
        hint: "Run this migration with transaction wrapping disabled.",
        statement: text,
      }
    ),
  ];
}

function checkInsertStatement(node: AstNode, text: string): Diagnostic[] {
  if (asRecord(node.onConflictClause) !== undefined) {
    return [];
  }
  return [
    diagnostic(
      "SUPA_CHECK_INSERT_ON_CONFLICT",
      "error",
      "INSERT statements in migrations must use ON CONFLICT for replay safety",
      { statement: text }
    ),
  ];
}

function checkDmlStatement(text: string): Diagnostic[] {
  return [
    diagnostic(
      "SUPA_CHECK_DML_REVIEW",
      "warning",
      "data-modifying statements in migrations require explicit idempotency review",
      { statement: text }
    ),
  ];
}

function checkDropStatement(node: AstNode, text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (readString(node.behavior) === "DROP_CASCADE") {
    diagnostics.push(
      diagnostic("SUPA_CHECK_CASCADE", "error", "implicit CASCADE is forbidden", {
        hint: "Drop dependent objects explicitly in dependency order.",
        statement: text,
      })
    );
  }
  if (!readBoolean(node.missing_ok)) {
    diagnostics.push(
      diagnostic("SUPA_CHECK_DROP_IF_EXISTS", "error", "DROP statements must use IF EXISTS", {
        statement: text,
      })
    );
  }
  return diagnostics;
}

function checkFunctionStatement(node: AstNode, text: string): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (!readBoolean(node.replace)) {
    diagnostics.push(
      diagnostic(
        "SUPA_CHECK_CREATE_ROUTINE_REPLACE",
        "error",
        "FUNCTION and PROCEDURE creation must use OR REPLACE",
        { statement: text }
      )
    );
  }
  return diagnostics;
}

function checkAlterTableStatement(
  node: AstNode,
  text: string,
  previous: AstStatement | undefined
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const item of readArray(node.cmds)) {
    const command = asRecord(asRecord(item)?.AlterTableCmd);
    const subtype = readString(command?.subtype);
    if (subtype === "AT_AddConstraint") {
      diagnostics.push(
        diagnostic(
          "SUPA_CHECK_ADD_CONSTRAINT_GUARD",
          "error",
          "ADD CONSTRAINT must be wrapped in a catalog guard",
          { statement: text }
        )
      );
    }
    if (subtype === "AT_AlterColumnType") {
      diagnostics.push(
        diagnostic(
          "SUPA_CHECK_ALTER_COLUMN_TYPE_REWRITE",
          "warning",
          "ALTER COLUMN TYPE can rewrite the table under an ACCESS EXCLUSIVE lock",
          {
            hint: "Verify the rewrite window is acceptable for populated tables.",
            statement: text,
          }
        )
      );
    }
    if (
      subtype === "AT_SetNotNull" &&
      !hasValidatedNotNullProof(node, previous, readString(command?.name))
    ) {
      diagnostics.push(
        diagnostic(
          "SUPA_CHECK_SET_NOT_NULL_SCAN",
          "warning",
          "SET NOT NULL scans the full table unless a validated CHECK constraint already proves it",
          { statement: text }
        )
      );
    }
    if (subtype === "AT_AddColumn") {
      const columnDef = asRecord(asRecord(command?.def)?.ColumnDef);
      if (columnDef && hasVolatileDefault(columnDef)) {
        diagnostics.push(
          diagnostic(
            "SUPA_CHECK_VOLATILE_DEFAULT_REWRITE",
            "warning",
            "ADD COLUMN with a volatile default rewrites the whole table",
            {
              hint: "Add the column without a default, backfill in batches, then set the default.",
              statement: text,
            }
          )
        );
      }
    }
  }
  return diagnostics;
}

function hasValidatedNotNullProof(
  node: AstNode,
  previous: AstStatement | undefined,
  column: string | undefined
): boolean {
  if (!column) {
    return false;
  }
  if (previous?.tag !== "AlterTableStmt") {
    return false;
  }
  const previousNode = asRecord(previous.node.AlterTableStmt);
  const relation = rangeVarName(node.relation);
  if (
    !(previousNode && relation) ||
    relationIdentity(previousNode.relation) !== `${relation.schema}.${relation.name}`
  ) {
    return false;
  }
  const proofName = notNullProofConstraintName(relation.schema, relation.name, column);
  return readArray(previousNode.cmds).some((item) => {
    const command = asRecord(asRecord(item)?.AlterTableCmd);
    const name = readString(command?.name);
    return readString(command?.subtype) === "AT_ValidateConstraint" && name === proofName;
  });
}

function hasVolatileDefault(columnDef: AstNode): boolean {
  for (const item of readArray(columnDef.constraints)) {
    const constraint = asRecord(asRecord(item)?.Constraint);
    if (readString(constraint?.contype) !== "CONSTR_DEFAULT") {
      continue;
    }
    const funcCall = asRecord(asRecord(constraint?.raw_expr)?.FuncCall);
    const names = stringList(funcCall?.funcname);
    const callee = names.at(-1);
    if (callee && volatileDefaultFunctions.has(callee.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function previousDrops(previous: AstStatement | undefined, removeType: string): boolean {
  if (previous?.tag !== "DropStmt") {
    return false;
  }
  const node = asRecord(previous.node.DropStmt);
  return readString(node?.removeType) === removeType && readBoolean(node?.missing_ok);
}
