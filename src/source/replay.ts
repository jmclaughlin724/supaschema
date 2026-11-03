import { readFile } from "node:fs/promises";
import { deparseSync } from "pgsql-deparser";
import { diagnostic, hasErrors } from "../diagnostics/diagnostics.js";
import { fingerprintObjects, MODEL_FORMAT_VERSION } from "../hash.js";
import { type MigrationFilesOptions, migrationFiles } from "../migrations/files.js";
import { alterTableObjects, sourceAddConstraintCommand } from "../sql/alter-table.js";
import type { AstNode, AstStatement, ColumnFacts, QualifiedName } from "../sql/ast.js";
import {
  asRecord,
  astStatements,
  columnFacts,
  listItems,
  objectWithArgsIdentity,
  qualifiedName,
  rangeVarName,
  readArray,
  readBoolean,
  readString,
} from "../sql/ast.js";
import {
  commentTarget,
  grantTargetIdentity,
  isCommentForRefs,
  isGrantForTargets,
  relationOwnerKinds,
} from "../sql/dependents.js";
import { doBlockBody, doBlockDdlFragments } from "../sql/do-block.js";
import { extractObjectsFromSql } from "../sql/extract.js";
import { finalizeObjects } from "../sql/facts.js";
import { objectKey } from "../sql/identifiers.js";
import { shapeHash, stripLocations } from "../sql/object-hash.js";
import { parseSqlAst } from "../sql/parser.js";
import { buildCommentObject, commentStatementSql } from "../sql/privileges.js";
import {
  applyRlsTransition,
  defaultRlsState,
  isRlsTransitionSubtype,
  rlsStateFromMetadata,
  rlsStateSql,
} from "../sql/rls.js";
import { expressionSql, makeObject } from "../sql/statements.js";
import { ignoredStatementTags, sourceIntentStatementTags } from "../sql/support.js";
import { columnConstraintSyntheses } from "../sql/table-constraints.js";
import { canonicalColumnType, canonicalizeRegclassLiterals } from "../sql/table-shape.js";
import type {
  CommentTarget,
  Diagnostic,
  ObjectKind,
  ObjectRef,
  SchemaModel,
  SchemaObject,
  SupaschemaConfig,
  TableColumn,
} from "../types.js";
import { normalizeSourceObjects, privilegeTargetKey } from "./normalize.js";

interface ReplayResult {
  diagnostics: Diagnostic[];
  hardFail: boolean;
  nextOrdinal: number | undefined;
}

interface ReplayContext {
  config: SupaschemaConfig;
  idempotentCreate?: boolean;
  normalize: boolean;
}

interface ColumnShape extends Record<string, unknown> {
  name: string;
  notNull: boolean;
  type: string;
}

interface DropTarget {
  display: string;
  refs: ObjectRef[];
}

type MutableRecord = object;

const extractedStatementTags = new Set([
  "AlterDefaultPrivilegesStmt",
  "AlterSeqStmt",
  "CommentStmt",
  "CompositeTypeStmt",
  "CreateDomainStmt",
  "CreateEnumStmt",
  "CreateExtensionStmt",
  "CreateFdwStmt",
  "CreateForeignServerStmt",
  "CreateForeignTableStmt",
  "CreateFunctionStmt",
  "CreatePolicyStmt",
  "CreateRangeStmt",
  "CreateSchemaStmt",
  "CreateSeqStmt",
  "CreateStmt",
  "CreateTableAsStmt",
  "CreateTrigStmt",
  "GrantStmt",
  "IndexStmt",
  "ViewStmt",
]);

const createDuplicateGapTags = new Set([
  "CompositeTypeStmt",
  "CreateDomainStmt",
  "CreateEnumStmt",
  "CreateExtensionStmt",
  "CreateFdwStmt",
  "CreateForeignServerStmt",
  "CreateForeignTableStmt",
  "CreateFunctionStmt",
  "CreatePolicyStmt",
  "CreateRangeStmt",
  "CreateSchemaStmt",
  "CreateSeqStmt",
  "CreateStmt",
  "CreateTableAsStmt",
  "CreateTrigStmt",
  "IndexStmt",
  "ViewStmt",
]);

const normalizedAmendmentKeys = new Set([
  "columnDefaultAmendment",
  "columnGeneratedAmendment",
  "columnIdentityAmendment",
  "sequenceOwnedByAmendment",
  "tablePartitionAmendment",
]);

const supportedColumnConstraintTypes = new Set([
  "CONSTR_CHECK",
  "CONSTR_DEFAULT",
  "CONSTR_FOREIGN",
  "CONSTR_GENERATED",
  "CONSTR_IDENTITY",
  "CONSTR_NOTNULL",
  "CONSTR_NULL",
  "CONSTR_PRIMARY",
  "CONSTR_UNIQUE",
]);

const typegenNeutralStatementTags = new Set([
  "AlterRoleStmt",
  "CreateRoleStmt",
  "DropRoleStmt",
  "VariableSetStmt",
]);

export async function reconstructModelFromMigrations(
  directory: string,
  source: string,
  config: SupaschemaConfig,
  options: MigrationFilesOptions = {}
): Promise<SchemaModel> {
  const diagnostics: Diagnostic[] = [];
  const files = await migrationFiles(directory, options);
  if (files.length === 0) {
    const allFiles =
      options.excludeFiles === undefined || options.excludeFiles.length === 0
        ? files
        : await migrationFiles(directory, options.cwd === undefined ? {} : { cwd: options.cwd });
    if (allFiles.length > 0) {
      return replayModel(diagnostics, [], source);
    }
    diagnostics.push(
      replayDiagnostic(
        "SUPA_REPLAY_ORDER_GAP",
        "error",
        `no migration files found under ${directory}`
      )
    );
    return replayModel(diagnostics, [], source);
  }

  const objects = new Map<string, SchemaObject>();
  const context: ReplayContext = {
    config,
    normalize: config.normalize === "deparse",
  };
  let ordinal = 0;
  for (const file of files) {
    const result = await replayMigrationFile(file, objects, context, ordinal);
    diagnostics.push(...result.diagnostics);
    if (result.nextOrdinal !== undefined) {
      ordinal = result.nextOrdinal;
    }
    if (result.hardFail) {
      return replayModel(diagnostics, [], source);
    }
  }

  const normalized = await normalizeSourceObjects([...objects.values()], diagnostics, {
    normalize: context.normalize,
  });
  return replayModel(diagnostics, hasErrors(diagnostics) ? [] : normalized, source);
}

function replayModel(
  diagnostics: Diagnostic[],
  objects: SchemaObject[],
  source: string
): SchemaModel {
  const sorted = objects.sort((left, right) => left.ordinal - right.ordinal);
  return {
    diagnostics,
    fingerprint: fingerprintObjects(sorted),
    formatVersion: MODEL_FORMAT_VERSION,
    objects: sorted,
    source,
  };
}

async function replayMigrationFile(
  file: string,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  ordinal: number
): Promise<ReplayResult> {
  const sql = await readFile(file, "utf8");
  const parsed = await parseSqlAst(sql, file);
  if (parsed.ast === undefined) {
    return {
      diagnostics: parsed.diagnostics,
      hardFail: hasErrors(parsed.diagnostics),
      nextOrdinal: ordinal,
    };
  }

  const diagnostics = [...parsed.diagnostics];
  let nextOrdinal = ordinal;
  for (const statement of astStatements(parsed.ast, sql)) {
    const result = await applyReplayStatement(statement, objects, context, file, nextOrdinal);
    diagnostics.push(...result.diagnostics);
    if (result.nextOrdinal !== undefined) {
      nextOrdinal = result.nextOrdinal;
    }
    if (result.hardFail) {
      return { diagnostics, hardFail: true, nextOrdinal };
    }
  }
  return { diagnostics, hardFail: false, nextOrdinal };
}

async function applyReplayStatement(
  statement: AstStatement,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string,
  ordinal: number
): Promise<ReplayResult> {
  if (statement.text.length === 0 || ignoredStatementTags.has(statement.tag)) {
    return emptyResult();
  }
  const node = asRecord(statement.node[statement.tag]);
  if (!node) {
    return emptyResult();
  }
  return await applyStatement(statement, node, objects, context, file, ordinal);
}

async function applyStatement(
  statement: AstStatement,
  node: AstNode,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string,
  ordinal: number
): Promise<ReplayResult> {
  if (statement.tag === "DoStmt") {
    return await applyDoBlock(statement, node, objects, context, file, ordinal);
  }
  if (sourceIntentStatementTags.has(statement.tag)) {
    return emptyResult();
  }
  if (typegenNeutralStatementTags.has(statement.tag)) {
    return emptyResult();
  }
  if (extractedStatementTags.has(statement.tag)) {
    return await applyExtractedStatement(statement, objects, context, file, ordinal);
  }
  if (statement.tag === "AlterTableStmt") {
    return await applyAlterTable(statement, node, objects, context, file, ordinal);
  }
  if (statement.tag === "AlterEnumStmt") {
    return applyAlterEnum(statement, node, objects, file);
  }
  if (statement.tag === "AlterPolicyStmt") {
    return await applyAlterPolicy(statement, node, objects, context, file);
  }
  if (statement.tag === "RenameStmt") {
    return await applyRename(statement, node, objects, context, file);
  }
  if (statement.tag === "DropStmt") {
    return applyDrop(statement, node, objects, file);
  }
  return unsupportedStatement(
    statement,
    file,
    `unsupported ${statement.tag} statement during migration replay`
  );
}

async function applyDoBlock(
  _statement: AstStatement,
  node: AstNode,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string,
  ordinal: number
): Promise<ReplayResult> {
  const body = doBlockBody(node);
  if (body === undefined) {
    return emptyResult();
  }

  const diagnostics: Diagnostic[] = [];
  let nextOrdinal = ordinal;
  for (const fragment of doBlockDdlFragments(body)) {
    const parsed = await parseSqlAst(fragment.sql, file);
    if (parsed.ast === undefined) {
      diagnostics.push(
        replayDiagnostic(
          "SUPA_REPLAY_UNSUPPORTED",
          "error",
          "embedded DO statement could not be parsed during migration replay",
          { file, statement: fragment.sql }
        )
      );
      return { diagnostics, hardFail: true, nextOrdinal };
    }
    const nestedContext = fragment.idempotentCreate
      ? { ...context, idempotentCreate: true }
      : context;
    for (const nestedStatement of astStatements(parsed.ast, fragment.sql)) {
      const nestedNode = asRecord(nestedStatement.node[nestedStatement.tag]);
      if (!nestedNode) {
        continue;
      }
      const result = await applyStatement(
        nestedStatement,
        nestedNode,
        objects,
        nestedContext,
        file,
        nextOrdinal
      );
      diagnostics.push(...result.diagnostics);
      if (result.nextOrdinal !== undefined) {
        nextOrdinal = result.nextOrdinal;
      }
      if (result.hardFail) {
        return { diagnostics, hardFail: true, nextOrdinal };
      }
    }
  }
  return { diagnostics, hardFail: false, nextOrdinal };
}

async function applyExtractedStatement(
  statement: AstStatement,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string,
  ordinal: number
): Promise<ReplayResult> {
  const extracted = await extractObjectsFromSql(statement.text, {
    config: context.config,
    existingObjects: [...objects.values()],
    file,
    startOrdinal: ordinal,
  });
  const diagnostics = replayExtractionDiagnostics(extracted.diagnostics);
  if (hasErrors(diagnostics)) {
    return { diagnostics, hardFail: true, nextOrdinal: extracted.nextOrdinal };
  }

  const nextOrdinal = extracted.nextOrdinal;
  if (isIdempotentDuplicateCreateStatement(statement, extracted.objects, objects, context)) {
    return { diagnostics, hardFail: false, nextOrdinal };
  }
  for (const object of extracted.objects) {
    const result = await applyExtractedObject(statement, object, objects, context, file);
    diagnostics.push(...result.diagnostics);
    if (result.hardFail) {
      return { diagnostics, hardFail: true, nextOrdinal };
    }
  }
  return { diagnostics, hardFail: false, nextOrdinal };
}

function isIdempotentDuplicateCreateStatement(
  statement: AstStatement,
  extracted: SchemaObject[],
  objects: Map<string, SchemaObject>,
  context: ReplayContext
): boolean {
  if (!createDuplicateGapTags.has(statement.tag)) {
    return false;
  }
  if (context.idempotentCreate !== true && !isIfNotExistsStatement(statement)) {
    return false;
  }
  return extracted.some(
    (object) => !isNormalizedAmendmentMarker(object) && objects.has(object.key)
  );
}

async function applyReplayGrantTransition(
  object: SchemaObject,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string,
  statement: string
): Promise<ReplayResult> {
  const targetKey = privilegeTargetKey(object);
  const existing = [...objects.values()].filter(
    (candidate) => candidate.ref.kind === "grant" && privilegeTargetKey(candidate) === targetKey
  );
  if (existing.length === 0) {
    objects.set(object.key, object);
    return emptyResult();
  }
  const diagnostics: Diagnostic[] = [];
  const normalized = await normalizeSourceObjects([...existing, object], diagnostics, {
    normalize: context.normalize,
  });
  if (hasErrors(diagnostics)) {
    return { diagnostics, hardFail: true, nextOrdinal: undefined };
  }
  const grants = normalized.filter((candidate) => candidate.ref.kind === "grant");
  if (new Set(grants.map((candidate) => candidate.key)).size !== grants.length) {
    return orderGap(
      `privilege statements for ${object.key} could not be merged safely`,
      file,
      statement,
      object.ref
    );
  }
  for (const previous of existing) {
    objects.delete(previous.key);
  }
  for (const grant of grants) {
    objects.set(grant.key, grant);
  }
  return emptyResult();
}

async function applyExtractedObject(
  statement: AstStatement,
  object: SchemaObject,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string
): Promise<ReplayResult> {
  if (isNormalizedAmendmentMarker(object)) {
    return await applyNormalizedAmendment(object, objects, context);
  }
  if (object.ref.kind === "comment" && typeof object.metadata.description !== "string") {
    objects.delete(object.key);
    return emptyResult();
  }
  if (object.ref.kind === "grant") {
    return await applyReplayGrantTransition(object, objects, context, file, statement.text);
  }
  const existing = objects.get(object.key);
  if (existing && object.ref.kind === "default-privilege") {
    return await mergeReplayPrivilege(existing, object, objects, context, file, statement.text);
  }
  if (existing && statement.tag === "AlterTableStmt" && object.ref.kind === "constraint") {
    if (context.idempotentCreate === true) {
      return emptyResult();
    }
    return orderGap(
      `ADD CONSTRAINT duplicates ${object.key} while replaying migration history`,
      file,
      statement.text,
      object.ref
    );
  }
  if (objects.has(object.key) && createDuplicateGapTags.has(statement.tag)) {
    if (isReplaceStatement(statement)) {
      objects.set(object.key, object);
      return emptyResult();
    }
    if (context.idempotentCreate === true || isIfNotExistsStatement(statement)) {
      return emptyResult();
    }
    return orderGap(
      `CREATE duplicates ${object.key} while replaying migration history`,
      file,
      statement.text,
      object.ref
    );
  }
  objects.set(object.key, object);
  return emptyResult();
}

async function mergeReplayPrivilege(
  existing: SchemaObject,
  incoming: SchemaObject,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string,
  statement: string
): Promise<ReplayResult> {
  const diagnostics: Diagnostic[] = [];
  const normalized = await normalizeSourceObjects([existing, incoming], diagnostics, {
    normalize: context.normalize,
  });
  if (hasErrors(diagnostics)) {
    return { diagnostics, hardFail: true, nextOrdinal: undefined };
  }
  const merged = normalized.filter((object) => object.key === incoming.key);
  if (merged.length > 1) {
    return orderGap(
      `privilege statements for ${incoming.key} could not be merged safely`,
      file,
      statement,
      incoming.ref
    );
  }
  const next = merged[0];
  if (next) {
    objects.set(incoming.key, next);
  } else {
    objects.delete(incoming.key);
  }
  return emptyResult();
}

function isReplaceStatement(statement: AstStatement): boolean {
  const node = asRecord(statement.node[statement.tag]);
  return (
    (statement.tag === "CreateFunctionStmt" ||
      statement.tag === "CreateTrigStmt" ||
      statement.tag === "ViewStmt") &&
    readBoolean(node?.replace) === true
  );
}

function isIfNotExistsStatement(statement: AstStatement): boolean {
  const node = asRecord(statement.node[statement.tag]);
  return readBoolean(node?.if_not_exists) === true;
}

async function applyAlterTable(
  statement: AstStatement,
  node: AstNode,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string,
  ordinal: number
): Promise<ReplayResult> {
  if (readString(node.objtype) === "OBJECT_VIEW") {
    return await applyAlterViewOptions(statement, node, objects, context, file);
  }
  const tableName = rangeVarName(node.relation);
  if (!tableName) {
    return unsupportedStatement(statement, file, "ALTER TABLE relation could not be resolved");
  }
  const table = tableLikeObject(objects, tableName);
  if (!table) {
    if (isConfigIgnoredSchema(tableName.schema, context.config)) {
      return emptyResult();
    }
    return orderGap(
      `ALTER TABLE target ${qualifiedDisplayName(tableName)} is absent from replay state`,
      file,
      statement.text,
      { kind: "table", name: tableName.name, schema: tableName.schema }
    );
  }

  const diagnostics: Diagnostic[] = [];
  let nextOrdinal = ordinal;
  for (const rawCommand of readArray(node.cmds)) {
    const result = await applyAlterTableCommand({
      context,
      file,
      node,
      objects,
      ordinal: nextOrdinal,
      rawCommand,
      statement,
      table,
    });
    diagnostics.push(...result.diagnostics);
    if (result.nextOrdinal !== undefined) {
      nextOrdinal = result.nextOrdinal;
    }
    if (result.hardFail) {
      return { diagnostics, hardFail: true, nextOrdinal };
    }
  }
  return { diagnostics, hardFail: false, nextOrdinal };
}

async function applyAlterViewOptions(
  statement: AstStatement,
  node: AstNode,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string
): Promise<ReplayResult> {
  const viewName = rangeVarName(node.relation);
  if (!viewName) {
    return unsupportedStatement(statement, file, "ALTER VIEW relation could not be resolved");
  }
  const ref: ObjectRef = { kind: "view", ...viewName };
  const key = objectKey(ref);
  const target = objects.get(key);
  if (!target) {
    if (
      readBoolean(node.missing_ok) === true ||
      isConfigIgnoredSchema(viewName.schema, context.config)
    ) {
      return emptyResult();
    }
    return orderGap(
      `ALTER VIEW target ${qualifiedDisplayName(viewName)} is absent from replay state`,
      file,
      statement.text,
      ref
    );
  }
  const parsed = await parseSqlAst(target.sql, target.file);
  if (parsed.ast === undefined || hasErrors(parsed.diagnostics)) {
    return unsupportedStatement(
      statement,
      file,
      `could not parse ${key} while altering migration replay state`
    );
  }
  const ast = structuredClone(parsed.ast);
  let view: MutableRecord | undefined;
  visitMutableAst(ast, (astNode) => {
    view ??= mutableRecord(mutableGet(astNode, "ViewStmt"));
  });
  if (!view) {
    return unsupportedStatement(statement, file, `${key} has no rewritable view definition`);
  }
  for (const rawCommand of readArray(node.cmds)) {
    const error = applyAlterViewOptionCommand(view, rawCommand);
    if (error) {
      return unsupportedStatement(statement, file, error);
    }
  }
  let sql: string;
  try {
    sql = deparseSync(JSON.parse(JSON.stringify(ast)));
  } catch {
    return unsupportedStatement(
      statement,
      file,
      `could not deparse ${key} while altering migration replay state`
    );
  }
  const next = makeObject(ref, sql, target.ordinal, target.file);
  const diagnostics = await finalizeObjects([next], {
    normalize: context.normalize,
  });
  if (hasErrors(diagnostics)) {
    return { diagnostics, hardFail: true, nextOrdinal: undefined };
  }
  objects.set(key, next);
  return { diagnostics, hardFail: false, nextOrdinal: undefined };
}

async function applyAlterPolicy(
  statement: AstStatement,
  node: AstNode,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string
): Promise<ReplayResult> {
  const tableName = rangeVarName(node.table);
  const policyName = readString(node.policy_name);
  if (!(tableName && policyName)) {
    return unsupportedStatement(statement, file, "ALTER POLICY target could not be resolved");
  }
  const ref: ObjectRef = {
    kind: "policy",
    name: policyName,
    schema: tableName.schema,
    table: tableName.name,
  };
  const key = objectKey(ref);
  const target = objects.get(key);
  if (!target) {
    if (isConfigIgnoredSchema(tableName.schema, context.config)) {
      return emptyResult();
    }
    return orderGap(
      `ALTER POLICY target ${qualifiedDisplayName(tableName)}.${policyName} is absent from replay state`,
      file,
      statement.text,
      ref
    );
  }
  const parsed = await parseSqlAst(target.sql, target.file);
  if (parsed.ast === undefined || hasErrors(parsed.diagnostics)) {
    return unsupportedStatement(
      statement,
      file,
      `could not parse ${key} while altering migration replay state`
    );
  }
  const ast = structuredClone(parsed.ast);
  let policy: MutableRecord | undefined;
  visitMutableAst(ast, (astNode) => {
    policy ??= mutableRecord(mutableGet(astNode, "CreatePolicyStmt"));
  });
  if (!policy) {
    return unsupportedStatement(statement, file, `${key} has no rewritable policy definition`);
  }
  applyAlterPolicyFields(policy, node);
  let sql: string;
  try {
    sql = deparseSync(JSON.parse(JSON.stringify(ast)));
  } catch {
    return unsupportedStatement(
      statement,
      file,
      `could not deparse ${key} while altering migration replay state`
    );
  }
  const next = makeObject(ref, sql, target.ordinal, target.file);
  const diagnostics = await finalizeObjects([next], {
    normalize: context.normalize,
  });
  if (hasErrors(diagnostics)) {
    return { diagnostics, hardFail: true, nextOrdinal: undefined };
  }
  objects.set(key, next);
  return { diagnostics, hardFail: false, nextOrdinal: undefined };
}

function applyAlterPolicyFields(policy: MutableRecord, alteration: AstNode): void {
  const roles = readArray(alteration.roles);
  if (roles.length > 0) {
    mutableSet(policy, "roles", structuredClone(roles));
  }
  for (const field of ["qual", "with_check"]) {
    const value = alteration[field];
    if (value !== undefined) {
      mutableSet(policy, field, structuredClone(value));
    }
  }
}

function applyAlterViewOptionCommand(view: MutableRecord, rawCommand: unknown): string | undefined {
  const command = asRecord(asRecord(rawCommand)?.AlterTableCmd);
  const subtype = readString(command?.subtype);
  if (!(command && (subtype === "AT_SetRelOptions" || subtype === "AT_ResetRelOptions"))) {
    return `unsupported ALTER VIEW subtype ${subtype ?? "unknown"} during migration replay`;
  }
  const options = listItems(command.def);
  if (options.length === 0) {
    return `ALTER VIEW ${
      subtype === "AT_SetRelOptions" ? "SET" : "RESET"
    } has no supported options`;
  }
  for (const option of options) {
    if (!isSecurityInvokerOption(option)) {
      return "only ALTER VIEW SET/RESET (security_invoker) is supported during migration replay";
    }
    updateSecurityInvokerOption(view, option, subtype === "AT_SetRelOptions");
  }
}

function isSecurityInvokerOption(option: unknown): boolean {
  const defElem = asRecord(asRecord(option)?.DefElem);
  return readString(defElem?.defname)?.toLowerCase() === "security_invoker";
}

function updateSecurityInvokerOption(
  view: MutableRecord,
  option: unknown,
  shouldSet: boolean
): void {
  const current = readArray(mutableGet(view, "options"));
  const existingIndex = current.findIndex(isSecurityInvokerOption);
  if (shouldSet) {
    const next = [...current];
    if (existingIndex >= 0) {
      next[existingIndex] = structuredClone(option);
    } else {
      next.push(structuredClone(option));
    }
    mutableSet(view, "options", next);
    return;
  }
  const next = current.filter((_item, index) => index !== existingIndex);
  if (next.length > 0) {
    mutableSet(view, "options", next);
  } else {
    Reflect.deleteProperty(view, "options");
  }
}

async function applyAlterTableCommand(options: {
  context: ReplayContext;
  file: string;
  node: AstNode;
  objects: Map<string, SchemaObject>;
  ordinal: number;
  rawCommand: unknown;
  statement: AstStatement;
  table: SchemaObject;
}): Promise<ReplayResult> {
  const command = asRecord(asRecord(options.rawCommand)?.AlterTableCmd);
  if (!command) {
    return unsupportedStatement(
      options.statement,
      options.file,
      "unresolved ALTER TABLE command during migration replay"
    );
  }

  const subtype = readString(command.subtype);
  if (isRlsTransitionSubtype(subtype)) {
    return await applyRlsMutation(options, subtype);
  }
  const custom = await applyColumnMutation(
    options.statement,
    subtype,
    command,
    options.table,
    options.objects,
    options.context,
    options.file,
    options.ordinal
  );
  if (custom !== undefined) {
    return custom.nextOrdinal === undefined ? { ...custom, nextOrdinal: options.ordinal } : custom;
  }

  const existingConstraintNames = constraintNamesForTable(options.objects, options.table);
  const sourceSqlMatchesAst = readArray(options.node.cmds).length === 1;
  const declaredConstraintName = readString(asRecord(asRecord(command.def)?.Constraint)?.conname);
  const sourceCommand =
    sourceSqlMatchesAst && declaredConstraintName !== undefined
      ? undefined
      : sourceAddConstraintCommand(
          options.node,
          command,
          options.statement,
          existingConstraintNames
        );
  const commandStatement =
    sourceCommand?.statement ?? (sourceSqlMatchesAst ? options.statement.text : undefined);
  const extracted = alterTableObjects(
    {
      ...options.node,
      cmds: [sourceCommand ? { AlterTableCmd: sourceCommand.command } : options.rawCommand],
    },
    commandStatement ?? options.statement.text,
    options.ordinal,
    options.file,
    existingConstraintNames,
    commandStatement !== undefined
  );
  if (!extracted || extracted.length === 0) {
    return unsupportedStatement(
      options.statement,
      options.file,
      `unsupported ALTER TABLE subtype ${subtype ?? "unknown"} during migration replay`
    );
  }

  const diagnostics = await finalizeObjects(extracted, {
    normalize: options.context.normalize,
  });
  if (hasErrors(diagnostics)) {
    return { diagnostics, hardFail: true, nextOrdinal: options.ordinal };
  }
  return applyExtractedObjects(options, extracted, diagnostics);
}

async function applyRlsMutation(
  options: {
    context: ReplayContext;
    file: string;
    objects: Map<string, SchemaObject>;
    ordinal: number;
    statement: AstStatement;
    table: SchemaObject;
  },
  transition: Parameters<typeof applyRlsTransition>[1]
): Promise<ReplayResult> {
  const ref: ObjectRef = {
    kind: "rls",
    name: options.table.ref.name,
    ...(options.table.ref.schema === undefined ? {} : { schema: options.table.ref.schema }),
    table: options.table.ref.name,
  };
  const key = objectKey(ref);
  const existing = options.objects.get(key);
  const before = existing ? rlsStateFromMetadata(existing.metadata) : defaultRlsState;
  if (!before) {
    return unsupportedStatement(
      options.statement,
      options.file,
      `RLS state for ${key} is not canonical`
    );
  }
  const after = applyRlsTransition(before, transition);
  if (!(after.rlsEnabled || after.rlsForced)) {
    options.objects.delete(key);
    return { ...emptyResult(), nextOrdinal: options.ordinal + 1 };
  }
  const next = makeObject(
    ref,
    rlsStateSql(ref.schema, ref.table ?? ref.name, after),
    existing?.ordinal ?? options.ordinal,
    existing?.file ?? options.file,
    { ...after }
  );
  const diagnostics = await finalizeObjects([next], {
    normalize: options.context.normalize,
  });
  if (hasErrors(diagnostics)) {
    return { diagnostics, hardFail: true, nextOrdinal: options.ordinal + 1 };
  }
  options.objects.set(key, next);
  return { diagnostics, hardFail: false, nextOrdinal: options.ordinal + 1 };
}

async function applyExtractedObjects(
  options: {
    context: ReplayContext;
    file: string;
    objects: Map<string, SchemaObject>;
    ordinal: number;
    statement: AstStatement;
  },
  extracted: SchemaObject[],
  diagnostics: Diagnostic[]
): Promise<ReplayResult> {
  let nextOrdinal = options.ordinal;
  for (const object of extracted) {
    const result = await applyExtractedObject(
      options.statement,
      object,
      options.objects,
      options.context,
      options.file
    );
    diagnostics.push(...result.diagnostics);
    if (result.hardFail) {
      return { diagnostics, hardFail: true, nextOrdinal };
    }
    nextOrdinal += 1;
  }
  return { diagnostics, hardFail: false, nextOrdinal };
}

function isConfigIgnoredSchema(schema: string | undefined, config: SupaschemaConfig): boolean {
  const name = schema ?? "public";
  if (config.managedSchemas.includes(name)) {
    return true;
  }
  if (config.schemas.exclude.includes(name)) {
    return true;
  }
  return config.schemas.include.length > 0 && !config.schemas.include.includes(name);
}

function qualifiedDisplayName(name: QualifiedName): string {
  return name.schema === undefined ? name.name : `${name.schema}.${name.name}`;
}

async function applyColumnMutation(
  statement: AstStatement,
  subtype: string | undefined,
  command: AstNode,
  table: SchemaObject,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string,
  ordinal: number
): Promise<ReplayResult | undefined> {
  if (subtype === "AT_ValidateConstraint") {
    return await applyValidateConstraint(statement, command, table, objects, context, file);
  }
  if (subtype === "AT_AddConstraint") {
    const constraint = asRecord(asRecord(command.def)?.Constraint);
    if (readString(constraint?.indexname) !== undefined) {
      return await applyConstraintUsingIndex(
        statement,
        command,
        table,
        objects,
        context,
        file,
        ordinal
      );
    }
  }
  if (subtype === "AT_AddColumn") {
    return await applyAddColumn(statement, command, table, objects, context, file, ordinal);
  }
  if (subtype === "AT_DropColumn") {
    return applyDropColumn(statement, command, table, objects, file);
  }
  if (subtype === "AT_AlterColumnType") {
    return applyAlterColumnType(statement, command, table, file);
  }
  if (subtype === "AT_SetNotNull" || subtype === "AT_DropNotNull") {
    return applyNotNull(statement, command, table, subtype === "AT_SetNotNull", file);
  }
  if (subtype === "AT_DropConstraint") {
    return applyDropConstraint(statement, command, table, objects, file);
  }
}

async function applyValidateConstraint(
  statement: AstStatement,
  command: AstNode,
  table: SchemaObject,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string
): Promise<ReplayResult> {
  const name = readString(command.name);
  if (!name) {
    return unsupportedStatement(
      statement,
      file,
      "constraint validation target could not be resolved"
    );
  }
  const ref: ObjectRef = {
    kind: "constraint",
    name,
    ...(table.ref.schema === undefined ? {} : { schema: table.ref.schema }),
    table: table.ref.name,
  };
  const key = objectKey(ref);
  const target = objects.get(key);
  if (!target) {
    return orderGap(`VALIDATE CONSTRAINT targets absent object ${key}`, file, statement.text, ref);
  }
  const parsed = await parseSqlAst(target.sql, target.file);
  if (parsed.ast === undefined || hasErrors(parsed.diagnostics)) {
    return unsupportedStatement(
      statement,
      file,
      `could not parse ${key} while validating migration replay state`
    );
  }
  const ast = structuredClone(parsed.ast);
  let changed = false;
  visitMutableAst(ast, (node) => {
    const constraint = mutableRecord(mutableGet(node, "Constraint"));
    if (constraint && mutableGet(constraint, "conname") === name) {
      Reflect.deleteProperty(constraint, "skip_validation");
      mutableSet(constraint, "initially_valid", true);
      changed = true;
    }
  });
  if (!changed) {
    return unsupportedStatement(statement, file, `${key} has no rewritable constraint definition`);
  }
  let sql: string;
  try {
    sql = deparseSync(JSON.parse(JSON.stringify(ast)));
  } catch {
    return unsupportedStatement(
      statement,
      file,
      `could not deparse ${key} while validating migration replay state`
    );
  }
  const next = makeObject(ref, sql, target.ordinal, target.file, structuredClone(target.metadata));
  const diagnostics = await finalizeObjects([next], {
    normalize: context.normalize,
  });
  if (hasErrors(diagnostics)) {
    return { diagnostics, hardFail: true, nextOrdinal: undefined };
  }
  objects.set(key, next);
  return { diagnostics, hardFail: false, nextOrdinal: undefined };
}

async function applyConstraintUsingIndex(
  statement: AstStatement,
  command: AstNode,
  table: SchemaObject,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string,
  ordinal: number
): Promise<ReplayResult> {
  const constraint = asRecord(asRecord(command.def)?.Constraint);
  const indexName = readString(constraint?.indexname);
  if (!(constraint && indexName)) {
    return unsupportedStatement(statement, file, "backing index target could not be resolved");
  }
  const schema = table.ref.schema ?? "public";
  const backing = [...objects].find(
    ([, object]) =>
      object.ref.kind === "index" &&
      object.ref.name === indexName &&
      (object.ref.schema ?? "public") === schema &&
      object.ref.table === table.ref.name
  );
  const indexRef: ObjectRef = {
    kind: "index",
    name: indexName,
    ...(table.ref.schema === undefined ? {} : { schema: table.ref.schema }),
    table: table.ref.name,
  };
  if (!backing) {
    return orderGap(
      `ADD CONSTRAINT references absent backing index ${objectKey(indexRef)}`,
      file,
      statement.text,
      indexRef
    );
  }
  const parsed = await parseSqlAst(backing[1].sql, backing[1].file);
  const indexStatement =
    parsed.ast === undefined
      ? undefined
      : astStatements(parsed.ast, backing[1].sql).find((item) => item.tag === "IndexStmt");
  const indexNode = asRecord(indexStatement?.node.IndexStmt);
  const columns = indexNode ? attachableUniqueIndexColumns(indexNode, table, indexName) : undefined;
  if (!columns) {
    return unsupportedStatement(
      statement,
      file,
      `backing index ${backing[1].key} is not a directly attachable unique index`
    );
  }
  const nextCommand = structuredClone(command);
  const nextDefinition = asRecord(nextCommand.def) ?? {};
  const nextConstraint = asRecord(nextDefinition.Constraint);
  if (!nextConstraint) {
    return unsupportedStatement(statement, file, "backing index constraint could not be rewritten");
  }
  if (readString(nextConstraint.conname) === undefined) {
    nextConstraint.conname = indexName;
  }
  Reflect.deleteProperty(nextConstraint, "indexname");
  nextConstraint.keys = columns.map((name) => ({ String: { sval: name } }));
  nextCommand.def = { ...nextDefinition, Constraint: nextConstraint };
  const alterTable = asRecord(statement.node.AlterTableStmt);
  const extracted = alterTable
    ? alterTableObjects(
        { ...alterTable, cmds: [{ AlterTableCmd: nextCommand }] },
        statement.text,
        ordinal,
        file,
        constraintNamesForTable(objects, table),
        false
      )
    : undefined;
  if (!extracted || extracted.length === 0) {
    return unsupportedStatement(statement, file, "backing index constraint could not be modeled");
  }
  const diagnostics = await finalizeObjects(extracted, {
    normalize: context.normalize,
  });
  if (hasErrors(diagnostics)) {
    return { diagnostics, hardFail: true, nextOrdinal: ordinal };
  }
  const applied = await applyExtractedObjects(
    { context, file, objects, ordinal, statement },
    extracted,
    diagnostics
  );
  if (!applied.hardFail) {
    objects.delete(backing[0]);
  }
  return applied;
}

function attachableUniqueIndexColumns(
  index: AstNode,
  table: SchemaObject,
  indexName: string
): string[] | undefined {
  const relation = rangeVarName(index.relation);
  if (
    readString(index.idxname) !== indexName ||
    readBoolean(index.unique) !== true ||
    readString(index.accessMethod) !== "btree" ||
    !relation ||
    relation.name !== table.ref.name ||
    (relation.schema ?? "public") !== (table.ref.schema ?? "public") ||
    index.whereClause !== undefined ||
    readArray(index.indexIncludingParams).length > 0 ||
    readArray(index.options).length > 0 ||
    readString(index.tableSpace) !== undefined
  ) {
    return;
  }
  const columns: string[] = [];
  for (const item of readArray(index.indexParams)) {
    const element = asRecord(asRecord(item)?.IndexElem);
    const name = readString(element?.name);
    if (
      !(element && name) ||
      element.expr !== undefined ||
      readArray(element.collation).length > 0 ||
      readArray(element.opclass).length > 0 ||
      readArray(element.opclassopts).length > 0 ||
      readString(element.ordering) !== "SORTBY_DEFAULT" ||
      readString(element.nulls_ordering) !== "SORTBY_NULLS_DEFAULT"
    ) {
      return;
    }
    columns.push(name);
  }
  return columns.length > 0 ? columns : undefined;
}

async function applyAddColumn(
  statement: AstStatement,
  command: AstNode,
  table: SchemaObject,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string,
  ordinal: number
): Promise<ReplayResult> {
  const columnDef = asRecord(asRecord(command.def)?.ColumnDef);
  const facts = columnFacts(command.def);
  if (!(columnDef && facts)) {
    return unsupportedStatement(statement, file, "ADD COLUMN definition could not be resolved");
  }
  const shape = tableShape(table);
  const shapeColumns = tableShapeColumns(shape);
  if (!(shape && shapeColumns)) {
    return unsupportedStatement(statement, file, `${table.key} has no canonical table shape`);
  }
  if (shapeColumns.some((column) => column.name === facts.name)) {
    if (readBoolean(command.missing_ok) === true) {
      return emptyResult();
    }
    return orderGap(
      `ADD COLUMN duplicates ${table.key}.${facts.name}`,
      file,
      statement.text,
      table.ref
    );
  }
  const unsupportedConstraints = unsupportedColumnConstraints(columnDef);
  if (unsupportedConstraints.length > 0) {
    return unsupportedStatement(
      statement,
      file,
      `ADD COLUMN contains unsupported inline constraints: ${unsupportedConstraints.join(", ")}`
    );
  }

  const canonical = canonicalColumnFromColumnDef(columnDef);
  if (!canonical) {
    return unsupportedStatement(
      statement,
      file,
      "ADD COLUMN canonical shape could not be resolved"
    );
  }
  updateTableShape(table, { ...shape, columns: [...shapeColumns, canonical] }, statement.text);
  table.metadata.columns = [
    ...tableMetadataColumns(table),
    metadataColumnFromFacts(facts, columnDef),
  ];
  const tableName: QualifiedName = {
    name: table.ref.name,
    schema: table.ref.schema ?? "public",
  };
  const extracted = columnConstraintSyntheses(
    columnDef,
    tableName,
    statement.text,
    statement.byteStart,
    constraintNamesForTable(objects, table)
  ).map((synthesized, index) =>
    makeObject(
      {
        kind: "constraint",
        name: synthesized.name,
        schema: tableName.schema,
        table: tableName.name,
      },
      synthesized.sql,
      ordinal + index,
      file,
      synthesized.metadata
    )
  );
  if (extracted.length === 0) {
    return emptyResult();
  }
  const diagnostics = await finalizeObjects(extracted, {
    normalize: context.normalize,
  });
  if (hasErrors(diagnostics)) {
    return { diagnostics, hardFail: true, nextOrdinal: ordinal };
  }
  return applyExtractedObjects(
    { context, file, objects, ordinal, statement },
    extracted,
    diagnostics
  );
}

function constraintNamesForTable(
  objects: Map<string, SchemaObject>,
  table: SchemaObject
): string[] {
  const schema = table.ref.schema ?? "public";
  return [...objects.values()].flatMap((object) =>
    object.ref.kind === "constraint" &&
    (object.ref.schema ?? "public") === schema &&
    object.ref.table === table.ref.name
      ? [object.ref.name]
      : []
  );
}

function applyDropColumn(
  statement: AstStatement,
  command: AstNode,
  table: SchemaObject,
  objects: Map<string, SchemaObject>,
  file: string
): ReplayResult {
  const columnName = readString(command.name);
  if (!columnName) {
    return unsupportedStatement(statement, file, "DROP COLUMN name could not be resolved");
  }
  const shape = tableShape(table);
  const shapeColumns = tableShapeColumns(shape);
  const columnIndex = shapeColumns?.findIndex((column) => column.name === columnName) ?? -1;
  if (!(shape && shapeColumns && columnIndex >= 0)) {
    if (readBoolean(command.missing_ok) === true) {
      return emptyResult();
    }
    return orderGap(
      `DROP COLUMN targets absent column ${table.key}.${columnName}`,
      file,
      statement.text,
      table.ref
    );
  }
  updateTableShape(
    table,
    {
      ...shape,
      columns: shapeColumns.filter((column) => column.name !== columnName),
    },
    statement.text
  );
  table.metadata.columns = tableMetadataColumns(table).filter(
    (column) => column.name !== columnName
  );
  removeColumnDependents(objects, table, columnName);
  return emptyResult();
}

function applyAlterColumnType(
  statement: AstStatement,
  command: AstNode,
  table: SchemaObject,
  file: string
): ReplayResult {
  const columnName = readString(command.name);
  const columnDef = asRecord(asRecord(command.def)?.ColumnDef);
  if (!(columnName && columnDef)) {
    return unsupportedStatement(
      statement,
      file,
      "ALTER COLUMN TYPE definition could not be resolved"
    );
  }
  const nextType = canonicalColumnType(columnDef.typeName);
  return mutateTableColumn(
    statement,
    table,
    columnName,
    file,
    (column) => ({ ...column, type: nextType }),
    (column) => ({
      ...column,
      definition: nextType,
      type: nextType,
    })
  );
}

function applyNotNull(
  statement: AstStatement,
  command: AstNode,
  table: SchemaObject,
  notNull: boolean,
  file: string
): ReplayResult {
  const columnName = readString(command.name);
  if (!columnName) {
    return unsupportedStatement(
      statement,
      file,
      "ALTER COLUMN nullability target could not be resolved"
    );
  }
  return mutateTableColumn(
    statement,
    table,
    columnName,
    file,
    (column) => ({ ...column, notNull }),
    (column) => ({
      ...column,
      notNull,
    })
  );
}

function applyDropConstraint(
  statement: AstStatement,
  command: AstNode,
  table: SchemaObject,
  objects: Map<string, SchemaObject>,
  file: string
): ReplayResult {
  const constraintName = readString(command.name);
  if (!constraintName) {
    return unsupportedStatement(statement, file, "DROP CONSTRAINT name could not be resolved");
  }
  const ref: ObjectRef =
    table.ref.schema === undefined
      ? { kind: "constraint", name: constraintName, table: table.ref.name }
      : {
          kind: "constraint",
          name: constraintName,
          schema: table.ref.schema,
          table: table.ref.name,
        };
  const key = objectKey(ref);
  if (objects.delete(key) || readBoolean(command.missing_ok) === true) {
    return emptyResult();
  }
  return orderGap(`DROP CONSTRAINT targets absent constraint ${key}`, file, statement.text, ref);
}

function mutateTableColumn(
  statement: AstStatement,
  table: SchemaObject,
  columnName: string,
  file: string,
  mutateShape: (column: ColumnShape) => ColumnShape,
  mutateMetadata: (column: TableColumn) => TableColumn
): ReplayResult {
  const shape = tableShape(table);
  const shapeColumns = tableShapeColumns(shape);
  const columnIndex = shapeColumns?.findIndex((column) => column.name === columnName) ?? -1;
  if (!(shape && shapeColumns && columnIndex >= 0)) {
    return orderGap(
      `ALTER COLUMN targets absent column ${table.key}.${columnName}`,
      file,
      statement.text,
      table.ref
    );
  }
  const nextShapeColumns = [...shapeColumns];
  const current = nextShapeColumns[columnIndex];
  if (!current) {
    return unsupportedStatement(statement, file, `column ${columnName} could not be resolved`);
  }
  nextShapeColumns[columnIndex] = mutateShape(current);
  updateTableShape(table, { ...shape, columns: nextShapeColumns }, statement.text);
  table.metadata.columns = tableMetadataColumns(table).map((column) =>
    column.name === columnName ? mutateMetadata(column) : column
  );
  return emptyResult();
}

function applyAlterEnum(
  statement: AstStatement,
  node: AstNode,
  objects: Map<string, SchemaObject>,
  file: string
): ReplayResult {
  const name = qualifiedName(node.typeName);
  if (!name) {
    return unsupportedStatement(statement, file, "ALTER TYPE enum name could not be resolved");
  }
  const enumObject = objects.get(objectKey({ kind: "enum", ...name }));
  if (!enumObject) {
    return orderGap(
      `ALTER TYPE targets absent enum ${qualifiedObjectName(name)}`,
      file,
      statement.text,
      { kind: "enum", ...name }
    );
  }
  const values = enumValues(enumObject);
  const oldValue = stringNode(node.oldVal);
  if (oldValue !== undefined) {
    const nextValue = stringNode(node.newVal);
    if (nextValue === undefined) {
      return unsupportedStatement(
        statement,
        file,
        "ALTER TYPE RENAME VALUE target could not be resolved"
      );
    }
    const index = values.indexOf(oldValue);
    if (index === -1) {
      return orderGap(
        `ALTER TYPE RENAME VALUE targets absent enum value ${oldValue}`,
        file,
        statement.text,
        enumObject.ref
      );
    }
    if (oldValue !== nextValue && values.includes(nextValue)) {
      return orderGap(
        `ALTER TYPE RENAME VALUE would duplicate enum value ${nextValue}`,
        file,
        statement.text,
        enumObject.ref
      );
    }
    values[index] = nextValue;
    enumObject.metadata = { ...enumObject.metadata, values };
    enumObject.hash = shapeHash({ values }, enumObject.key, enumObject.ref);
    enumObject.sql = `${enumObject.sql};\n${statement.text}`;
    return emptyResult();
  }
  const value = stringNode(node.newVal);
  if (value === undefined) {
    return unsupportedStatement(
      statement,
      file,
      "ALTER TYPE ADD VALUE value could not be resolved"
    );
  }
  if (values.includes(value)) {
    return emptyResult();
  }
  const neighbor = stringNode(node.newValNeighbor);
  if (neighbor === undefined) {
    values.push(value);
  } else {
    const index = values.indexOf(neighbor);
    if (index === -1) {
      return orderGap(
        `ALTER TYPE ADD VALUE references absent enum neighbor ${neighbor}`,
        file,
        statement.text,
        enumObject.ref
      );
    }
    values.splice(readBoolean(node.newValIsAfter) ? index + 1 : index, 0, value);
  }
  enumObject.metadata = { ...enumObject.metadata, values };
  enumObject.hash = shapeHash({ values }, enumObject.key, enumObject.ref);
  enumObject.sql = `${enumObject.sql};\n${statement.text}`;
  return emptyResult();
}

async function applyRename(
  statement: AstStatement,
  node: AstNode,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string
): Promise<ReplayResult> {
  const renameType = readString(node.renameType);
  if (renameType === "OBJECT_COLUMN") {
    return await applyColumnRename(statement, node, objects, context, file);
  }
  if (renameType === "OBJECT_TABLE" || renameType === "OBJECT_FOREIGN_TABLE") {
    return await applyTableRename(statement, node, objects, renameType, context, file);
  }
  if (renameType === "OBJECT_INDEX") {
    return await applyIndexRename(statement, node, objects, context, file);
  }
  return unsupportedStatement(
    statement,
    file,
    `unsupported rename type ${renameType ?? "unknown"} cannot be replayed without corrupting shape`
  );
}

async function applyColumnRename(
  statement: AstStatement,
  node: AstNode,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string
): Promise<ReplayResult> {
  const tableName = rangeVarName(node.relation);
  const oldName = stringNode(node.subname);
  const newName = stringNode(node.newname);
  if (!(tableName && oldName && newName)) {
    return unsupportedStatement(statement, file, "column rename target could not be resolved");
  }
  const table = tableLikeObject(objects, tableName);
  if (!table) {
    return emptyResult();
  }
  const shape = tableShape(table);
  const shapeColumns = tableShapeColumns(shape);
  const columnIndex = shapeColumns?.findIndex((column) => column.name === oldName) ?? -1;
  if (!(shape && shapeColumns && columnIndex >= 0)) {
    return orderGap(
      `RENAME COLUMN targets absent column ${table.key}.${oldName}`,
      file,
      statement.text,
      table.ref
    );
  }
  if (shapeColumns.some((column) => column.name === newName)) {
    return orderGap(
      `RENAME COLUMN would duplicate ${table.key}.${newName}`,
      file,
      statement.text,
      table.ref
    );
  }
  const nextShapeColumns = [...shapeColumns];
  const current = nextShapeColumns[columnIndex];
  if (!current) {
    return unsupportedStatement(statement, file, `column ${oldName} could not be resolved`);
  }
  nextShapeColumns[columnIndex] = { ...current, name: newName };
  updateTableShape(table, { ...shape, columns: nextShapeColumns }, statement.text);
  table.metadata.columns = tableMetadataColumns(table).map((column) =>
    column.name === oldName ? { ...column, name: newName } : column
  );
  updateColumnScopedMetadata(objects, tableName, oldName, newName);
  await rebindCommentTargets(objects, context, (target) =>
    target.kind === "column" &&
    target.schema === tableName.schema &&
    target.table === tableName.name &&
    target.name === oldName
      ? { ...target, name: newName }
      : undefined
  );
  return await rebindTableScopedColumnSql(
    objects,
    tableName,
    oldName,
    newName,
    file,
    statement.text
  );
}

async function applyTableRename(
  statement: AstStatement,
  node: AstNode,
  objects: Map<string, SchemaObject>,
  renameType: string,
  context: ReplayContext,
  file: string
): Promise<ReplayResult> {
  const oldTable = rangeVarName(node.relation);
  const newName = stringNode(node.newname);
  if (!(oldTable && newName)) {
    return unsupportedStatement(statement, file, "table rename target could not be resolved");
  }
  const kind = renameType === "OBJECT_FOREIGN_TABLE" ? "foreign-table" : "table";
  const oldKey = objectKey({ kind, ...oldTable });
  const target = objects.get(oldKey);
  if (!target) {
    return emptyResult();
  }
  const nextRef = { ...target.ref, name: newName };
  const nextKey = objectKey(nextRef);
  if (objects.has(nextKey)) {
    return orderGap(`RENAME TABLE would duplicate ${nextKey}`, file, statement.text, nextRef);
  }
  objects.delete(oldKey);
  objects.set(nextKey, renamedObject(target, nextRef, statement.text));
  const rekeyed = rekeyTableScopedObjects(objects, oldTable, newName, file, statement.text);
  if (rekeyed.hardFail) {
    return rekeyed;
  }
  await rebindCommentTargets(objects, context, (target) => {
    if (
      target.kind === "table" &&
      target.schema === oldTable.schema &&
      target.name === oldTable.name
    ) {
      return { ...target, name: newName };
    }
    if (target.table === oldTable.name && (target.schema ?? "public") === oldTable.schema) {
      return { ...target, table: newName };
    }
  });
  return await rebindTableReferences(objects, oldTable, newName, file, statement.text);
}

function applyDrop(
  statement: AstStatement,
  node: AstNode,
  objects: Map<string, SchemaObject>,
  file: string
): ReplayResult {
  const removeType = readString(node.removeType);
  const targets = dropTargets(removeType, node);
  if (targets.length === 0) {
    return unsupportedStatement(
      statement,
      file,
      `unsupported DROP ${removeType ?? "unknown"} during migration replay`
    );
  }
  const diagnostics: Diagnostic[] = [];
  const missingOk = readBoolean(node.missing_ok) === true;
  const cascade = readString(node.behavior) === "DROP_CASCADE";
  for (const target of targets) {
    if (!removeDropTarget(objects, target, cascade)) {
      if (missingOk) {
        continue;
      }
      diagnostics.push(
        replayDiagnostic(
          "SUPA_REPLAY_ORDER_GAP",
          "error",
          `DROP targets absent object ${target.display}`,
          { file, statement: statement.text }
        )
      );
    }
  }
  return {
    diagnostics,
    hardFail: hasErrors(diagnostics),
    nextOrdinal: undefined,
  };
}

async function applyNormalizedAmendment(
  marker: SchemaObject,
  objects: Map<string, SchemaObject>,
  context: ReplayContext
): Promise<ReplayResult> {
  const target = objects.get(marker.key);
  if (!target) {
    return orderGap(
      `ALTER amendment targets absent object ${marker.key}`,
      marker.file,
      marker.sql,
      marker.ref
    );
  }
  const diagnostics: Diagnostic[] = [];
  const normalized = await normalizeSourceObjects([target, marker], diagnostics, {
    normalize: context.normalize,
  });
  const nextTarget = normalized.find((object) => object.key === marker.key);
  if (hasErrors(diagnostics) || !nextTarget) {
    return {
      diagnostics:
        diagnostics.length > 0
          ? diagnostics
          : [
              replayDiagnostic(
                "SUPA_REPLAY_UNSUPPORTED",
                "error",
                `ALTER amendment could not be applied to ${marker.key}`,
                { file: marker.file, ref: marker.ref, statement: marker.sql }
              ),
            ],
      hardFail: true,
      nextOrdinal: undefined,
    };
  }
  objects.set(marker.key, nextTarget);
  return emptyResult();
}

function isNormalizedAmendmentMarker(object: SchemaObject): boolean {
  return Object.keys(object.metadata).some((key) => normalizedAmendmentKeys.has(key));
}

function tableLikeObject(
  objects: Map<string, SchemaObject>,
  name: QualifiedName
): SchemaObject | undefined {
  return (
    objects.get(objectKey({ kind: "table", ...name })) ??
    objects.get(objectKey({ kind: "foreign-table", ...name }))
  );
}

function tableShape(table: SchemaObject): Record<string, unknown> | undefined {
  return asRecord(table.metadata.canonicalShape);
}

function tableShapeColumns(shape: Record<string, unknown> | undefined): ColumnShape[] | undefined {
  const columns = readArray(shape?.columns);
  const output: ColumnShape[] = [];
  for (const raw of columns) {
    const column = asRecord(raw);
    if (
      !column ||
      typeof column.name !== "string" ||
      typeof column.type !== "string" ||
      typeof column.notNull !== "boolean"
    ) {
      return;
    }
    output.push({
      ...column,
      name: column.name,
      notNull: column.notNull,
      type: column.type,
    });
  }
  return output;
}

function tableMetadataColumns(table: SchemaObject): TableColumn[] {
  const columns = table.metadata.columns;
  if (!Array.isArray(columns)) {
    return [];
  }
  return columns.flatMap((column) => (isTableColumn(column) ? [{ ...column }] : []));
}

function isTableColumn(value: unknown): value is TableColumn {
  const column = asRecord(value);
  return (
    column !== undefined && typeof column.definition === "string" && typeof column.name === "string"
  );
}

function canonicalColumnFromColumnDef(columnDef: AstNode): ColumnShape | undefined {
  const name = readString(columnDef.colname);
  if (!name) {
    return;
  }
  const column: ColumnShape = {
    name,
    notNull: false,
    type: canonicalColumnType(columnDef.typeName),
  };
  for (const item of readArray(columnDef.constraints)) {
    const constraint = asRecord(asRecord(item)?.Constraint);
    const contype = readString(constraint?.contype);
    if (!(constraint && contype)) {
      continue;
    }
    if (contype === "CONSTR_NOTNULL") {
      column.notNull = true;
      continue;
    }
    if (contype === "CONSTR_DEFAULT") {
      column.default = canonicalizeRegclassLiterals(stripLocations(constraint.raw_expr));
      continue;
    }
    if (contype === "CONSTR_IDENTITY") {
      column.identity = readString(constraint.generated_when) ?? "a";
      continue;
    }
    if (contype === "CONSTR_GENERATED") {
      column.generated = stripLocations(constraint.raw_expr);
    }
  }
  return column;
}

function metadataColumnFromFacts(facts: ColumnFacts, columnDef: AstNode): TableColumn {
  const column: TableColumn = {
    definition: facts.type,
    hasDefault: facts.hasDefault,
    hasInlineConstraint: facts.hasInlineConstraint,
    name: facts.name,
    notNull: facts.notNull,
    type: facts.type,
  };
  if (facts.generated !== undefined) {
    column.generated = facts.generated;
  }
  if (facts.identity !== undefined) {
    column.identity = facts.identity;
  }
  for (const item of readArray(columnDef.constraints)) {
    const constraint = asRecord(asRecord(item)?.Constraint);
    const contype = readString(constraint?.contype);
    if (contype === "CONSTR_DEFAULT") {
      const sql = expressionSql(constraint?.raw_expr);
      if (sql !== undefined) {
        column.defaultExpression = sql;
      }
    }
    if (contype === "CONSTR_GENERATED") {
      const sql = expressionSql(constraint?.raw_expr);
      if (sql !== undefined) {
        column.generatedExpression = sql;
      }
    }
  }
  return column;
}

function unsupportedColumnConstraints(columnDef: AstNode): string[] {
  return readArray(columnDef.constraints).flatMap((item) => {
    const constraint = asRecord(asRecord(item)?.Constraint);
    const contype = readString(constraint?.contype);
    return contype !== undefined && !supportedColumnConstraintTypes.has(contype) ? [contype] : [];
  });
}

function updateTableShape(
  table: SchemaObject,
  nextShape: Record<string, unknown>,
  statement: string
): void {
  table.metadata = { ...table.metadata, canonicalShape: nextShape };
  table.hash = shapeHash(nextShape, table.key, table.ref);
  table.sql = `${table.sql};\n${statement}`;
}

async function rebindCommentTargets(
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  rebind: (target: CommentTarget) => CommentTarget | undefined
): Promise<void> {
  for (const [key, object] of [...objects.entries()]) {
    if (object.ref.kind !== "comment") {
      continue;
    }
    const target = commentTarget(object);
    if (target === undefined) {
      continue;
    }
    const next = rebind(target);
    if (next === undefined) {
      continue;
    }
    objects.delete(key);
    const description = object.metadata.description;
    const rebound = buildCommentObject({
      description: typeof description === "string" || description === null ? description : null,
      ordinal: object.ordinal,
      sql: commentStatementSql(
        next,
        typeof description === "string" || description === null ? description : null
      ),
      target: next,
      ...(object.file === undefined ? {} : { file: object.file }),
    });
    await finalizeObjects([rebound], { normalize: context.normalize });
    objects.set(rebound.key, rebound);
  }
}

function updateColumnScopedMetadata(
  objects: Map<string, SchemaObject>,
  table: QualifiedName,
  oldName: string,
  newName: string
): void {
  for (const object of objects.values()) {
    if (object.ref.schema !== table.schema || object.ref.table !== table.name) {
      continue;
    }
    object.metadata = renameColumnMetadata(object.metadata, oldName, newName);
  }
}

function renameColumnMetadata(
  metadata: Record<string, unknown>,
  oldName: string,
  newName: string
): Record<string, unknown> {
  const next = { ...metadata };
  for (const key of ["constraintColumns", "columnDependencies", "routineColumnDependencies"]) {
    if (Array.isArray(next[key])) {
      next[key] = next[key].map((value) => renameColumnReference(value, oldName, newName));
    }
  }
  return next;
}

function renameColumnReference(value: unknown, oldName: string, newName: string): unknown {
  if (value === oldName) {
    return newName;
  }
  if (typeof value === "string" && value.endsWith(`.${oldName}`)) {
    return `${value.slice(0, -oldName.length)}${newName}`;
  }
  return value;
}

function removeColumnDependents(
  objects: Map<string, SchemaObject>,
  table: SchemaObject,
  columnName: string
): void {
  for (const [key, object] of objects) {
    if (object.ref.schema !== table.ref.schema || object.ref.table !== table.ref.name) {
      continue;
    }
    const target = commentTarget(object);
    if (
      target?.kind === "column" &&
      target.table === table.ref.name &&
      target.name === columnName
    ) {
      objects.delete(key);
      continue;
    }
    if (metadataReferencesColumn(object.metadata, table.ref, columnName)) {
      objects.delete(key);
    }
  }
}

function metadataReferencesColumn(
  metadata: Record<string, unknown>,
  table: ObjectRef,
  columnName: string
): boolean {
  for (const key of ["constraintColumns", "columnDependencies", "routineColumnDependencies"]) {
    const values = metadataStringArray(metadata[key]);
    if (values.some((value) => columnReferenceMatches(value, table, columnName))) {
      return true;
    }
  }
  return false;
}

function metadataStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function columnReferenceMatches(value: string, table: ObjectRef, columnName: string): boolean {
  if (value === columnName) {
    return true;
  }
  const parts = value.split(".");
  if (parts.at(-1) !== columnName) {
    return false;
  }
  if (parts.length < 3) {
    return true;
  }
  return parts.at(-2) === table.name && parts.at(-3) === (table.schema ?? "public");
}

function renamedObject(object: SchemaObject, ref: ObjectRef, statement: string): SchemaObject {
  const next: SchemaObject = {
    ...object,
    dependencies: [...object.dependencies],
    key: objectKey(ref),
    metadata: structuredClone(object.metadata),
    ref,
    sql: `${object.sql};\n${statement}`,
  };
  const shape = tableShape(next);
  if ((ref.kind === "table" || ref.kind === "foreign-table") && shape) {
    const relation = asRecord(shape.relation);
    const nextShape = {
      ...shape,
      relation: relation ? { ...relation, name: ref.name } : shape.relation,
    };
    next.metadata = { ...next.metadata, canonicalShape: nextShape };
    next.hash = shapeHash(nextShape, next.key, next.ref);
    return next;
  }
  next.hash = makeObject(ref, next.sql, next.ordinal, next.file, next.metadata).hash;
  return next;
}

function rekeyTableScopedObjects(
  objects: Map<string, SchemaObject>,
  oldTable: QualifiedName,
  newName: string,
  file: string,
  statement: string
): ReplayResult {
  for (const [key, object] of [...objects]) {
    if (object.ref.schema !== oldTable.schema || object.ref.table !== oldTable.name) {
      continue;
    }
    const ref = { ...object.ref, table: newName };
    const nextKey = objectKey(ref);
    if (objects.has(nextKey)) {
      return orderGap(`RENAME TABLE would duplicate ${nextKey}`, file, statement, ref);
    }
    objects.delete(key);
    objects.set(nextKey, renamedObject(object, ref, statement));
  }
  return emptyResult();
}

async function rebindTableScopedColumnSql(
  objects: Map<string, SchemaObject>,
  table: QualifiedName,
  oldName: string,
  newName: string,
  file: string,
  statement: string
): Promise<ReplayResult> {
  for (const object of objects.values()) {
    if (object.ref.schema !== table.schema || object.ref.table !== table.name) {
      continue;
    }
    const rewritten = await rewriteObjectSql(object, file, statement, (ast) =>
      renameColumnReferencesInTableScopedSql(ast, table, oldName, newName)
    );
    if (rewritten.hardFail) {
      return rewritten;
    }
  }
  return emptyResult();
}

async function rebindTableReferences(
  objects: Map<string, SchemaObject>,
  oldTable: QualifiedName,
  newName: string,
  file: string,
  statement: string
): Promise<ReplayResult> {
  const oldIdentity = qualifiedObjectName(oldTable);
  const nextTable = { ...oldTable, name: newName };
  const newIdentity = qualifiedObjectName(nextTable);
  for (const object of objects.values()) {
    const dependsOnOldTable = object.dependencies.includes(oldIdentity);
    object.dependencies = object.dependencies.map((dependency) =>
      dependency === oldIdentity ? newIdentity : dependency
    );
    object.metadata = renameTableColumnDependencyMetadata(
      object.metadata,
      oldIdentity,
      newIdentity
    );
    if (!shouldRewriteTableReferenceSql(object, newName, dependsOnOldTable)) {
      continue;
    }
    const rewritten = await rewriteObjectSql(object, file, statement, (ast) =>
      renameRangeVarReferences(ast, oldTable, newName)
    );
    if (rewritten.hardFail) {
      return rewritten;
    }
  }
  return emptyResult();
}

function renameTableColumnDependencyMetadata(
  metadata: Record<string, unknown>,
  oldIdentity: string,
  newIdentity: string
): Record<string, unknown> {
  const next = { ...metadata };
  for (const key of ["columnDependencies", "routineColumnDependencies"]) {
    if (Array.isArray(next[key])) {
      next[key] = next[key].map((value) =>
        typeof value === "string" && value.startsWith(`${oldIdentity}.`)
          ? `${newIdentity}.${value.slice(oldIdentity.length + 1)}`
          : value
      );
    }
  }
  return next;
}

function shouldRewriteTableReferenceSql(
  object: SchemaObject,
  newTableName: string,
  dependsOnOldTable: boolean
): boolean {
  if (object.ref.kind === "table" || object.ref.kind === "foreign-table") {
    return false;
  }
  if (object.ref.kind === "comment") {
    return true;
  }
  if (object.ref.table === newTableName) {
    return true;
  }
  return dependsOnOldTable;
}

async function rewriteObjectSql(
  object: SchemaObject,
  file: string,
  statement: string,
  rewrite: (ast: unknown) => boolean
): Promise<ReplayResult> {
  const parsed = await parseSqlAst(object.sql, object.file);
  if (parsed.ast === undefined || hasErrors(parsed.diagnostics)) {
    return unsupportedStatement(
      { byteStart: 0, node: {}, tag: "ReplaySqlRewrite", text: statement },
      file,
      `could not parse ${object.key} while rebinding migration replay SQL`
    );
  }
  const ast = structuredClone(parsed.ast);
  if (!rewrite(ast)) {
    return emptyResult();
  }
  try {
    replaceObjectSql(object, deparseSync(JSON.parse(JSON.stringify(ast))));
    return emptyResult();
  } catch {
    return unsupportedStatement(
      { byteStart: 0, node: {}, tag: "ReplaySqlRewrite", text: statement },
      file,
      `could not deparse ${object.key} while rebinding migration replay SQL`
    );
  }
}

function replaceObjectSql(object: SchemaObject, sql: string): void {
  const next = makeObject(object.ref, sql, object.ordinal, object.file, object.metadata);
  object.hash = next.hash;
  object.normalizedSql = next.normalizedSql;
  object.sql = next.sql;
}

function renameColumnReferencesInTableScopedSql(
  ast: unknown,
  table: QualifiedName,
  oldName: string,
  newName: string
): boolean {
  let changed = false;
  visitMutableAst(ast, (node) => {
    changed ||= renameAlterTableColumnReferences(node, table, oldName, newName);
    changed ||= renameIndexColumnReferences(node, table, oldName, newName);
    changed ||= renamePolicyColumnReferences(node, table, oldName, newName);
    changed ||= renameCommentColumnReferences(node, table, oldName, newName);
  });
  return changed;
}

function commentStatement(node: MutableRecord): MutableRecord | undefined {
  return mutableRecord(mutableGet(node, "CommentStmt"));
}

function commentNameItems(comment: MutableRecord): MutableRecord[] {
  const object = mutableRecord(mutableGet(comment, "object"));
  const list = mutableRecord(mutableGet(object, "List")) ?? object;
  return readArray(mutableGet(list, "items"))
    .map((item) => mutableRecord(mutableGet(mutableRecord(item), "String")))
    .filter((item): item is MutableRecord => item !== undefined);
}

function renameCommentColumnReferences(
  node: MutableRecord,
  table: QualifiedName,
  oldName: string,
  newName: string
): boolean {
  const comment = commentStatement(node);
  if (!comment || mutableGet(comment, "objtype") !== "OBJECT_COLUMN") {
    return false;
  }
  const items = commentNameItems(comment);
  const column = items.at(-1);
  const owner = items.at(-2);
  const schema = items.at(-3);
  if (
    !(column && owner) ||
    mutableGet(owner, "sval") !== table.name ||
    (schema !== undefined && mutableGet(schema, "sval") !== table.schema) ||
    mutableGet(column, "sval") !== oldName
  ) {
    return false;
  }
  mutableSet(column, "sval", newName);
  return true;
}

function renameAlterTableColumnReferences(
  node: MutableRecord,
  table: QualifiedName,
  oldName: string,
  newName: string
): boolean {
  const alter = mutableRecord(mutableGet(node, "AlterTableStmt"));
  if (!(alter && rangeVarMatches(mutableGet(alter, "relation"), table))) {
    return false;
  }
  let changed = false;
  for (const rawCommand of readArray(mutableGet(alter, "cmds"))) {
    const command = mutableRecord(mutableGet(mutableRecord(rawCommand), "AlterTableCmd"));
    const constraint = mutableRecord(
      mutableGet(mutableRecord(mutableGet(command, "def")), "Constraint")
    );
    if (!constraint) {
      continue;
    }
    changed ||= renameStringList(mutableGet(constraint, "keys"), oldName, newName);
    changed ||= renameStringList(mutableGet(constraint, "fk_attrs"), oldName, newName);
    changed ||= renameColumnRefNodes(mutableGet(constraint, "raw_expr"), oldName, newName);
  }
  return changed;
}

function renameIndexColumnReferences(
  node: MutableRecord,
  table: QualifiedName,
  oldName: string,
  newName: string
): boolean {
  const index = mutableRecord(mutableGet(node, "IndexStmt"));
  if (!(index && rangeVarMatches(mutableGet(index, "relation"), table))) {
    return false;
  }
  let changed = false;
  for (const item of [
    ...readArray(mutableGet(index, "indexParams")),
    ...readArray(mutableGet(index, "indexIncludingParams")),
  ]) {
    const element = mutableRecord(mutableGet(mutableRecord(item), "IndexElem"));
    if (element && mutableGet(element, "name") === oldName) {
      mutableSet(element, "name", newName);
      changed = true;
    }
    changed ||= renameColumnRefNodes(mutableGet(element, "expr"), oldName, newName);
  }
  changed ||= renameColumnRefNodes(mutableGet(index, "whereClause"), oldName, newName);
  return changed;
}

function renamePolicyColumnReferences(
  node: MutableRecord,
  table: QualifiedName,
  oldName: string,
  newName: string
): boolean {
  const policy = mutableRecord(mutableGet(node, "CreatePolicyStmt"));
  if (!(policy && rangeVarMatches(mutableGet(policy, "table"), table))) {
    return false;
  }
  return (
    renameColumnRefNodes(mutableGet(policy, "qual"), oldName, newName) ||
    renameColumnRefNodes(mutableGet(policy, "with_check"), oldName, newName)
  );
}

function renameRangeVarReferences(ast: unknown, oldTable: QualifiedName, newName: string): boolean {
  let changed = false;
  visitMutableAst(ast, (node) => {
    const rangeVar = mutableRecord(mutableGet(node, "RangeVar"));
    if (rangeVar && mutableRangeVarMatches(rangeVar, oldTable)) {
      mutableSet(rangeVar, "relname", newName);
      changed = true;
    }
    if (mutableRangeVarMatches(node, oldTable)) {
      mutableSet(node, "relname", newName);
      changed = true;
    }
    changed ||= renameCommentTableReferences(node, oldTable, newName);
  });
  return changed;
}

function renameCommentTableReferences(
  node: MutableRecord,
  oldTable: QualifiedName,
  newName: string
): boolean {
  const comment = commentStatement(node);
  if (!comment) {
    return false;
  }
  const objtype = mutableGet(comment, "objtype");
  if (objtype === "OBJECT_TABLE" || objtype === "OBJECT_FOREIGN_TABLE") {
    const items = commentNameItems(comment);
    const owner = items.at(-1);
    const schema = items.at(-2);
    if (
      !owner ||
      mutableGet(owner, "sval") !== oldTable.name ||
      (schema !== undefined && mutableGet(schema, "sval") !== oldTable.schema)
    ) {
      return false;
    }
    mutableSet(owner, "sval", newName);
    return true;
  }
  if (objtype !== "OBJECT_COLUMN") {
    return false;
  }
  const items = commentNameItems(comment);
  const owner = items.at(-2);
  const schema = items.at(-3);
  if (
    !owner ||
    mutableGet(owner, "sval") !== oldTable.name ||
    (schema !== undefined && mutableGet(schema, "sval") !== oldTable.schema)
  ) {
    return false;
  }
  mutableSet(owner, "sval", newName);
  return true;
}

function visitMutableAst(value: unknown, visit: (node: MutableRecord) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitMutableAst(item, visit);
    }
    return;
  }
  const node = mutableRecord(value);
  if (!node) {
    return;
  }
  visit(node);
  for (const child of Object.values(node)) {
    if (child && typeof child === "object") {
      visitMutableAst(child, visit);
    }
  }
}

function renameColumnRefNodes(value: unknown, oldName: string, newName: string): boolean {
  let changed = false;
  visitMutableAst(value, (node) => {
    const columnRef = mutableRecord(mutableGet(node, "ColumnRef"));
    const fields = readArray(mutableGet(columnRef, "fields"));
    const last = mutableRecord(fields.at(-1));
    const string = mutableRecord(mutableGet(last, "String"));
    if (string && mutableGet(string, "sval") === oldName) {
      mutableSet(string, "sval", newName);
      changed = true;
    }
  });
  return changed;
}

function renameStringList(value: unknown, oldName: string, newName: string): boolean {
  let changed = false;
  for (const item of readArray(value)) {
    const string = mutableRecord(mutableGet(mutableRecord(item), "String"));
    if (string && mutableGet(string, "sval") === oldName) {
      mutableSet(string, "sval", newName);
      changed = true;
    }
  }
  return changed;
}

function rangeVarMatches(value: unknown, table: QualifiedName): boolean {
  const record = mutableRecord(value);
  const rangeVar = mutableRecord(mutableGet(record, "RangeVar")) ?? record;
  return rangeVar ? mutableRangeVarMatches(rangeVar, table) : false;
}

function mutableRangeVarMatches(value: MutableRecord, table: QualifiedName): boolean {
  return (
    mutableGet(value, "relname") === table.name &&
    (typeof mutableGet(value, "schemaname") === "string"
      ? mutableGet(value, "schemaname")
      : "public") === table.schema
  );
}

function mutableRecord(value: unknown): MutableRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function mutableGet(value: MutableRecord | undefined, key: string): unknown {
  return value === undefined ? undefined : Reflect.get(value, key);
}

function mutableSet(value: MutableRecord, key: string, next: unknown): void {
  Reflect.set(value, key, next);
}

async function applyIndexRename(
  statement: AstStatement,
  node: AstNode,
  objects: Map<string, SchemaObject>,
  context: ReplayContext,
  file: string
): Promise<ReplayResult> {
  const oldName = rangeVarName(node.relation);
  const newName = stringNode(node.newname);
  if (!(oldName && newName)) {
    return unsupportedStatement(statement, file, "index rename target could not be resolved");
  }
  const ref: ObjectRef =
    oldName.schema === undefined
      ? { kind: "index", name: oldName.name }
      : { kind: "index", name: oldName.name, schema: oldName.schema };
  const target = [...objects].find(([, object]) => matchesDropRef(object.ref, ref));
  if (!target) {
    if (readBoolean(node.missing_ok) === true) {
      return emptyResult();
    }
    return orderGap(
      `RENAME INDEX targets absent object ${qualifiedObjectName(oldName)}`,
      file,
      statement.text,
      ref
    );
  }
  const nextRef: ObjectRef = { ...target[1].ref, name: newName };
  if (
    [...objects.values()].some(
      (object) => object !== target[1] && matchesDropRef(object.ref, nextRef)
    )
  ) {
    return orderGap(
      `RENAME INDEX would duplicate ${objectKey(nextRef)}`,
      file,
      statement.text,
      nextRef
    );
  }
  const parsed = await parseSqlAst(target[1].sql, target[1].file);
  if (parsed.ast === undefined || hasErrors(parsed.diagnostics)) {
    return unsupportedStatement(
      statement,
      file,
      `could not parse ${target[1].key} while renaming migration replay state`
    );
  }
  const ast = structuredClone(parsed.ast);
  let changed = false;
  visitMutableAst(ast, (astNode) => {
    const index = mutableRecord(mutableGet(astNode, "IndexStmt"));
    if (index && mutableGet(index, "idxname") === oldName.name) {
      mutableSet(index, "idxname", newName);
      changed = true;
    }
  });
  if (!changed) {
    return unsupportedStatement(
      statement,
      file,
      `${target[1].key} has no rewritable index definition`
    );
  }
  let sql: string;
  try {
    sql = deparseSync(JSON.parse(JSON.stringify(ast)));
  } catch {
    return unsupportedStatement(
      statement,
      file,
      `could not deparse ${target[1].key} while renaming migration replay state`
    );
  }
  const next = makeObject(
    nextRef,
    sql,
    target[1].ordinal,
    target[1].file,
    structuredClone(target[1].metadata)
  );
  const diagnostics = await finalizeObjects([next], {
    normalize: context.normalize,
  });
  if (hasErrors(diagnostics)) {
    return { diagnostics, hardFail: true, nextOrdinal: undefined };
  }
  objects.delete(target[0]);
  objects.set(objectKey(nextRef), next);
  return { diagnostics, hardFail: false, nextOrdinal: undefined };
}

function dropTargets(removeType: string | undefined, node: AstNode): DropTarget[] {
  if (removeType === "OBJECT_TABLE") {
    return nameDropTargets(node, "table");
  }
  if (removeType === "OBJECT_FDW") {
    return nameDropTargets(node, "foreign-data-wrapper");
  }
  if (removeType === "OBJECT_FOREIGN_TABLE") {
    return nameDropTargets(node, "foreign-table");
  }
  if (removeType === "OBJECT_INDEX") {
    return nameDropTargets(node, "index");
  }
  if (removeType === "OBJECT_SEQUENCE") {
    return nameDropTargets(node, "sequence");
  }
  if (removeType === "OBJECT_SCHEMA") {
    return nameDropTargets(node, "schema");
  }
  if (removeType === "OBJECT_EXTENSION") {
    return nameDropTargets(node, "extension");
  }
  if (removeType === "OBJECT_POLICY") {
    return tableScopedDropTargets(node, "policy");
  }
  if (removeType === "OBJECT_TRIGGER") {
    return tableScopedDropTargets(node, "trigger");
  }
  if (removeType === "OBJECT_TYPE") {
    return readArray(node.objects).flatMap((object) => {
      const typeName = asRecord(asRecord(object)?.TypeName);
      const name = qualifiedName(typeName?.names) ?? qualifiedName(object);
      return name
        ? [
            {
              display: qualifiedObjectName(name),
              refs: [
                { kind: "enum", ...name },
                { kind: "type", ...name },
                { kind: "domain", ...name },
              ],
            },
          ]
        : [];
    });
  }
  if (removeType === "OBJECT_VIEW") {
    return nameDropTargets(node, "view");
  }
  if (removeType === "OBJECT_MATVIEW") {
    return nameDropTargets(node, "materialized-view");
  }
  if (removeType === "OBJECT_FUNCTION" || removeType === "OBJECT_PROCEDURE") {
    const kind = removeType === "OBJECT_PROCEDURE" ? "procedure" : "function";
    return readArray(node.objects).flatMap((object) => {
      const identity = objectWithArgsIdentity(object);
      return identity
        ? [
            {
              display: `${qualifiedObjectName(identity)}(${identity.signature})`,
              refs: [{ kind, ...identity }],
            },
          ]
        : [];
    });
  }
  return [];
}

function nameDropTargets(node: AstNode, kind: ObjectKind): DropTarget[] {
  return readArray(node.objects).flatMap<DropTarget>((object) => {
    const direct = stringNode(object);
    if (direct && (kind === "schema" || kind === "extension" || kind === "foreign-data-wrapper")) {
      return [{ display: direct, refs: [{ kind, name: direct }] }];
    }
    const name = qualifiedName(object);
    return name
      ? [
          {
            display: qualifiedObjectName(name),
            refs: [{ kind, name: name.name, schema: name.schema }],
          },
        ]
      : [];
  });
}

function tableScopedDropTargets(node: AstNode, kind: "policy" | "trigger"): DropTarget[] {
  return readArray(node.objects).flatMap((object) => {
    const items = readArray(asRecord(asRecord(object)?.List)?.items).map(stringNode);
    const [schema, table, name] = items.length === 3 ? items : [undefined, items[0], items[1]];
    if (!(table && name)) {
      return [];
    }
    const ref: ObjectRef =
      schema === undefined ? { kind, name, table } : { kind, name, schema, table };
    return [
      {
        display: `${schema === undefined ? table : `${schema}.${table}`}.${name}`,
        refs: [ref],
      },
    ];
  });
}

function removeDropTarget(
  objects: Map<string, SchemaObject>,
  target: DropTarget,
  cascade: boolean
): boolean {
  for (const ref of target.refs) {
    const removed = removeObjectsForDropRef(objects, ref);
    if (removed.length === 0) {
      continue;
    }
    const owned = removeOwnedObjectsAfterDrop(objects, removed);
    removeCascadeDependents(objects, [...removed, ...owned], cascade);
    return true;
  }
  for (const ref of target.refs) {
    const removed = removeObjectsMatchingDropRef(objects, ref);
    if (removed.length > 0) {
      const owned = removeOwnedObjectsAfterDrop(objects, removed);
      removeCascadeDependents(objects, [...removed, ...owned], cascade);
      return true;
    }
  }
  return false;
}

function removeObjectsForDropRef(objects: Map<string, SchemaObject>, ref: ObjectRef): ObjectRef[] {
  const key = objectKey(ref);
  const object = objects.get(key);
  if (!object) {
    return [];
  }
  objects.delete(key);
  return [object.ref];
}

function removeObjectsMatchingDropRef(
  objects: Map<string, SchemaObject>,
  ref: ObjectRef
): ObjectRef[] {
  const removed: ObjectRef[] = [];
  for (const [key, object] of [...objects]) {
    if (matchesDropRef(object.ref, ref)) {
      objects.delete(key);
      removed.push(object.ref);
    }
  }
  return removed;
}

function matchesDropRef(candidate: ObjectRef, ref: ObjectRef): boolean {
  return (
    candidate.kind === ref.kind &&
    candidate.name === ref.name &&
    candidate.schema === ref.schema &&
    (ref.table === undefined || candidate.table === ref.table) &&
    (ref.signature === undefined || candidate.signature === ref.signature)
  );
}

function removeOwnedObjectsAfterDrop(
  objects: Map<string, SchemaObject>,
  refs: ObjectRef[]
): ObjectRef[] {
  const removed: ObjectRef[] = [];
  for (const ref of refs) {
    if (relationOwnerKinds.has(ref.kind)) {
      removed.push(...removeTableOwnedObjects(objects, ref));
    }
    if (ref.kind === "schema") {
      removed.push(...removeSchemaObjects(objects, ref.name));
    }
  }
  removed.push(...removeAttachedDependents(objects, [...refs, ...removed]));
  return removed;
}

function removeAttachedDependents(
  objects: Map<string, SchemaObject>,
  refs: ObjectRef[]
): ObjectRef[] {
  const targetIdentities = new Set<string>();
  for (const ref of refs) {
    const identity = grantTargetIdentity(ref);
    if (identity !== undefined) {
      targetIdentities.add(identity);
    }
  }
  const removed: ObjectRef[] = [];
  for (const [key, object] of [...objects]) {
    if (isGrantForTargets(object, targetIdentities) || isCommentForRefs(object, refs)) {
      objects.delete(key);
      removed.push(object.ref);
    }
  }
  return removed;
}

function removeTableOwnedObjects(objects: Map<string, SchemaObject>, ref: ObjectRef): ObjectRef[] {
  const removed: ObjectRef[] = [];
  for (const [key, object] of [...objects]) {
    if (
      (object.ref.schema === ref.schema && object.ref.table === ref.name) ||
      sequenceOwnedByTable(object, ref)
    ) {
      objects.delete(key);
      removed.push(object.ref);
    }
  }
  return removed;
}

function removeSchemaObjects(objects: Map<string, SchemaObject>, schema: string): ObjectRef[] {
  const removed: ObjectRef[] = [];
  for (const [key, object] of [...objects]) {
    if (object.ref.schema === schema) {
      objects.delete(key);
      removed.push(object.ref);
    }
  }
  return removed;
}

function removeCascadeDependents(
  objects: Map<string, SchemaObject>,
  initialRefs: ObjectRef[],
  cascade: boolean
): void {
  if (!cascade || initialRefs.length === 0) {
    return;
  }
  const removedIdentities = new Set(initialRefs.map(objectIdentity));
  let changed = true;
  while (changed) {
    changed = false;
    const removed: ObjectRef[] = [];
    for (const [key, object] of [...objects]) {
      if (object.dependencies.some((dependency) => removedIdentities.has(dependency))) {
        objects.delete(key);
        removed.push(object.ref);
        changed = true;
      }
    }
    if (removed.length === 0) {
      continue;
    }
    for (const ref of [...removed, ...removeOwnedObjectsAfterDrop(objects, removed)]) {
      removedIdentities.add(objectIdentity(ref));
    }
  }
}

function sequenceOwnedByTable(object: SchemaObject, table: ObjectRef): boolean {
  if (object.ref.kind !== "sequence") {
    return false;
  }
  const shape = asRecord(object.metadata.canonicalShape);
  const ownedBy = readString(shape?.ownedBy);
  if (ownedBy === undefined) {
    return false;
  }
  const parts = ownedBy.split(".");
  if (parts.length < 2) {
    return false;
  }
  const tableName = parts.at(-2);
  const schemaName = parts.length >= 3 ? parts.at(-3) : "public";
  return tableName === table.name && schemaName === (table.schema ?? "public");
}

function enumValues(object: SchemaObject): string[] {
  const values = object.metadata.values;
  return Array.isArray(values)
    ? values.filter((value): value is string => typeof value === "string")
    : [];
}

function stringNode(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const record = asRecord(value);
  const direct = readString(record?.sval);
  if (direct !== undefined) {
    return direct;
  }
  return readString(asRecord(record?.String)?.sval);
}

function replayExtractionDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.map((item) => {
    if (item.code === "SUPA_SUPABASE_MANAGED_SCHEMA") {
      return { ...item, severity: "warning" };
    }
    if (item.code !== "SUPA_EXTRACT_UNSUPPORTED") {
      return item;
    }
    return { ...item, code: "SUPA_REPLAY_UNSUPPORTED" };
  });
}

function unsupportedStatement(
  statement: AstStatement,
  file: string | undefined,
  message: string
): ReplayResult {
  return {
    diagnostics: [
      replayDiagnostic("SUPA_REPLAY_UNSUPPORTED", "error", message, {
        file,
        statement: statement.text,
      }),
    ],
    hardFail: true,
    nextOrdinal: undefined,
  };
}

function orderGap(
  message: string,
  file: string | undefined,
  statement: string,
  ref?: ObjectRef
): ReplayResult {
  return {
    diagnostics: [
      replayDiagnostic("SUPA_REPLAY_ORDER_GAP", "error", message, {
        file,
        ref,
        statement,
      }),
    ],
    hardFail: true,
    nextOrdinal: undefined,
  };
}

function qualifiedObjectName(name: QualifiedName): string {
  return `${name.schema}.${name.name}`;
}

function objectIdentity(ref: ObjectRef): string {
  if (ref.kind === "schema") {
    return ref.name;
  }
  return `${ref.schema ?? "public"}.${ref.name}`;
}

function emptyResult(): ReplayResult {
  return { diagnostics: [], hardFail: false, nextOrdinal: undefined };
}

function replayDiagnostic(
  code: string,
  severity: "error" | "warning",
  message: string,
  extras: Parameters<typeof diagnostic>[3] = {}
): Diagnostic {
  return diagnostic(code, severity, message, extras);
}
