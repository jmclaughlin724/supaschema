import { diagnostic } from "../diagnostics/diagnostics.js";
import type { AstNode } from "../sql/ast.js";
import {
  asRecord,
  readArray,
  readNumber,
  readString,
  stringList,
  stringValue,
  typeNameToSql,
} from "../sql/ast.js";
import { parseSqlAst } from "../sql/parser.js";
import { canonicalColumnType, canonicalTableShape } from "../sql/table-shape.js";
import type { Diagnostic, SchemaModel, SchemaObject } from "../types.js";
import {
  collectUnresolvedViewRelations,
  collectViewColumns,
  type FunctionShapesByKey,
  isNonUpdatableViewFunctionCall,
} from "./views.js";

export interface ColumnShape {
  collation?: string;
  default?: unknown;
  generated?: unknown;
  identity?: string;
  name: string;
  notNull: boolean;
  type: string;
  updatable?: boolean;
}

export function sortedByName<T extends { name: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.name.localeCompare(right.name));
}

export function isNonWritableColumn(column: ColumnShape): boolean {
  return column.generated !== undefined || column.identity === "a";
}

export function isOptionalInsertColumn(column: ColumnShape): boolean {
  return !column.notNull || column.default !== undefined || column.identity !== undefined;
}

export interface RelationshipShape {
  columns: string[];
  foreignKeyName: string;
  isOneToOne: boolean;
  referencedColumns: string[];
  referencedRelation: string;
  referencedSchema: string;
}

export interface FunctionArgShape {
  name: string;
  optional: boolean;
  type: string;
}

export interface FunctionReturnShape {
  columns?: { name: string; type: string }[];
  setof: boolean;
  type: string;
}

export interface FunctionShape {
  args: FunctionArgShape[];
  estimatedRows: number;
  name: string;
  returns: FunctionReturnShape | undefined;
}

export interface CheckConstraintShape {
  expression: AstNode;
  name: string;
  skipValidation: boolean;
}

interface DomainShape {
  baseType: string;
  checkConstraints: CheckConstraintShape[];
  collation?: string;
}

export interface TableShape {
  checkConstraints: CheckConstraintShape[];
  columns: ColumnShape[];
  foreign?: boolean;
  name: string;
  primaryKey?: string[];
  relationships: RelationshipShape[];
  uniqueColumnSets: string[][];
}

export interface ViewShape {
  columns: ColumnShape[];
  name: string;
  relationships: RelationshipShape[];
  updatable: boolean;
}

export interface SchemaEntry {
  composites: { columns: ColumnShape[]; name: string }[];
  enums: { name: string; values: string[] }[];
  functions: FunctionShape[];
  tables: TableShape[];
  views: ViewShape[];
}

export interface SchemaShapes {
  compositesByBareName: Map<string, { name: string; schema: string }[]>;
  compositesByQualifiedName: Map<string, { name: string; schema: string }>;
  domains: Map<string, DomainShape>;
  enumsByBareName: Map<string, { name: string; schema: string }[]>;
  enumsByQualifiedName: Map<string, { name: string; schema: string }>;
  schemas: Map<string, SchemaEntry>;
}

export interface ResolvedColumnType {
  arrayDepth: number;
  compositeRef?: { name: string; schema: string };
  enumRef?: { name: string; schema: string };
  kind:
    | "boolean"
    | "composite"
    | "enum"
    | "json"
    | "number"
    | "record"
    | "relation"
    | "string"
    | "unknown"
    | "void";
  relationRef?: { collection: "Tables" | "Views"; name: string; schema: string };
}

export function computedRelationshipFunctions(
  shapes: SchemaShapes,
  schema: string,
  entry: SchemaEntry,
  relationName: string
): FunctionShape[] {
  return sortedByName(entry.functions).filter((fn) => {
    const arg = fn.args[0];
    if (fn.args.length !== 1 || arg?.name !== "") {
      return false;
    }
    const resolved = chaseColumnType(shapes, schema, arg.type);
    return (
      !isDeclaredDomainType(shapes, schema, arg.type) &&
      resolved.arrayDepth === 0 &&
      resolved.kind === "relation" &&
      resolved.relationRef?.schema === schema &&
      resolved.relationRef.name === relationName &&
      computedArgumentTypeName(arg.type) === relationName
    );
  });
}

function computedArgumentTypeName(sqlType: string): string {
  const typeName = baseSqlTypeName(sqlType);
  return typeName.startsWith("public.") ? typeName.slice("public.".length) : typeName;
}

export function functionReturnsMultipleRows(fn: FunctionShape): boolean {
  return fn.returns?.setof === true && fn.estimatedRows > 1;
}

export async function collectSchemaShapes(
  model: SchemaModel,
  diagnostics?: Diagnostic[]
): Promise<SchemaShapes> {
  const shapes: SchemaShapes = {
    compositesByBareName: new Map(),
    compositesByQualifiedName: new Map(),
    domains: new Map(),
    enumsByBareName: new Map(),
    enumsByQualifiedName: new Map(),
    schemas: new Map(),
  };
  await collectEnumAndDomainShapes(model, shapes);
  const relationsByKey = new Map<string, TableShape>();
  await collectRelationAndFunctionShapes(model, shapes, relationsByKey);
  await applyModelConstraints(model, relationsByKey);
  resolveRelationshipTargets(relationsByKey);
  await collectViewAndCompositeShapes(
    model,
    shapes,
    relationsByKey,
    functionShapesByKey(shapes),
    diagnostics
  );
  return shapes;
}

async function collectEnumAndDomainShapes(model: SchemaModel, shapes: SchemaShapes): Promise<void> {
  for (const object of model.objects) {
    if (object.ref.kind === "enum") {
      registerEnumShape(shapes, object);
      continue;
    }
    if (object.ref.kind === "domain") {
      const domain = await domainShape(object);
      if (domain !== undefined) {
        shapes.domains.set(`${object.ref.schema ?? "public"}.${object.ref.name}`, domain);
      }
    }
  }
}

function registerEnumShape(shapes: SchemaShapes, object: SchemaObject): void {
  const schema = object.ref.schema ?? "public";
  const entry = { name: object.ref.name, schema };
  shapes.enumsByQualifiedName.set(`${schema}.${object.ref.name}`, entry);
  const bare = shapes.enumsByBareName.get(object.ref.name) ?? [];
  bare.push(entry);
  shapes.enumsByBareName.set(object.ref.name, bare);
  const values = Array.isArray(object.metadata.values)
    ? object.metadata.values.map((value) => String(value))
    : [];
  schemaEntry(shapes, schema).enums.push({ name: object.ref.name, values });
}

async function collectRelationAndFunctionShapes(
  model: SchemaModel,
  shapes: SchemaShapes,
  tablesByKey: Map<string, TableShape>
): Promise<void> {
  for (const object of model.objects) {
    if (object.ref.kind === "table" || object.ref.kind === "foreign-table") {
      await registerTableShape(shapes, tablesByKey, object);
      continue;
    }
    if (object.ref.kind === "function") {
      const shape = await functionShape(object);
      if (shape) {
        schemaEntry(shapes, object.ref.schema ?? "public").functions.push(shape);
      }
    }
  }
}

async function registerTableShape(
  shapes: SchemaShapes,
  tablesByKey: Map<string, TableShape>,
  object: SchemaObject
): Promise<void> {
  const columns =
    object.ref.kind === "table" ? await tableColumns(object) : await foreignTableColumns(object);
  const table: TableShape = {
    checkConstraints: [],
    columns,
    ...(object.ref.kind === "foreign-table" ? { foreign: true } : {}),
    name: object.ref.name,
    relationships: [],
    uniqueColumnSets: [],
  };
  const schema = object.ref.schema ?? "public";
  tablesByKey.set(`${schema}.${object.ref.name}`, table);
  schemaEntry(shapes, schema).tables.push(table);
}

async function applyModelConstraints(
  model: SchemaModel,
  tablesByKey: Map<string, TableShape>
): Promise<void> {
  for (const object of model.objects) {
    if (object.ref.kind === "constraint") {
      await applyConstraint(object, tablesByKey);
    }
  }
}

async function collectViewAndCompositeShapes(
  model: SchemaModel,
  shapes: SchemaShapes,
  relationsByKey: Map<string, TableShape>,
  functionsByKey: FunctionShapesByKey,
  diagnostics?: Diagnostic[]
): Promise<void> {
  const views: SchemaObject[] = [];
  const composites: SchemaObject[] = [];
  for (const object of model.objects) {
    if (object.ref.kind === "view" || object.ref.kind === "materialized-view") {
      views.push(object);
      continue;
    }
    if (object.ref.kind === "type") {
      composites.push(object);
    }
  }
  for (const object of composites) {
    await registerCompositeShape(shapes, object);
  }
  await registerViewShapes(shapes, relationsByKey, functionsByKey, views, diagnostics);
}

async function registerViewShapes(
  shapes: SchemaShapes,
  relationsByKey: Map<string, TableShape>,
  functionsByKey: FunctionShapesByKey,
  objects: SchemaObject[],
  diagnostics?: Diagnostic[]
): Promise<void> {
  const columnsByKey = new Map<string, ColumnShape[]>();
  for (let pass = 0; pass <= objects.length; pass += 1) {
    let changed = false;
    for (const object of objects) {
      const key = relationKey(object);
      const columns = await collectViewColumns(object, relationsByKey, functionsByKey);
      if (!sameColumns(columnsByKey.get(key), columns)) {
        columnsByKey.set(key, columns);
        relationsByKey.set(key, relationShape(object.ref.name, columns));
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  for (const object of objects) {
    const columns = (columnsByKey.get(relationKey(object)) ?? []).map((column) => ({
      ...column,
      notNull: false,
    }));
    const updatable = object.ref.kind === "view" && (await isUpdatableView(object, functionsByKey));
    schemaEntry(shapes, object.ref.schema ?? "public").views.push({
      columns: updatable ? await markViewColumnUpdatability(object, columns) : columns,
      name: object.ref.name,
      relationships: [],
      updatable,
    });
    if (diagnostics === undefined) {
      continue;
    }
    const unknownCount = columns.filter((column) => column.type === "unknown").length;
    if (unknownCount === 0) {
      continue;
    }
    const unresolved = await collectUnresolvedViewRelations(object, relationsByKey);
    if (unresolved.length === 0) {
      continue;
    }
    diagnostics.push(
      diagnostic(
        "SUPA_TYPEGEN_UNKNOWN_RELATION",
        "warning",
        `view ${relationKey(object)} generates ${unknownCount} unknown-typed column(s); relation(s) ${unresolved.join(", ")} are outside the modeled schemas`,
        {
          hint: "Add explicit casts to the view's output columns (for example (col)::uuid) so generated contracts carry concrete types, or include the referenced schema in the model.",
          ref: object.ref,
        }
      )
    );
  }
}

function relationKey(object: SchemaObject): string {
  return `${object.ref.schema ?? "public"}.${object.ref.name}`;
}

function relationShape(name: string, columns: ColumnShape[]): TableShape {
  return {
    checkConstraints: [],
    columns,
    name,
    relationships: [],
    uniqueColumnSets: [],
  };
}

function sameColumns(left: ColumnShape[] | undefined, right: ColumnShape[]): boolean {
  if (left === undefined || left.length !== right.length) {
    return false;
  }
  return left.every((column, index) => {
    const other = right[index];
    return other !== undefined && column.name === other.name && column.type === other.type;
  });
}

async function isUpdatableView(
  object: SchemaObject,
  functionsByKey: FunctionShapesByKey
): Promise<boolean> {
  const select = await viewSelectStatement(object);
  if (!select) {
    return false;
  }
  if (
    asRecord(select.larg) ||
    asRecord(select.rarg) ||
    select.distinctClause !== undefined ||
    select.groupClause !== undefined ||
    select.havingQual !== undefined ||
    select.limitOffset !== undefined ||
    select.limitCount !== undefined ||
    select.withClause !== undefined
  ) {
    return false;
  }
  if (
    containsNonUpdatableViewFunction(
      select.targetList,
      object.ref.schema ?? "public",
      functionsByKey
    )
  ) {
    return false;
  }
  const from = readArray(select.fromClause);
  if (from.length !== 1) {
    return false;
  }
  return asRecord(asRecord(from[0])?.RangeVar) !== undefined;
}

function containsNonUpdatableViewFunction(
  value: unknown,
  defaultSchema: string,
  functionsByKey: FunctionShapesByKey
): boolean {
  if (Array.isArray(value)) {
    return value.some((item) =>
      containsNonUpdatableViewFunction(item, defaultSchema, functionsByKey)
    );
  }
  const node = asRecord(value);
  if (!node) {
    return false;
  }
  const functionCall = asRecord(node.FuncCall);
  if (functionCall) {
    const parts = stringList(functionCall.funcname);
    const name = parts.at(-1);
    const schema = parts.length > 1 ? parts.at(-2) : defaultSchema;
    if (
      isNonUpdatableViewFunctionCall(functionCall) ||
      (name !== undefined &&
        schema !== undefined &&
        functionsByKey.get(`${schema}.${name}`)?.some((fn) => fn.returns?.setof === true))
    ) {
      return true;
    }
  }
  return Object.values(node).some((item) =>
    containsNonUpdatableViewFunction(item, defaultSchema, functionsByKey)
  );
}

async function markViewColumnUpdatability(
  object: SchemaObject,
  columns: ColumnShape[]
): Promise<ColumnShape[]> {
  const select = await viewSelectStatement(object);
  if (!select) {
    return columns;
  }
  const aliases = Array.isArray(object.metadata.viewColumns)
    ? object.metadata.viewColumns.map((value) => String(value))
    : [];
  const { hasWildcard, nonWritable, writable } = writableViewColumns(select, aliases);
  return columns.map((column) => ({
    ...column,
    updatable: writable.has(column.name) || (hasWildcard && !nonWritable.has(column.name)),
  }));
}

async function viewSelectStatement(object: SchemaObject): Promise<AstNode | undefined> {
  const parsed = await parseSqlAst(object.sql, object.file);
  const statements = readArray(asRecord(parsed.ast)?.stmts);
  const stmt = asRecord(asRecord(statements[0])?.stmt);
  const view = asRecord(stmt?.ViewStmt);
  const query = asRecord(view?.query);
  return asRecord(query?.SelectStmt);
}

function writableViewColumns(
  select: AstNode,
  aliases: string[]
): {
  hasWildcard: boolean;
  nonWritable: Set<string>;
  writable: Set<string>;
} {
  const targets = readArray(select.targetList);
  const positionalAliases = targets.some((item) => {
    const target = asRecord(asRecord(item)?.ResTarget);
    const columnRef = asRecord(asRecord(target?.val)?.ColumnRef);
    return readArray(columnRef?.fields).some((field) => asRecord(field)?.A_Star !== undefined);
  })
    ? []
    : aliases;
  let hasWildcard = false;
  const nonWritable = new Set<string>();
  const writable = new Set<string>();
  for (const [index, item] of targets.entries()) {
    const target = asRecord(asRecord(item)?.ResTarget);
    const columnRef = asRecord(asRecord(target?.val)?.ColumnRef);
    if (!target) {
      continue;
    }
    if (!columnRef) {
      const functionCall = asRecord(asRecord(target.val)?.FuncCall);
      const outputName =
        positionalAliases[index] ??
        readString(target.name) ??
        stringList(functionCall?.funcname).at(-1);
      if (outputName) {
        nonWritable.add(outputName);
      }
      continue;
    }
    const fields = readArray(columnRef.fields);
    if (fields.some((field) => asRecord(field)?.A_Star !== undefined)) {
      hasWildcard = true;
      continue;
    }
    const sourceName = stringValue(fields.at(-1));
    if (!sourceName) {
      continue;
    }
    writable.add(positionalAliases[index] ?? readString(target.name) ?? sourceName);
  }
  return { hasWildcard, nonWritable, writable };
}

function functionShapesByKey(shapes: SchemaShapes): FunctionShapesByKey {
  const byKey: FunctionShapesByKey = new Map();
  for (const [schemaName, entry] of shapes.schemas) {
    for (const fn of entry.functions) {
      const key = `${schemaName}.${fn.name}`;
      const functions = byKey.get(key) ?? [];
      functions.push(fn);
      byKey.set(key, functions);
    }
  }
  return byKey;
}

async function registerCompositeShape(shapes: SchemaShapes, object: SchemaObject): Promise<void> {
  const columns = await compositeColumns(object);
  if (columns === undefined) {
    return;
  }
  const schema = object.ref.schema ?? "public";
  const name = object.ref.name;
  schemaEntry(shapes, schema).composites.push({ columns, name });
  const entry = { name, schema };
  shapes.compositesByQualifiedName.set(`${schema}.${name}`, entry);
  const bare = shapes.compositesByBareName.get(name) ?? [];
  bare.push(entry);
  shapes.compositesByBareName.set(name, bare);
}

export interface ColumnTypeChase extends ResolvedColumnType {
  baseTypeName: string;
  domainChain: string[];
  sawTypmod: boolean;
}

export function chaseColumnType(
  shapes: SchemaShapes,
  schemaName: string,
  sqlType: string
): ColumnTypeChase {
  const initial = typeDecorations(sqlType);
  let arrayDepth = initial.arrayDepth;
  let baseTypeName = initial.baseTypeName;
  let sawTypmod = initial.sawTypmod;
  const domainChain: string[] = [];
  const visited = new Set<string>();
  let domainSchema = schemaName;
  let unresolvedDomain = false;
  while (true) {
    const domainKey = domainKeyForType(shapes, domainSchema, baseTypeName);
    if (domainKey === null || (domainKey !== undefined && visited.has(domainKey))) {
      unresolvedDomain = true;
      break;
    }
    if (domainKey === undefined) {
      break;
    }
    const domain = shapes.domains.get(domainKey);
    if (domain === undefined) {
      break;
    }
    visited.add(domainKey);
    domainChain.push(domainKey);
    domainSchema = schemaNameFromKey(domainKey);
    const base = typeDecorations(domain.baseType);
    arrayDepth += base.arrayDepth;
    baseTypeName = base.baseTypeName;
    sawTypmod ||= base.sawTypmod;
  }
  const resolved: ResolvedColumnType = unresolvedDomain
    ? { arrayDepth, kind: "unknown" }
    : resolveBaseColumnType(shapes, domainSchema, baseTypeName, arrayDepth);
  return {
    ...resolved,
    baseTypeName,
    domainChain,
    sawTypmod,
  };
}

function domainKeyForType(
  shapes: SchemaShapes,
  schemaName: string,
  typeName: string
): string | null | undefined {
  if (typeName.includes(".")) {
    return shapes.domains.has(typeName) ? typeName : undefined;
  }
  if (resolveScalarType(typeName, 0) !== undefined) {
    return;
  }
  const localKey = `${schemaName}.${typeName}`;
  if (shapes.domains.has(localKey)) {
    return localKey;
  }
  const suffix = `.${typeName}`;
  const domainMatches = [...shapes.domains.keys()].filter((key) => key.endsWith(suffix));
  if (domainMatches.length === 0) {
    return;
  }
  const candidateKeys = new Set(domainMatches);
  for (const entry of shapes.enumsByBareName.get(typeName) ?? []) {
    candidateKeys.add(`${entry.schema}.${entry.name}`);
  }
  for (const entry of shapes.compositesByBareName.get(typeName) ?? []) {
    candidateKeys.add(`${entry.schema}.${entry.name}`);
  }
  for (const [schema, entry] of shapes.schemas) {
    if (relationTypeInEntry(entry, schema, typeName) !== undefined) {
      candidateKeys.add(`${schema}.${typeName}`);
    }
  }
  return candidateKeys.size === 1 ? domainMatches[0] : null;
}

function schemaNameFromKey(key: string): string {
  const separator = key.lastIndexOf(".");
  return separator === -1 ? "public" : key.slice(0, separator);
}

function typeDecorations(sqlType: string): {
  arrayDepth: number;
  baseTypeName: string;
  sawTypmod: boolean;
} {
  let arrayDepth = 0;
  let base = sqlType.trim();
  while (base.endsWith("[]")) {
    base = base.slice(0, -2).trim();
    arrayDepth += 1;
  }
  const parenStart = base.indexOf("(");
  return {
    arrayDepth,
    baseTypeName: parenStart === -1 ? base : base.slice(0, parenStart).trim(),
    sawTypmod: parenStart !== -1,
  };
}

function resolveBaseColumnType(
  shapes: SchemaShapes,
  schemaName: string,
  base: string,
  arrayDepth: number
): ResolvedColumnType {
  const scalar = resolveScalarType(base, arrayDepth);
  if (scalar) {
    return scalar;
  }
  const userType = resolveUserType(shapes, schemaName, base);
  if (userType?.kind === "enum") {
    return { arrayDepth, enumRef: userType.ref, kind: "enum" };
  }
  if (userType?.kind === "composite") {
    return { arrayDepth, compositeRef: userType.ref, kind: "composite" };
  }
  const relationType = resolveRelationType(shapes, schemaName, base);
  if (relationType) {
    return { arrayDepth, kind: "relation", relationRef: relationType };
  }
  const unqualifiedScalar = resolveScalarType(unqualifiedTypeName(base), arrayDepth);
  if (unqualifiedScalar) {
    return unqualifiedScalar;
  }
  return { arrayDepth, kind: "unknown" };
}

export function isDeclaredDomainType(
  shapes: SchemaShapes,
  schemaName: string,
  sqlType: string
): boolean {
  const base = baseSqlTypeName(sqlType);
  return domainKeyForType(shapes, schemaName, base) !== undefined;
}

function baseSqlTypeName(sqlType: string): string {
  return typeDecorations(sqlType).baseTypeName;
}

function resolveScalarType(base: string, arrayDepth: number): ResolvedColumnType | undefined {
  const lowered = base.toLowerCase();
  if (numberTypes.has(lowered)) {
    return { arrayDepth, kind: "number" };
  }
  if (stringTypes.has(lowered)) {
    return { arrayDepth, kind: "string" };
  }
  if (lowered === "boolean" || lowered === "bool") {
    return { arrayDepth, kind: "boolean" };
  }
  if (lowered === "json" || lowered === "jsonb") {
    return { arrayDepth, kind: "json" };
  }
  if (lowered === "void") {
    return { arrayDepth, kind: "void" };
  }
  if (lowered === "record") {
    return { arrayDepth, kind: "record" };
  }
}

function unqualifiedTypeName(base: string): string {
  return base.includes(".") ? (base.split(".").at(-1) ?? base) : base;
}

function resolveUserType(
  shapes: SchemaShapes,
  schemaName: string,
  base: string
): { kind: "composite" | "enum"; ref: { name: string; schema: string } } | undefined {
  if (base.includes(".")) {
    const qualifiedEnum = shapes.enumsByQualifiedName.get(base);
    if (qualifiedEnum) {
      return { kind: "enum", ref: qualifiedEnum };
    }
    const qualifiedComposite = shapes.compositesByQualifiedName.get(base);
    return qualifiedComposite ? { kind: "composite", ref: qualifiedComposite } : undefined;
  }
  const localEnum = shapes.enumsByQualifiedName.get(`${schemaName}.${base}`);
  if (localEnum) {
    return { kind: "enum", ref: localEnum };
  }
  const localComposite = shapes.compositesByQualifiedName.get(`${schemaName}.${base}`);
  if (localComposite) {
    return { kind: "composite", ref: localComposite };
  }

  const enumMatches = shapes.enumsByBareName.get(base) ?? [];
  const compositeMatches = shapes.compositesByBareName.get(base) ?? [];
  if (enumMatches.length + compositeMatches.length !== 1) {
    return;
  }
  const enumMatch = enumMatches[0];
  if (enumMatch) {
    return { kind: "enum", ref: enumMatch };
  }
  const compositeMatch = compositeMatches[0];
  return compositeMatch ? { kind: "composite", ref: compositeMatch } : undefined;
}

function resolveRelationType(
  shapes: SchemaShapes,
  schemaName: string,
  base: string
): { collection: "Tables" | "Views"; name: string; schema: string } | undefined {
  if (base.includes(".")) {
    const [schema, ...rest] = base.split(".");
    const name = rest.join(".");
    return schema && name ? relationTypeInSchema(shapes, schema, name) : undefined;
  }
  const localRelation = relationTypeInSchema(shapes, schemaName, base);
  if (localRelation) {
    return localRelation;
  }

  const matches: { collection: "Tables" | "Views"; name: string; schema: string }[] = [];
  for (const [schema, entry] of shapes.schemas) {
    const relation = relationTypeInEntry(entry, schema, base);
    if (relation) {
      matches.push(relation);
    }
  }
  return matches.length === 1 ? matches[0] : undefined;
}

function relationTypeInSchema(
  shapes: SchemaShapes,
  schema: string,
  name: string
): { collection: "Tables" | "Views"; name: string; schema: string } | undefined {
  const entry = shapes.schemas.get(schema);
  return entry ? relationTypeInEntry(entry, schema, name) : undefined;
}

function relationTypeInEntry(
  entry: SchemaEntry,
  schema: string,
  name: string
): { collection: "Tables" | "Views"; name: string; schema: string } | undefined {
  if (entry.tables.some((table) => table.name === name)) {
    return { collection: "Tables", name, schema };
  }
  if (entry.views.some((view) => view.name === name)) {
    return { collection: "Views", name, schema };
  }
}

function schemaEntry(shapes: SchemaShapes, name: string): SchemaEntry {
  let entry = shapes.schemas.get(name);
  if (!entry) {
    entry = { composites: [], enums: [], functions: [], tables: [], views: [] };
    shapes.schemas.set(name, entry);
  }
  return entry;
}

async function tableColumns(object: SchemaObject): Promise<ColumnShape[]> {
  const parsed = await parseSqlAst(object.sql, object.file);
  const statements = readArray(asRecord(parsed.ast)?.stmts);
  const create = asRecord(asRecord(asRecord(statements[0])?.stmt)?.CreateStmt);
  const collations = explicitColumnCollations(create);
  const shape = asRecord(object.metadata.canonicalShape);
  return readArray(shape?.columns).flatMap((item) => {
    const column = asRecord(item);
    const name = readString(column?.name);
    const type = readString(column?.type);
    if (!(column && name && type)) {
      return [];
    }
    const collation = collations.get(name);
    return [
      {
        ...(collation === undefined ? {} : { collation }),
        name,
        notNull: column.notNull === true,
        type,
        ...(column.default === undefined ? {} : { default: column.default }),
        ...(column.generated === undefined ? {} : { generated: column.generated }),
        ...(typeof column.identity === "string" ? { identity: column.identity } : {}),
      },
    ];
  });
}

async function foreignTableColumns(object: SchemaObject): Promise<ColumnShape[]> {
  const parsed = await parseSqlAst(object.sql, object.file);
  const statements = readArray(asRecord(parsed.ast)?.stmts);
  const stmt = asRecord(asRecord(statements[0])?.stmt);
  const base = asRecord(asRecord(stmt?.CreateForeignTableStmt)?.base);
  if (!base) {
    return [];
  }
  const shape = canonicalTableShape(base);
  const collations = explicitColumnCollations(base);
  return readArray(shape.columns).flatMap((item) => {
    const column = asRecord(item);
    const name = readString(column?.name);
    const type = readString(column?.type);
    const collation = name === undefined ? undefined : collations.get(name);
    return column && name && type
      ? [
          {
            ...(collation === undefined ? {} : { collation }),
            name,
            notNull: column.notNull === true,
            type,
          },
        ]
      : [];
  });
}

function explicitColumnCollations(table: AstNode | undefined): Map<string, string> {
  const collations = new Map<string, string>();
  for (const item of readArray(table?.tableElts)) {
    const column = asRecord(asRecord(item)?.ColumnDef);
    const name = readString(column?.colname);
    const collation = stringList(asRecord(column?.collClause)?.collname).join(".");
    if (name && collation) {
      collations.set(name, collation);
    }
  }
  return collations;
}

async function compositeColumns(object: SchemaObject): Promise<ColumnShape[] | undefined> {
  const parsed = await parseSqlAst(object.sql, object.file);
  const statements = readArray(asRecord(parsed.ast)?.stmts);
  const composite = asRecord(asRecord(asRecord(statements[0])?.stmt)?.CompositeTypeStmt);
  if (!composite) {
    return;
  }
  return readArray(composite?.coldeflist).flatMap((item) => {
    const columnDef = asRecord(asRecord(item)?.ColumnDef);
    const name = readString(columnDef?.colname);
    if (!(columnDef && name)) {
      return [];
    }
    return [{ name, notNull: false, type: canonicalColumnType(columnDef.typeName) }];
  });
}

async function domainShape(object: SchemaObject): Promise<DomainShape | undefined> {
  const parsed = await parseSqlAst(object.sql, object.file);
  const statements = readArray(asRecord(parsed.ast)?.stmts);
  const domain = asRecord(asRecord(asRecord(statements[0])?.stmt)?.CreateDomainStmt);
  if (!domain) {
    return;
  }
  const checkConstraints = readArray(domain.constraints).flatMap((item) => {
    const constraint = asRecord(asRecord(item)?.Constraint);
    const expression = asRecord(constraint?.raw_expr);
    if (readString(constraint?.contype) !== "CONSTR_CHECK" || !expression) {
      return [];
    }
    return [
      {
        expression,
        name: readString(constraint?.conname) ?? object.ref.name,
        skipValidation: false,
      },
    ];
  });
  const collation = stringList(asRecord(domain.collClause)?.collname).join(".");
  return {
    baseType: canonicalColumnType(domain.typeName),
    checkConstraints,
    ...(collation ? { collation } : {}),
  };
}

async function functionShape(object: SchemaObject): Promise<FunctionShape | undefined> {
  const parsed = await parseSqlAst(object.sql, object.file);
  const statements = readArray(asRecord(parsed.ast)?.stmts);
  const fn = asRecord(asRecord(asRecord(statements[0])?.stmt)?.CreateFunctionStmt);
  if (!fn) {
    return;
  }
  const args: FunctionShape["args"] = [];
  const returnColumns: { name: string; type: string }[] = [];
  let hasTableParam = false;
  for (const item of readArray(fn.parameters)) {
    const parameter = asRecord(asRecord(item)?.FunctionParameter);
    const result = applyFunctionParameter(parameter, args, returnColumns);
    if (result === "skip") {
      continue;
    }
    hasTableParam ||= result === "table";
  }
  args.sort((left, right) => left.name.localeCompare(right.name));
  const returns = asRecord(object.metadata.returns);
  const scalarType = typeof returns?.type === "string" ? returns.type : undefined;
  const setof = returns?.setof === true || hasTableParam;
  const estimatedRows = functionEstimatedRows(fn, setof);

  if (returnColumns.length > 0 && hasTableParam) {
    return {
      args,
      estimatedRows,
      name: object.ref.name,
      returns: { columns: returnColumns, setof, type: scalarType ?? "record" },
    };
  }
  const singleOut = !hasTableParam && returnColumns.length === 1 ? returnColumns[0] : undefined;
  const effectiveType = singleOut?.type ?? (returnColumns.length > 1 ? "record" : scalarType);
  return {
    args,
    estimatedRows,
    name: object.ref.name,
    returns: effectiveType === undefined ? undefined : { setof, type: effectiveType },
  };
}

function functionEstimatedRows(fn: AstNode, setof: boolean): number {
  for (const item of readArray(fn.options)) {
    const option = asRecord(asRecord(item)?.DefElem);
    if (readString(option?.defname) !== "rows") {
      continue;
    }
    const integer = readNumber(asRecord(asRecord(option?.arg)?.Integer)?.ival);
    if (integer !== undefined) {
      return integer;
    }
    const float = readString(asRecord(asRecord(option?.arg)?.Float)?.fval);
    if (float !== undefined) {
      const parsed = Number.parseFloat(float);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return setof ? 1000 : 0;
}

type FunctionParameterResult = "skip" | "table" | "value";

function applyFunctionParameter(
  parameter: AstNode | undefined,
  args: FunctionShape["args"],
  returnColumns: { name: string; type: string }[]
): FunctionParameterResult {
  if (!parameter) {
    return "skip";
  }
  const mode = readString(parameter.mode) ?? "FUNC_PARAM_DEFAULT";
  recordReturnParameter(parameter, mode, returnColumns);
  if (!isInputParameter(mode)) {
    return mode === "FUNC_PARAM_TABLE" ? "table" : "skip";
  }
  args.push({
    name: readString(parameter.name) ?? "",
    optional: parameter.defexpr !== undefined,
    type: typeNameToSql(parameter.argType),
  });
  return mode === "FUNC_PARAM_TABLE" ? "table" : "value";
}

function recordReturnParameter(
  parameter: AstNode,
  mode: string,
  returnColumns: { name: string; type: string }[]
): void {
  if (!isOutputParameter(mode)) {
    return;
  }
  const columnName = readString(parameter.name);
  if (columnName) {
    returnColumns.push({ name: columnName, type: typeNameToSql(parameter.argType) });
  }
}

function isOutputParameter(mode: string): boolean {
  return mode === "FUNC_PARAM_OUT" || mode === "FUNC_PARAM_INOUT" || mode === "FUNC_PARAM_TABLE";
}

function isInputParameter(mode: string): boolean {
  return (
    mode === "FUNC_PARAM_DEFAULT" ||
    mode === "FUNC_PARAM_IN" ||
    mode === "FUNC_PARAM_INOUT" ||
    mode === "FUNC_PARAM_VARIADIC"
  );
}

async function applyConstraint(
  object: SchemaObject,
  tablesByKey: Map<string, TableShape>
): Promise<void> {
  const parsed = await parseSqlAst(object.sql, object.file);
  const statements = readArray(asRecord(parsed.ast)?.stmts);
  const alter = asRecord(asRecord(asRecord(statements[0])?.stmt)?.AlterTableStmt);
  const schemaName = object.ref.schema ?? "public";
  const table = tablesByKey.get(`${schemaName}.${object.ref.table ?? ""}`);
  if (!table) {
    return;
  }
  for (const command of readArray(alter?.cmds)) {
    applyConstraintCommand(command, table, object, schemaName);
  }
}

function applyConstraintCommand(
  command: unknown,
  table: TableShape,
  object: SchemaObject,
  schemaName: string
): void {
  const constraint = asRecord(
    asRecord(asRecord(asRecord(command)?.AlterTableCmd)?.def)?.Constraint
  );
  const contype = readString(constraint?.contype);
  if (!(constraint && contype)) {
    return;
  }
  if (contype === "CONSTR_PRIMARY") {
    applyPrimaryKeyConstraint(table, constraint);
    return;
  }
  if (contype === "CONSTR_UNIQUE") {
    table.uniqueColumnSets.push(stringList(constraint.keys));
    return;
  }
  if (contype === "CONSTR_FOREIGN") {
    applyForeignKeyConstraint(table, constraint, object, schemaName);
    return;
  }
  if (contype === "CONSTR_CHECK") {
    applyCheckConstraint(table, constraint, object);
  }
}

function applyCheckConstraint(table: TableShape, constraint: AstNode, object: SchemaObject): void {
  const expression = asRecord(constraint.raw_expr);
  if (!expression || table.foreign) {
    return;
  }
  table.checkConstraints.push({
    expression,
    name: readString(constraint.conname) ?? object.ref.name,
    skipValidation: constraint.skip_validation === true,
  });
}

function applyPrimaryKeyConstraint(table: TableShape, constraint: AstNode): void {
  const keys = stringList(constraint.keys);
  for (const column of table.columns) {
    if (keys.includes(column.name)) {
      column.notNull = true;
    }
  }
  table.primaryKey = keys;
  table.uniqueColumnSets.push(keys);
}

function applyForeignKeyConstraint(
  table: TableShape,
  constraint: AstNode,
  object: SchemaObject,
  schemaName: string
): void {
  const pkTable = asRecord(constraint.pktable);
  if (!pkTable) {
    return;
  }
  table.relationships.push({
    columns: stringList(constraint.fk_attrs),
    foreignKeyName: readString(constraint.conname) ?? object.ref.name,
    isOneToOne: false,
    referencedColumns: stringList(constraint.pk_attrs),
    referencedRelation: readString(pkTable.relname) ?? "",
    referencedSchema: readString(pkTable.schemaname) ?? schemaName,
  });
}

function resolveRelationshipTargets(tablesByKey: Map<string, TableShape>): void {
  const primaryKeys = new Map<string, string[]>();
  for (const [key, table] of tablesByKey) {
    if (table.primaryKey) {
      primaryKeys.set(key, table.primaryKey);
    }
  }
  for (const table of tablesByKey.values()) {
    for (const relationship of table.relationships) {
      if (relationship.referencedColumns.length === 0) {
        const target = primaryKeys.get(
          `${relationship.referencedSchema}.${relationship.referencedRelation}`
        );
        if (target) {
          relationship.referencedColumns = [...target];
        }
      }
      relationship.isOneToOne = table.uniqueColumnSets.some(
        (set) =>
          set.length === relationship.columns.length &&
          relationship.columns.every((column) => set.includes(column))
      );
    }
  }
}

const numberTypes = new Set([
  "smallint",
  "int2",
  "integer",
  "int",
  "int4",
  "bigint",
  "int8",
  "real",
  "float4",
  "double precision",
  "float8",
  "numeric",
  "decimal",
]);

const stringTypes = new Set([
  "text",
  "character varying",
  "varchar",
  "character",
  "char",
  '"char"',
  "bpchar",
  "uuid",
  "citext",
  "bytea",
  "interval",
  "date",
  "time",
  "timetz",
  "time with time zone",
  "time without time zone",
  "timestamp",
  "timestamptz",
  "timestamp with time zone",
  "timestamp without time zone",
  "vector",
]);
