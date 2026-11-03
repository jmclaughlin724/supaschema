import { resolveConfig } from "../config/schema.js";
import { diagnostic } from "../diagnostics/diagnostics.js";
import { sha256, stableJson } from "../hash.js";
import {
  grantTargetIdentity,
  isCommentForRefs,
  isGrantForTargets,
  refIdentity,
  tableRefIdentity,
} from "../sql/dependents.js";
import { rlsStateFromObjectMetadata } from "../sql/rls.js";
import type { RoutineDependencyConfidence } from "../sql/routine-dependencies.js";
import type {
  Diagnostic,
  MigrationCorpus,
  MigrationOperation,
  MigrationOperationKind,
  MigrationPlan,
  ObjectKind,
  ObjectRef,
  RenderOptions,
  SchemaModel,
  SchemaObject,
  SupaschemaConfig,
} from "../types.js";
import { sortOperations } from "./order.js";
import { destructiveAllowedDisposition, refineReplaceOperation } from "./replace.js";
import { makeTableAlterOperation } from "./table.js";

type AppliedRoutineExecuteGrantees = ReadonlyMap<string, ReadonlySet<string>>;

type DiffOptions = Pick<RenderOptions, "config"> & {
  appliedRoutineExecuteGrantees?: AppliedRoutineExecuteGrantees;
  migrationCorpus?: MigrationCorpus;
};

export function planSchemaDiff(
  from: SchemaModel,
  to: SchemaModel,
  options: DiffOptions = {}
): MigrationPlan {
  const config = resolveConfig(options.config);
  const operations: MigrationOperation[] = [];
  const diagnostics: Diagnostic[] = [...from.diagnostics, ...to.diagnostics];
  const fromMap = objectMap(from.objects);
  const toMap = objectMap(to.objects);
  const consumedFrom = new Set<string>();
  const consumedTo = new Set<string>();
  applyRenameHints(fromMap, toMap, consumedFrom, consumedTo, operations, diagnostics, config);
  const migrationCorpus = options.migrationCorpus;
  diagnostics.push(...(migrationCorpus?.diagnostics ?? []));
  appendChangedAndDroppedOperations(
    fromMap,
    toMap,
    consumedFrom,
    operations,
    config,
    migrationCorpus
  );
  appendCreatedOperations(fromMap, toMap, consumedTo, operations, config, migrationCorpus);
  appendRoutinePrivilegeRevokes(
    operations,
    to,
    config,
    migrationCorpus,
    options.appliedRoutineExecuteGrantees
  );
  appendReplacedObjectDependents(operations, from, to, config, migrationCorpus);
  appendChangedColumnBlockingDependents(operations, from, to, config, migrationCorpus);
  appendDependencyProofDiagnostics(operations, from, to);
  const sortedOperations = sortOperations(
    suppressReplacedRelationGrantDrops(operations),
    diagnostics
  );
  appendOperationDiagnostics(diagnostics, sortedOperations);
  if (sortedOperations.length === 0 && from.fingerprint !== to.fingerprint) {
    diagnostics.push(emptyPlanDriftDiagnostic(fromMap, toMap, from, to));
  }
  return {
    diagnostics,
    fingerprint: sha256(
      stableJson({
        from: from.fingerprint,
        operations: sortedOperations.map((operation) => ({
          key: operation.key,
          kind: operation.kind,
        })),
        to: to.fingerprint,
      })
    ),
    from: from.source,
    fromFingerprint: from.fingerprint,
    operations: sortedOperations,
    to: to.source,
    toFingerprint: to.fingerprint,
  };
}

function applyRenameHints(
  fromMap: Map<string, SchemaObject>,
  toMap: Map<string, SchemaObject>,
  consumedFrom: Set<string>,
  consumedTo: Set<string>,
  operations: MigrationOperation[],
  diagnostics: Diagnostic[],
  config: SupaschemaConfig
): void {
  if (config.renameDetection !== "hints-only") {
    return;
  }
  for (const hint of config.hints.renames ?? []) {
    const before = fromMap.get(hint.from);
    const after = toMap.get(hint.to);
    if (!(before && after)) {
      diagnostics.push(renameHintUnmatchedDiagnostic(hint.from, hint.to));
      continue;
    }
    operations.push(makeRenameOperation(before, after));
    consumedFrom.add(before.key);
    consumedTo.add(after.key);
  }
}

function renameHintUnmatchedDiagnostic(from: string, to: string): Diagnostic {
  return diagnostic(
    "SUPA_PLAN_RENAME_HINT_UNMATCHED",
    "error",
    "rename hint does not match both source and target objects",
    {
      hint: `from=${from} to=${to}`,
    }
  );
}

function appendChangedAndDroppedOperations(
  fromMap: Map<string, SchemaObject>,
  toMap: Map<string, SchemaObject>,
  consumedFrom: Set<string>,
  operations: MigrationOperation[],
  config: SupaschemaConfig,
  migrationCorpus: MigrationCorpus | undefined
): void {
  const droppedContext = droppedObjectContext(fromMap, toMap, consumedFrom);
  for (const [key, before] of fromMap) {
    if (consumedFrom.has(key)) {
      continue;
    }
    const after = toMap.get(key);
    if (!after) {
      if (isObjectDroppedWithOwner(before, droppedContext)) {
        continue;
      }
      operations.push(makeOperation("drop", key, before, undefined, config, migrationCorpus));
    } else if (before.hash !== after.hash && !sameRlsState(before, after)) {
      operations.push(makeChangedOperation(key, before, after, config, migrationCorpus));
    }
  }
}

function sameRlsState(before: SchemaObject, after: SchemaObject): boolean {
  if (before.ref.kind !== "rls" || after.ref.kind !== "rls") {
    return false;
  }
  const beforeState = rlsStateFromObjectMetadata(before.metadata);
  const afterState = rlsStateFromObjectMetadata(after.metadata);
  return (
    beforeState !== undefined &&
    afterState !== undefined &&
    beforeState.rlsEnabled === afterState.rlsEnabled &&
    beforeState.rlsForced === afterState.rlsForced
  );
}

function makeChangedOperation(
  key: string,
  before: SchemaObject,
  after: SchemaObject,
  config: SupaschemaConfig,
  migrationCorpus: MigrationCorpus | undefined
): MigrationOperation {
  return (
    makeEnumAddValuesOperation(before, after) ??
    makeTableAlterOperation(before, after, config, migrationCorpus) ??
    refineReplaceOperation(
      makeOperation("replace", key, before, after, config, migrationCorpus),
      config
    )
  );
}

function appendCreatedOperations(
  fromMap: Map<string, SchemaObject>,
  toMap: Map<string, SchemaObject>,
  consumedTo: Set<string>,
  operations: MigrationOperation[],
  config: SupaschemaConfig,
  migrationCorpus: MigrationCorpus | undefined
): void {
  for (const [key, after] of toMap) {
    if (!(consumedTo.has(key) || fromMap.has(key))) {
      operations.push(makeOperation("create", key, undefined, after, config, migrationCorpus));
    }
  }
}

function appendRoutinePrivilegeRevokes(
  operations: MigrationOperation[],
  to: SchemaModel,
  config: SupaschemaConfig,
  migrationCorpus: MigrationCorpus | undefined,
  appliedExecuteGrantees: AppliedRoutineExecuteGrantees | undefined
): void {
  const droppedRoutineIdentities = droppedRetainedRoutineIdentities(operations, to);
  if (droppedRoutineIdentities.size === 0 && !appliedExecuteGrantees) {
    return;
  }
  const existingGrantCreates = new Set(
    operations
      .filter((operation) => operation.kind === "create" && operation.ref.kind === "grant")
      .map((operation) => operation.key)
  );
  const candidates = new Map<string, SchemaObject>();
  for (const object of [
    ...to.objects,
    ...(appliedExecuteGrantees ? (to.declaredRoutineRevokes ?? []) : []),
  ]) {
    if (!candidates.has(object.key)) {
      candidates.set(object.key, object);
    }
  }
  for (const object of candidates.values()) {
    const targetIdentity = object.metadata.targetIdentity;
    const grantee = object.metadata.grantee;
    if (
      object.ref.kind !== "grant" ||
      object.metadata.verb !== "REVOKE" ||
      typeof targetIdentity !== "string" ||
      existingGrantCreates.has(object.key)
    ) {
      continue;
    }
    const appliedDrift =
      typeof grantee === "string" &&
      appliedExecuteGrantees?.get(targetIdentity)?.has(grantee) === true;
    if (!(appliedDrift || droppedRoutineIdentities.has(targetIdentity))) {
      continue;
    }
    const operation = makeOperation(
      "create",
      object.key,
      undefined,
      object,
      config,
      migrationCorpus
    );
    if (appliedDrift) {
      operation.diagnostics.push(
        diagnostic(
          "SUPA_ROUTINE_PRIVILEGE_DRIFT",
          "warning",
          `${grantee} still holds EXECUTE on ${targetIdentity} in the applied database, but the declarative schema revokes it`,
          {
            hint: "The plan re-applies the declared REVOKE. If the applied EXECUTE grant is intended, remove the REVOKE from the declarative schema instead of applying this migration.",
            ref: object.ref,
          }
        )
      );
    }
    operations.push(operation);
  }
}

function droppedRetainedRoutineIdentities(
  operations: readonly MigrationOperation[],
  to: SchemaModel
): Set<string> {
  const droppedIdentities = new Set(
    operations
      .filter((operation) => operation.kind === "drop" || operation.kind === "replace")
      .flatMap((operation) => routineGrantTargetIdentity(operation.ref))
  );
  if (droppedIdentities.size === 0) {
    return droppedIdentities;
  }
  return new Set(
    to.objects
      .flatMap((object) => routineGrantTargetIdentity(object.ref))
      .filter((identity) => droppedIdentities.has(identity))
  );
}

function routineGrantTargetIdentity(ref: ObjectRef): string[] {
  const identity = routineKinds.has(ref.kind) ? grantTargetIdentity(ref) : undefined;
  return identity === undefined ? [] : [identity];
}

interface DroppedObjectContext {
  affectedRefs: Map<string, ObjectRef>;
  grantTargetIdentities: Set<string>;
  relationIdentities: Set<string>;
}

function droppedObjectContext(
  fromMap: Map<string, SchemaObject>,
  toMap: Map<string, SchemaObject>,
  consumedFrom: Set<string>
): DroppedObjectContext {
  const context: DroppedObjectContext = {
    affectedRefs: new Map(),
    grantTargetIdentities: new Set(),
    relationIdentities: new Set(),
  };
  for (const [key, object] of fromMap) {
    if (consumedFrom.has(key) || toMap.has(key)) {
      continue;
    }
    rememberAffectedRef(context.affectedRefs, object.ref);
    const identity = grantTargetIdentity(object.ref);
    if (identity !== undefined) {
      context.grantTargetIdentities.add(identity);
    }
    if (isRelationOwner(object.ref)) {
      context.relationIdentities.add(refIdentity(object.ref));
    }
  }
  return context;
}

function isObjectDroppedWithOwner(object: SchemaObject, context: DroppedObjectContext): boolean {
  return (
    isGrantForTargets(object, context.grantTargetIdentities) ||
    isCommentForRefs(object, context.affectedRefs.values()) ||
    isRelationStateForDroppedOwner(object, context.relationIdentities)
  );
}

function isRelationOwner(ref: ObjectRef): boolean {
  return ref.kind === "table" || ref.kind === "foreign-table" || ref.kind === "materialized-view";
}

function isRelationStateForDroppedOwner(
  object: SchemaObject,
  relationIdentities: ReadonlySet<string>
): boolean {
  const tableIdentity = tableRefIdentity(object.ref);
  return (
    relationDependentKinds.has(object.ref.kind) &&
    tableIdentity !== undefined &&
    relationIdentities.has(tableIdentity)
  );
}

const grantOwnerReplaceKinds = new Set<ObjectKind>([
  "foreign-table",
  "materialized-view",
  "table",
  "view",
]);

function suppressReplacedRelationGrantDrops(
  operations: MigrationOperation[]
): MigrationOperation[] {
  const replacedIdentities = new Set<string>();
  for (const operation of operations) {
    if (
      operation.kind === "replace" &&
      operation.destructive &&
      grantOwnerReplaceKinds.has(operation.ref.kind)
    ) {
      replacedIdentities.add(refIdentity(operation.ref));
    }
  }
  if (replacedIdentities.size === 0) {
    return operations;
  }
  return operations.filter((operation) => {
    if (operation.kind !== "drop" || operation.ref.kind !== "grant") {
      return true;
    }
    const target = operation.before?.metadata.targetIdentity;
    return typeof target !== "string" || !replacedIdentities.has(target);
  });
}

function appendOperationDiagnostics(
  diagnostics: Diagnostic[],
  operations: MigrationOperation[]
): void {
  for (const operation of operations) {
    diagnostics.push(...operation.diagnostics);
  }
}
function objectMap(objects: SchemaObject[]): Map<string, SchemaObject> {
  return new Map(objects.map((object) => [object.key, object]));
}

const replacedDependencyKinds = new Set<ObjectKind>([
  "domain",
  "foreign-table",
  "materialized-view",
  "table",
  "type",
  "view",
]);
const relationDependentKinds = new Set<ObjectKind>([
  "constraint",
  "index",
  "rls",
  "policy",
  "trigger",
]);
const blockingObjectDependentKinds = new Set<ObjectKind>([
  "function",
  "index",
  "materialized-view",
  "procedure",
  "view",
]);
const blockingColumnDependentKinds = new Set<ObjectKind>(["index", "materialized-view", "view"]);
const targetOnlyReplayPreDropKinds = new Set<ObjectKind>([
  "function",
  "index",
  "procedure",
  "view",
]);
const routineKinds = new Set<ObjectKind>(["function", "procedure"]);
const proofDependentKinds = new Set<ObjectKind>([
  "function",
  "index",
  "procedure",
  "view",
  "materialized-view",
  "policy",
  "trigger",
]);
const relationOrTypeChangeKinds = new Set<ObjectKind>([
  "domain",
  "enum",
  "foreign-table",
  "materialized-view",
  "table",
  "type",
  "view",
]);

function appendDependencyProofDiagnostics(
  operations: MigrationOperation[],
  from: SchemaModel,
  to: SchemaModel
): void {
  const relationOrTypeOperations = operations.filter((operation) =>
    relationOrTypeChangeKinds.has(operation.ref.kind)
  );
  if (relationOrTypeOperations.length > 0) {
    blockUnprovenUnknownRoutines(relationOrTypeOperations, to.objects, operations);
  }
  appendColumnDependentRewriteDiagnostics(operations, from, to);
}

function blockUnprovenUnknownRoutines(
  relationOrTypeOperations: MigrationOperation[],
  objects: readonly SchemaObject[],
  operations: readonly MigrationOperation[]
): void {
  const operationByKey = new Map(operations.map((operation) => [operation.key, operation]));
  for (const object of objects) {
    if (!(routineKinds.has(object.ref.kind) && routineDependencyIsUnproven(object))) {
      continue;
    }
    if (operationByKey.has(object.key)) {
      continue;
    }
    for (const operation of relationOrTypeOperations) {
      if (!unprovenRoutineMayOverlapOperation(object, operation)) {
        continue;
      }
      blockOperation(
        operation,
        diagnostic(
          "SUPA_ROUTINE_DEPENDENCY_PROOF_REQUIRED",
          "error",
          "routine dependencies are not fully proven while this plan changes relations or types",
          {
            hint: `Rewrite ${object.key} so dependencies are statically extractable, include the routine rewrite in this plan, or split this relation/type change into a reviewed explicit migration.`,
            ref: object.ref,
          }
        )
      );
    }
  }
}

function unprovenRoutineMayOverlapOperation(
  object: SchemaObject,
  operation: MigrationOperation
): boolean {
  const identity = refIdentity(operation.ref);
  const references = metadataStrings(object.metadata.routineDependencies);
  if (references.includes(identity)) {
    return true;
  }
  const columnPrefix = `${identity}.`;
  return metadataStrings(object.metadata.routineColumnDependencies).some(
    (reference) => reference === identity || reference.startsWith(columnPrefix)
  );
}

function routineDependencyIsUnproven(object: SchemaObject): boolean {
  const confidence = routineDependencyConfidence(object.metadata.routineDependencyConfidence);
  return confidence === undefined ? false : routineConfidenceIsUnproven(confidence);
}

function routineDependencyConfidence(value: unknown): RoutineDependencyConfidence | undefined {
  switch (value) {
    case "sql-body":
    case "sql-string-parsed":
    case "plpgsql-dynamic-parsed":
    case "plpgsql-static":
    case "dynamic-sql-unknown":
    case "plpgsql-partial":
    case "sql-string-partial":
    case "unsupported-language":
      return value;
    default:
      return;
  }
}

function metadataStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function routineConfidenceIsUnproven(confidence: RoutineDependencyConfidence): boolean {
  switch (confidence) {
    case "sql-body":
    case "sql-string-parsed":
    case "plpgsql-dynamic-parsed":
    case "plpgsql-static":
      return false;
    case "dynamic-sql-unknown":
    case "plpgsql-partial":
    case "sql-string-partial":
    case "unsupported-language":
      return true;
    default:
      return assertNever(confidence);
  }
}

function appendColumnDependentRewriteDiagnostics(
  operations: MigrationOperation[],
  from: SchemaModel,
  to: SchemaModel
): void {
  const operationByKey = new Map(operations.map((operation) => [operation.key, operation]));
  const targetByKey = new Map(to.objects.map((object) => [object.key, object]));
  for (const tableOperation of operations) {
    if (!(tableOperation.kind === "alter" && tableOperation.ref.kind === "table")) {
      continue;
    }
    const changedColumns = destructiveChangedColumnIdentities(tableOperation);
    if (changedColumns.size === 0) {
      continue;
    }
    appendColumnDependentDiagnosticsForAlter(
      tableOperation,
      changedColumns,
      from,
      operationByKey,
      targetByKey
    );
  }
}

function appendColumnDependentDiagnosticsForAlter(
  tableOperation: MigrationOperation,
  changedColumns: Set<string>,
  from: SchemaModel,
  operationByKey: Map<string, MigrationOperation>,
  targetByKey: Map<string, SchemaObject>
): void {
  for (const before of from.objects) {
    if (!(proofDependentKinds.has(before.ref.kind) && dependsOnAnyColumn(before, changedColumns))) {
      continue;
    }
    const dependentOperation = operationByKey.get(before.key);
    const preDropOperation = operationByKey.get(preDropKey(before.key));
    const after = targetByKey.get(before.key);
    if (preDropOperation && blockingColumnDependentKinds.has(before.ref.kind)) {
      continue;
    }
    if (!dependentOperation || (after && dependsOnAnyColumn(after, changedColumns))) {
      blockOperation(
        tableOperation,
        diagnostic(
          "SUPA_PLAN_COLUMN_DEPENDENT_REWRITE_REQUIRED",
          "error",
          "a dependent object references a column being dropped or type-changed",
          {
            hint: `${before.key} must be dropped, replaced, or split into a reviewed explicit migration before altering ${tableOperation.key}.`,
            ref: before.ref,
          }
        )
      );
      continue;
    }
    dependentOperation.diagnostics.push(
      diagnostic(
        "SUPA_PLAN_DEPENDENT_ROUTINE_REORDERED",
        "warning",
        "dependent object replacement is ordered before the destructive column alter",
        {
          hint: `${dependentOperation.key} must stop referencing the changed column before ${tableOperation.key} is altered.`,
          ref: dependentOperation.ref,
        }
      )
    );
  }
}

function appendChangedColumnBlockingDependents(
  operations: MigrationOperation[],
  from: SchemaModel,
  to: SchemaModel,
  config: SupaschemaConfig,
  migrationCorpus?: MigrationCorpus
): void {
  const fromByKey = new Map(from.objects.map((object) => [object.key, object]));
  const context: ReplacedDependentContext = {
    affectedRefs: new Map(),
    dependencyIdentities: new Set(),
    fromKeys: new Set(from.objects.map((object) => object.key)),
    fromByKey,
    operationKeys: new Set(operations.map((operation) => operation.key)),
  };
  for (const tableOperation of operations) {
    if (!(tableOperation.kind === "alter" && tableOperation.ref.kind === "table")) {
      continue;
    }
    const changedColumns = destructiveAlteredColumnIdentities(tableOperation);
    if (changedColumns.size === 0) {
      continue;
    }
    expandChangedColumnBlockingDependents(
      to.objects,
      fromByKey,
      changedColumns,
      operations,
      context,
      config,
      migrationCorpus
    );
  }
  appendAffectedComments(to.objects, operations, context, config, migrationCorpus);
}

function expandChangedColumnBlockingDependents(
  objects: SchemaObject[],
  fromByKey: ReadonlyMap<string, SchemaObject>,
  changedColumns: ReadonlySet<string>,
  operations: MigrationOperation[],
  context: ReplacedDependentContext,
  config: SupaschemaConfig,
  migrationCorpus: MigrationCorpus | undefined
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of objects) {
      if (
        appendChangedColumnBlockingDependent(
          object,
          fromByKey,
          changedColumns,
          operations,
          context,
          config,
          migrationCorpus
        )
      ) {
        changed = true;
      }
    }
  }
}

function appendChangedColumnBlockingDependent(
  object: SchemaObject,
  fromByKey: ReadonlyMap<string, SchemaObject>,
  changedColumns: ReadonlySet<string>,
  operations: MigrationOperation[],
  context: ReplacedDependentContext,
  config: SupaschemaConfig,
  migrationCorpus: MigrationCorpus | undefined
): boolean {
  if (!blockingColumnDependentKinds.has(object.ref.kind)) {
    return false;
  }
  const before = fromByKey.get(object.key);
  const directlyAffected = before !== undefined && dependsOnAnyColumn(before, changedColumns);
  if (!(directlyAffected || isAffectedDependent(object, context.dependencyIdentities, fromByKey))) {
    return false;
  }
  let changed = false;
  rememberAffectedRef(context.affectedRefs, object.ref);
  if (appendBlockingDependentPreDrop(object, operations, context, config, migrationCorpus)) {
    changed = true;
  }
  if (!context.operationKeys.has(object.key)) {
    operations.push(
      makeOperation("create", object.key, undefined, object, config, migrationCorpus)
    );
    context.operationKeys.add(object.key);
    changed = true;
  }
  return changed;
}

function destructiveChangedColumnIdentities(operation: MigrationOperation): Set<string> {
  const table = refIdentity(operation.ref);
  const identities = new Set<string>();
  for (const column of stringMetadataArray(operation.metadata.dropColumns)) {
    identities.add(`${table}.${column}`);
  }
  for (const alteration of objectMetadataArray(operation.metadata.alterColumns)) {
    if (typeof alteration.name === "string" && typeof alteration.type === "string") {
      identities.add(`${table}.${alteration.name}`);
    }
  }
  return identities;
}

function destructiveAlteredColumnIdentities(operation: MigrationOperation): Set<string> {
  const table = refIdentity(operation.ref);
  const identities = new Set<string>();
  for (const alteration of objectMetadataArray(operation.metadata.alterColumns)) {
    if (typeof alteration.name === "string" && typeof alteration.type === "string") {
      identities.add(`${table}.${alteration.name}`);
    }
  }
  return identities;
}

function dependsOnAnyColumn(object: SchemaObject, columnIdentities: ReadonlySet<string>): boolean {
  for (const dependency of columnDependencyIdentities(object)) {
    if (columnIdentities.has(dependency)) {
      return true;
    }
  }
  return false;
}

function columnDependencyIdentities(object: SchemaObject): string[] {
  return [
    ...stringMetadataArray(object.metadata.columnDependencies),
    ...stringMetadataArray(object.metadata.routineColumnDependencies),
  ];
}

function blockOperation(operation: MigrationOperation, item: Diagnostic): void {
  operation.blocked = true;
  if (operation.destructive) {
    operation.metadata.destructiveDisposition = "blocked";
  }
  if (!operation.diagnostics.some((diagnosticItem) => sameDiagnostic(diagnosticItem, item))) {
    operation.diagnostics.push(item);
  }
}

function sameDiagnostic(left: Diagnostic, right: Diagnostic): boolean {
  return left.code === right.code && left.message === right.message && left.hint === right.hint;
}

function objectMetadataArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          typeof item === "object" && item !== null && !Array.isArray(item)
      )
    : [];
}

function stringMetadataArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function appendReplacedObjectDependents(
  operations: MigrationOperation[],
  from: SchemaModel,
  to: SchemaModel,
  config: SupaschemaConfig,
  migrationCorpus?: MigrationCorpus
): void {
  const replacedObjects = replacedDependencyRefs(operations);
  if (replacedObjects.length === 0) {
    return;
  }

  const context = replacedDependentContext(from, operations, replacedObjects);
  expandAffectedDependents(to.objects, operations, context, config, migrationCorpus);
  appendAffectedComments(to.objects, operations, context, config, migrationCorpus);
}

interface ReplacedDependentContext {
  affectedRefs: Map<string, ObjectRef>;
  dependencyIdentities: Set<string>;
  fromByKey: ReadonlyMap<string, SchemaObject>;
  fromKeys: Set<string>;
  operationKeys: Set<string>;
}

function replacedDependencyRefs(operations: MigrationOperation[]): ObjectRef[] {
  return operations
    .filter(
      (operation) => operation.kind === "replace" && replacedDependencyKinds.has(operation.ref.kind)
    )
    .map((operation) => operation.ref);
}

function replacedDependentContext(
  from: SchemaModel,
  operations: MigrationOperation[],
  replacedObjects: ObjectRef[]
): ReplacedDependentContext {
  const context: ReplacedDependentContext = {
    affectedRefs: new Map(),
    dependencyIdentities: new Set(),
    fromKeys: new Set(from.objects.map((object) => object.key)),
    fromByKey: new Map(from.objects.map((object) => [object.key, object])),
    operationKeys: new Set(operations.map((operation) => operation.key)),
  };
  for (const object of replacedObjects) {
    rememberAffectedRef(context.affectedRefs, object);
    context.dependencyIdentities.add(refIdentity(object));
  }
  return context;
}

function expandAffectedDependents(
  objects: SchemaObject[],
  operations: MigrationOperation[],
  context: ReplacedDependentContext,
  config: SupaschemaConfig,
  migrationCorpus: MigrationCorpus | undefined
): void {
  let changed = true;
  while (changed) {
    changed = false;
    for (const object of objects) {
      if (appendAffectedDependent(object, operations, context, config, migrationCorpus)) {
        changed = true;
      }
    }
  }
}

function appendAffectedDependent(
  object: SchemaObject,
  operations: MigrationOperation[],
  context: ReplacedDependentContext,
  config: SupaschemaConfig,
  migrationCorpus: MigrationCorpus | undefined
): boolean {
  if (!isAffectedDependent(object, context.dependencyIdentities, context.fromByKey)) {
    return false;
  }
  let changed = false;
  rememberAffectedRef(context.affectedRefs, object.ref);
  if (appendBlockingDependentPreDrop(object, operations, context, config, migrationCorpus)) {
    changed = true;
  }
  if (!context.operationKeys.has(object.key)) {
    operations.push(
      makeOperation("create", object.key, undefined, object, config, migrationCorpus)
    );
    context.operationKeys.add(object.key);
    changed = true;
  }
  return changed;
}

function appendBlockingDependentPreDrop(
  object: SchemaObject,
  operations: MigrationOperation[],
  context: ReplacedDependentContext,
  config: SupaschemaConfig,
  migrationCorpus: MigrationCorpus | undefined
): boolean {
  if (
    !(
      blockingObjectDependentKinds.has(object.ref.kind) ||
      isCrossTableRelationDependent(object, context.dependencyIdentities) ||
      isTriggerDependentOnAffectedRoutine(object, context.dependencyIdentities, context.fromByKey)
    )
  ) {
    return false;
  }
  if (!(context.fromKeys.has(object.key) || targetOnlyReplayPreDropKinds.has(object.ref.kind))) {
    return false;
  }
  let changed = rememberDependencyIdentity(context.dependencyIdentities, object.ref);
  const key = preDropKey(object.key);
  if (!context.operationKeys.has(key)) {
    operations.push(makePreDropOperation(object, config, migrationCorpus));
    context.operationKeys.add(key);
    changed = true;
  }
  markPreDroppedReplacement(object.key, operations);
  return changed;
}

function isTriggerDependentOnAffectedRoutine(
  object: SchemaObject,
  dependencyIdentities: ReadonlySet<string>,
  fromByKey: ReadonlyMap<string, SchemaObject>
): boolean {
  if (object.ref.kind !== "trigger") {
    return false;
  }
  const candidates = [object, fromByKey.get(object.key)];
  return candidates.some((candidate) => {
    const triggerFunction = candidate?.metadata.triggerFunction;
    return typeof triggerFunction === "string" && dependencyIdentities.has(triggerFunction);
  });
}

function markPreDroppedReplacement(key: string, operations: MigrationOperation[]): void {
  const operation = operations.find((item) => item.key === key);
  if (operation?.kind === "replace") {
    operation.metadata.preDropped = true;
  }
}

function rememberDependencyIdentity(identities: Set<string>, ref: ObjectRef): boolean {
  const identity = refIdentity(ref);
  if (identities.has(identity)) {
    return false;
  }
  identities.add(identity);
  return true;
}

function appendAffectedComments(
  objects: SchemaObject[],
  operations: MigrationOperation[],
  context: ReplacedDependentContext,
  config: SupaschemaConfig,
  migrationCorpus: MigrationCorpus | undefined
): void {
  for (const object of objects) {
    if (
      context.operationKeys.has(object.key) ||
      !isCommentForRefs(object, context.affectedRefs.values())
    ) {
      continue;
    }
    operations.push(
      makeOperation("create", object.key, undefined, object, config, migrationCorpus)
    );
    context.operationKeys.add(object.key);
  }
}

function isAffectedDependent(
  object: SchemaObject,
  dependencyIdentities: Set<string>,
  fromByKey: ReadonlyMap<string, SchemaObject>
): boolean {
  const tableIdentity = tableRefIdentity(object.ref);
  if (
    relationDependentKinds.has(object.ref.kind) &&
    tableIdentity !== undefined &&
    dependencyIdentities.has(tableIdentity)
  ) {
    return true;
  }
  if (
    blockingObjectDependentKinds.has(object.ref.kind) &&
    object.dependencies.some((dependency) => dependencyIdentities.has(dependency))
  ) {
    return true;
  }
  if (isCrossTableRelationDependent(object, dependencyIdentities)) {
    return true;
  }
  if (isTriggerDependentOnAffectedRoutine(object, dependencyIdentities, fromByKey)) {
    return true;
  }
  return (
    object.ref.kind === "grant" &&
    typeof object.metadata.targetIdentity === "string" &&
    dependencyIdentities.has(object.metadata.targetIdentity)
  );
}

function isCrossTableRelationDependent(
  object: SchemaObject,
  dependencyIdentities: Set<string>
): boolean {
  if (!relationDependentKinds.has(object.ref.kind)) {
    return false;
  }
  const ownTable = tableRefIdentity(object.ref);
  return object.dependencies.some(
    (dependency) => dependencyIdentities.has(dependency) && dependency !== ownTable
  );
}

function preDropKey(key: string): string {
  return `pre-drop:${key}`;
}

function makePreDropOperation(
  object: SchemaObject,
  config: SupaschemaConfig,
  migrationCorpus: MigrationCorpus | undefined
): MigrationOperation {
  const operation = makeOperation("drop", object.key, object, undefined, config, migrationCorpus);
  if (isReplayPreDrop(object.ref.kind)) {
    operation.blocked = false;
    operation.destructive = false;
    operation.diagnostics = operation.diagnostics.filter(
      (item) => item.code !== "SUPA_PLAN_DESTRUCTIVE_HINT_REQUIRED"
    );
    operation.metadata.destructiveDisposition = undefined;
  }
  return {
    ...operation,
    key: preDropKey(object.key),
  };
}

function isReplayPreDrop(kind: ObjectKind): boolean {
  return kind === "function" || kind === "procedure";
}

function rememberAffectedRef(affectedRefs: Map<string, ObjectRef>, ref: ObjectRef): void {
  affectedRefs.set(`${ref.kind}:${ref.schema ?? ""}:${ref.table ?? ""}:${ref.name}`, ref);
}

function emptyPlanDriftDiagnostic(
  fromMap: Map<string, SchemaObject>,
  toMap: Map<string, SchemaObject>,
  from: SchemaModel,
  to: SchemaModel
): Diagnostic {
  const differing: string[] = [];
  for (const [key, before] of fromMap) {
    const after = toMap.get(key);
    if (!after) {
      differing.push(`missing in target: ${key}`);
    } else if (before.hash !== after.hash && !sameRlsState(before, after)) {
      differing.push(`hash drift: ${key}`);
    }
  }
  for (const key of toMap.keys()) {
    if (!fromMap.has(key)) {
      differing.push(`missing in source: ${key}`);
    }
  }
  const sample = differing.slice(0, 12).join("; ");
  return diagnostic(
    "SUPA_PLAN_EMPTY_WITH_DRIFT",
    "error",
    "plan contains no operations but the model fingerprints differ",
    {
      hint:
        differing.length > 0
          ? `${differing.length} differing object(s): ${sample}`
          : `object sets are identical; fingerprint basis differs (from=${from.fingerprint} to=${to.fingerprint}) — check model format versions`,
    }
  );
}

function makeOperation(
  kind: MigrationOperationKind,
  key: string,
  before: SchemaObject | undefined,
  after: SchemaObject | undefined,
  config: SupaschemaConfig,
  migrationCorpus: MigrationCorpus | undefined
): MigrationOperation {
  const object = after ?? before;
  if (!object) {
    throw new Error(`operation ${kind} for ${key} has no object`);
  }
  const diagnostics: Diagnostic[] = [];
  const destructive = isDestructive(kind, object.ref.kind);
  const destructiveDisposition = operationDestructiveDisposition(
    key,
    destructive,
    config,
    migrationCorpus
  );
  let blocked = false;
  if (destructive && !destructiveDisposition) {
    blocked = true;
    const difference = kind === "replace" ? describeReplaceDifference(before, after) : undefined;
    diagnostics.push(
      diagnostic(
        "SUPA_PLAN_DESTRUCTIVE_HINT_REQUIRED",
        "error",
        `${kind} of ${object.ref.kind} requires an explicit destructive-change hint${difference ? ` — ${difference}` : ""}`,
        {
          hint: `Add "${key}" to hints.destructive only after reviewing the migration.`,
          ref: object.ref,
        }
      )
    );
  }
  if (kind === "replace" && object.ref.kind === "view") {
    diagnostics.push(
      diagnostic(
        "SUPA_PLAN_VIEW_REPLACE_VERIFY_REQUIRED",
        "warning",
        "PostgreSQL only permits CREATE OR REPLACE VIEW when the replacement shape is compatible",
        {
          hint: "Run supaschema verify against a disposable PostgreSQL database before release.",
          ref: object.ref,
        }
      )
    );
  }
  if (
    (kind === "create" || kind === "replace") &&
    object.ref.kind === "index" &&
    object.metadata.concurrent === true &&
    config.transactionMode === "per-migration"
  ) {
    blocked = true;
    diagnostics.push(
      diagnostic(
        "SUPA_PLAN_CONCURRENT_INDEX_UNSUPPORTED",
        "error",
        "CREATE INDEX CONCURRENTLY cannot run inside a per-migration transaction",
        {
          hint: "Create the index without CONCURRENTLY, or set transactionMode to per-statement and run the concurrent companion through an explicit out-of-transaction operational lane.",
          ref: object.ref,
        }
      )
    );
  }
  const operation: MigrationOperation = {
    blocked,
    destructive,
    diagnostics,
    key,
    kind,
    metadata: operationMetadata(destructive, blocked, destructiveDisposition),
    ref: object.ref,
  };
  if (before) {
    operation.before = before;
  }
  if (after) {
    operation.after = after;
  }
  return operation;
}

function operationDestructiveDisposition(
  key: string,
  destructive: boolean,
  config: SupaschemaConfig,
  migrationCorpus: MigrationCorpus | undefined
): "destructive-config" | "destructive-hint" | "migration-intent" | undefined {
  if (!destructive) {
    return;
  }
  if (isMigrationCorpusAllowed(key, migrationCorpus)) {
    return "migration-intent";
  }
  return destructiveAllowedDisposition(key, config);
}

function operationMetadata(
  destructive: boolean,
  blocked: boolean,
  destructiveDisposition: string | undefined
): Record<string, unknown> {
  if (!destructive) {
    return {};
  }
  return {
    destructiveDisposition: blocked ? "blocked" : destructiveDisposition,
  };
}

function isMigrationCorpusAllowed(
  key: string,
  migrationCorpus: MigrationCorpus | undefined
): boolean {
  return (migrationCorpus?.destructiveKeys ?? []).includes(key);
}
function makeRenameOperation(before: SchemaObject, after: SchemaObject): MigrationOperation {
  const diagnostics: Diagnostic[] = [];
  let blocked = false;
  if (before.ref.kind !== after.ref.kind) {
    blocked = true;
    diagnostics.push(
      diagnostic("SUPA_PLAN_RENAME_KIND_MISMATCH", "error", "rename hint changes object kind", {
        hint: `${before.key} -> ${after.key}`,
        ref: after.ref,
      })
    );
  }
  if (!isSupportedRenameKind(after.ref.kind)) {
    blocked = true;
    diagnostics.push(
      diagnostic(
        "SUPA_PLAN_RENAME_UNSUPPORTED",
        "error",
        `${after.ref.kind} renames are not yet rendered safely`,
        {
          hint: "Keep this change hand-authored or model it as an explicit create/drop with hints.",
          ref: after.ref,
        }
      )
    );
  }
  if (!sameRenameNamespace(before.ref, after.ref)) {
    blocked = true;
    diagnostics.push(
      diagnostic(
        "SUPA_PLAN_RENAME_SET_SCHEMA_UNSUPPORTED",
        "error",
        "rename hints cannot move an object between schemas",
        {
          hint: `${before.key} -> ${after.key}`,
          ref: after.ref,
        }
      )
    );
  }
  diagnostics.push(
    diagnostic(
      "SUPA_PLAN_RENAME_VERIFY_REQUIRED",
      "warning",
      "explicit rename hints must be verified against a disposable PostgreSQL database",
      {
        hint: `${before.key} -> ${after.key}`,
        ref: after.ref,
      }
    )
  );
  return {
    after,
    before,
    blocked,
    destructive: false,
    diagnostics,
    key: `${before.key}->${after.key}`,
    kind: "rename",
    metadata: {},
    ref: after.ref,
  };
}
function makeEnumAddValuesOperation(
  before: SchemaObject,
  after: SchemaObject
): MigrationOperation | undefined {
  if (before.ref.kind !== "enum" || after.ref.kind !== "enum") {
    return;
  }
  const beforeValues = enumValues(before);
  const afterValues = enumValues(after);
  if (!(beforeValues && afterValues) || afterValues.length <= beforeValues.length) {
    return;
  }
  const isPrefix = beforeValues.every((value, index) => afterValues[index] === value);
  if (!isPrefix) {
    return;
  }
  return {
    after,
    before,
    blocked: false,
    destructive: false,
    diagnostics: [],
    key: after.key,
    kind: "alter",
    metadata: { addEnumValues: afterValues.slice(beforeValues.length) },
    ref: after.ref,
  };
}
function enumValues(object: SchemaObject): string[] | undefined {
  const values = object.metadata.values;
  if (!Array.isArray(values)) {
    return;
  }
  const strings = values.filter((value): value is string => typeof value === "string");
  return strings.length === values.length ? strings : undefined;
}

function describeReplaceDifference(
  before: SchemaObject | undefined,
  after: SchemaObject | undefined
): string | undefined {
  if (!(before && after)) {
    return;
  }
  const beforeShape = asShape(before.metadata.canonicalShape);
  const afterShape = asShape(after.metadata.canonicalShape);
  if (!(beforeShape && afterShape)) {
    return "definition differs";
  }
  const parts: string[] = [];
  const beforeColumns = shapeColumns(beforeShape);
  const afterColumns = shapeColumns(afterShape);
  for (const [name, column] of beforeColumns) {
    const other = afterColumns.get(name);
    if (!other) {
      parts.push(`column "${name}" only in current state`);
      continue;
    }
    if (stableJson(column) !== stableJson(other)) {
      const changed = Object.keys({ ...column, ...other }).filter(
        (field) => stableJson(column[field]) !== stableJson(other[field])
      );
      parts.push(`column "${name}" differs (${changed.join(", ")})`);
    }
  }
  for (const name of afterColumns.keys()) {
    if (!beforeColumns.has(name)) {
      parts.push(`column "${name}" only in target state`);
    }
  }
  const beforeRest = stableJson({ ...beforeShape, columns: undefined });
  const afterRest = stableJson({ ...afterShape, columns: undefined });
  if (beforeRest !== afterRest) {
    const keys = new Set([...Object.keys(beforeShape), ...Object.keys(afterShape)]);
    keys.delete("columns");
    const changed = [...keys].filter(
      (field) => stableJson(beforeShape[field]) !== stableJson(afterShape[field])
    );
    parts.push(`table options differ (${changed.join(", ")})`);
  }
  return parts.length > 0 ? parts.join("; ") : "definition differs";
}

function asShape(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  return Object.fromEntries(Object.entries(value));
}

function shapeColumns(shape: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const columns = Array.isArray(shape.columns) ? shape.columns : [];
  const byName = new Map<string, Record<string, unknown>>();
  for (const column of columns) {
    const record = asShape(column);
    if (record && typeof record.name === "string") {
      byName.set(record.name, record);
    }
  }
  return byName;
}

function isDestructive(kind: MigrationOperationKind, objectKind: ObjectKind): boolean {
  switch (kind) {
    case "alter":
    case "create":
    case "rename":
      return false;
    case "drop":
      return [
        "schema",
        "table",
        "foreign-data-wrapper",
        "foreign-server",
        "foreign-table",
        "type",
        "domain",
        "enum",
        "sequence",
        "materialized-view",
        "function",
        "procedure",
        "grant",
        "default-privilege",
        "rls",
      ].includes(objectKind);
    case "replace":
      return [
        "table",
        "foreign-data-wrapper",
        "foreign-server",
        "foreign-table",
        "type",
        "domain",
        "enum",
        "materialized-view",
        "rls",
      ].includes(objectKind);
    default:
      return assertNever(kind);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled variant: ${value}`);
}
function isSupportedRenameKind(kind: ObjectKind): boolean {
  return [
    "schema",
    "table",
    "sequence",
    "index",
    "function",
    "procedure",
    "view",
    "materialized-view",
  ].includes(kind);
}
function sameRenameNamespace(before: ObjectRef, after: ObjectRef): boolean {
  if (before.kind === "schema" && after.kind === "schema") {
    return true;
  }
  return (before.schema ?? "public") === (after.schema ?? "public");
}
