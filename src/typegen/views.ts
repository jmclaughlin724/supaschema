import {
  asRecord,
  astNodeKind,
  astNodeOf,
  listItems,
  readArray,
  readString,
  stringList,
  typeNameToSql,
} from "../sql/ast.js";
import { parseSqlAst } from "../sql/parser.js";
import type { SchemaObject } from "../types.js";
import type { ColumnShape, FunctionShape, TableShape } from "./model.js";

interface ViewTarget {
  alias?: string;
  expression?: unknown;
  isStar: boolean;
  sourceColumn?: string;
  starQualifier?: string;
}

interface SourceInfo {
  columns: ColumnShape[];
  qualifiedColumns: Map<string, ColumnShape[]>;
}

interface InferenceContext {
  ctes: Map<string, ColumnShape[]>;
  defaultSchema: string;
  fromInfo?: SourceInfo;
  functionsByKey: FunctionShapesByKey;
  outerFromInfo?: SourceInfo;
  tablesByKey: Map<string, TableShape>;
}

export type FunctionShapesByKey = Map<string, FunctionShape[]>;

export function isNonUpdatableViewFunctionCall(functionCall: Record<string, unknown>): boolean {
  const name = stringList(functionCall.funcname).at(-1)?.toLowerCase();
  return (
    functionCall.over !== undefined ||
    functionCall.agg_star === true ||
    functionCall.agg_distinct === true ||
    functionCall.agg_order !== undefined ||
    functionCall.agg_filter !== undefined ||
    functionCall.agg_within_group === true ||
    (name !== undefined && nonUpdatableViewFunctions.has(name))
  );
}

export async function collectUnresolvedViewRelations(
  object: SchemaObject,
  tablesByKey: Map<string, TableShape>
): Promise<string[]> {
  const parsed = await parseSqlAst(object.sql, object.file);
  const unresolved = new Set<string>();
  walkRangeVars(parsed.ast, (schemaName, relname) => {
    if (tablesByKey.has(`${schemaName}.${relname}`)) {
      return;
    }
    if (builtinRelationColumns(schemaName, relname)) {
      return;
    }
    unresolved.add(`${schemaName}.${relname}`);
  });
  return [...unresolved].sort((left, right) => Number(left > right) - Number(left < right));
}

function walkRangeVars(node: unknown, visit: (schemaName: string, relname: string) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      walkRangeVars(item, visit);
    }
    return;
  }
  const record = asRecord(node);
  if (!record) {
    return;
  }
  const rangeVar = asRecord(record.RangeVar);
  if (rangeVar) {
    const schemaName = readString(rangeVar.schemaname);
    const relname = readString(rangeVar.relname);
    if (schemaName && relname) {
      visit(schemaName, relname);
    }
  }
  for (const value of Object.values(record)) {
    walkRangeVars(value, visit);
  }
}

export async function collectViewColumns(
  object: SchemaObject,
  tablesByKey: Map<string, TableShape>,
  functionsByKey: FunctionShapesByKey = new Map()
): Promise<ColumnShape[]> {
  const aliasNames = Array.isArray(object.metadata.viewColumns)
    ? object.metadata.viewColumns.map((value) => String(value))
    : undefined;
  const parsed = await parseSqlAst(object.sql, object.file);
  const select = firstSelect(parsed.ast);
  const expanded = columnsForSelect(
    select,
    object.ref.schema ?? "public",
    tablesByKey,
    functionsByKey
  );
  if (aliasNames) {
    return aliasNames.map((name, index) => {
      const expandedColumn = aliasNames.length === expanded.length ? expanded[index] : undefined;
      return {
        name,
        notNull: expandedColumn?.notNull === true,
        type: expandedColumn?.type ?? "unknown",
      };
    });
  }
  return expanded;
}

function columnsForSelect(
  select: Record<string, unknown> | undefined,
  defaultSchema: string,
  tablesByKey: Map<string, TableShape>,
  functionsByKey: FunctionShapesByKey,
  inheritedCtes: Map<string, ColumnShape[]> = new Map(),
  outerFromInfo?: SourceInfo
): ColumnShape[] {
  if (!select) {
    return [];
  }
  const ctes = collectCteSources(select, defaultSchema, tablesByKey, functionsByKey, inheritedCtes);
  if (readString(select.op) !== "SETOP_NONE" && select.larg !== undefined) {
    return columnsForSetOperation(
      select,
      defaultSchema,
      tablesByKey,
      functionsByKey,
      ctes,
      outerFromInfo
    );
  }
  const fromInfo = collectFromClauseSourceInfo(
    select,
    defaultSchema,
    tablesByKey,
    functionsByKey,
    ctes,
    outerFromInfo
  );
  const targets = readArray(select.targetList).map((target) => parseTarget(target));
  const context: InferenceContext = {
    ctes,
    defaultSchema,
    ...(fromInfo ? { fromInfo } : {}),
    functionsByKey,
    ...(outerFromInfo ? { outerFromInfo } : {}),
    tablesByKey,
  };
  const valuesColumns = columnsForValues(select, context);
  if (valuesColumns) {
    return valuesColumns;
  }
  return targets.flatMap((target) => expandTarget(target, context));
}

function columnsForSetOperation(
  select: Record<string, unknown>,
  defaultSchema: string,
  tablesByKey: Map<string, TableShape>,
  functionsByKey: FunctionShapesByKey,
  inheritedCtes: Map<string, ColumnShape[]>,
  outerFromInfo?: SourceInfo
): ColumnShape[] {
  const left = columnsForSelect(
    selectStatement(select.larg),
    defaultSchema,
    tablesByKey,
    functionsByKey,
    inheritedCtes,
    outerFromInfo
  );
  const right = columnsForSelect(
    selectStatement(select.rarg),
    defaultSchema,
    tablesByKey,
    functionsByKey,
    inheritedCtes,
    outerFromInfo
  );
  return left.map((column, index) => ({
    ...column,
    type: firstResolvedType([column.type, right[index]?.type]) ?? column.type,
  }));
}

function columnsForValues(
  select: Record<string, unknown>,
  context: InferenceContext
): ColumnShape[] | undefined {
  const rows = readArray(select.valuesLists).map((row) => listItems(row));
  if (rows.length === 0) {
    return;
  }
  const width = Math.max(...rows.map((row) => row.length));
  return Array.from({ length: width }, (_, index) => {
    const expressions = rows.flatMap((row) => {
      const expression = row[index];
      return expression === undefined ? [] : [expression];
    });
    return {
      name: `column${index + 1}`,
      notNull: false,
      type: firstKnownType(expressions, context) ?? "unknown",
    };
  });
}

function expandTarget(target: ViewTarget, context: InferenceContext): ColumnShape[] {
  if (target.isStar) {
    return expandStarTarget(target, context.fromInfo);
  }

  const name = target.alias ?? target.sourceColumn ?? expressionColumnName(target.expression);
  if (!name) {
    return [];
  }

  const expressionType = inferExpressionType(target.expression, context);
  const match =
    target.sourceColumn === undefined || !context.fromInfo
      ? undefined
      : findColumn(context.fromInfo, target);
  const type = expressionType && expressionType !== "unknown" ? expressionType : match?.type;
  return [
    {
      name,
      notNull: match?.notNull === true && astNodeKind(target.expression) === "ColumnRef",
      type: type ?? "unknown",
    },
  ];
}

function expandStarTarget(target: ViewTarget, fromInfo: SourceInfo | undefined): ColumnShape[] {
  if (!fromInfo) {
    return [];
  }
  const columns =
    target.starQualifier === undefined
      ? fromInfo.columns
      : fromInfo.qualifiedColumns.get(target.starQualifier);
  if (!columns) {
    return [];
  }
  return columns.map((column) => ({ ...column }));
}

function expressionColumnName(expression: unknown): string | undefined {
  const func = astNodeOf(expression, "FuncCall");
  if (func) {
    return stringList(func.funcname).at(-1);
  }
  const indirection = astNodeOf(expression, "A_Indirection");
  if (indirection) {
    return expressionColumnName(indirection.arg);
  }
  return astNodeKind(expression) === "A_Const" ? "?column?" : undefined;
}

function parseTarget(target: unknown): ViewTarget {
  const resTarget = astNodeOf(target, "ResTarget");
  const columnRef = astNodeOf(resTarget?.val, "ColumnRef");
  const fields = readArray(columnRef?.fields);
  const fieldNames = stringList(columnRef?.fields);
  const lastField = fields.at(-1);
  const isStar = astNodeKind(lastField) === "A_Star";
  const lastName = fieldNames.at(-1);
  const alias = readString(resTarget?.name);
  if (isStar) {
    return {
      isStar: true,
      ...(fieldNames.length > 0 ? { starQualifier: fieldNames.join(".") } : {}),
    };
  }
  return {
    isStar: false,
    ...(alias === undefined ? {} : { alias }),
    ...(resTarget?.val === undefined ? {} : { expression: resTarget.val }),
    ...(lastName === undefined ? {} : { sourceColumn: lastName }),
  };
}

function firstSelect(ast: unknown): Record<string, unknown> | undefined {
  const statements = readArray(asRecord(ast)?.stmts);
  const stmt = asRecord(asRecord(statements[0])?.stmt);
  const view = astNodeOf(stmt, "ViewStmt");
  const tableAs = astNodeOf(stmt, "CreateTableAsStmt");
  return selectStatement(view?.query ?? tableAs?.query);
}

function collectFromClauseSourceInfo(
  select: Record<string, unknown>,
  defaultSchema: string,
  tablesByKey: Map<string, TableShape>,
  functionsByKey: FunctionShapesByKey,
  ctes: Map<string, ColumnShape[]>,
  outerFromInfo?: SourceInfo
): SourceInfo | undefined {
  const fromClause = readArray(select.fromClause);
  if (fromClause.length === 0) {
    return;
  }
  const info: SourceInfo = { columns: [], qualifiedColumns: new Map() };
  for (const item of fromClause) {
    const source = sourceInfoForFromItem(
      item,
      defaultSchema,
      tablesByKey,
      functionsByKey,
      ctes,
      combinedSourceInfo(outerFromInfo, info)
    );
    if (source) {
      mergeSourceInfo(info, source);
    }
  }
  return info.columns.length > 0 ? info : undefined;
}

function collectCteSources(
  select: Record<string, unknown> | undefined,
  defaultSchema: string,
  tablesByKey: Map<string, TableShape>,
  functionsByKey: FunctionShapesByKey,
  inheritedCtes: Map<string, ColumnShape[]>
): Map<string, ColumnShape[]> {
  const ctes = new Map(inheritedCtes);
  for (const item of readArray(asRecord(select?.withClause)?.ctes)) {
    const cte = astNodeOf(item, "CommonTableExpr");
    if (!cte) {
      continue;
    }
    const name = readString(cte?.ctename);
    const query = selectStatement(cte?.ctequery);
    if (!(name && query)) {
      continue;
    }
    const aliasNames = stringList(cte.aliascolnames);
    const columns = applyColumnAliases(
      columnsForSelect(query, defaultSchema, tablesByKey, functionsByKey, ctes),
      aliasNames
    );
    ctes.set(name, columns);
  }
  return ctes;
}

function sourceInfoForFromItem(
  item: unknown,
  defaultSchema: string,
  tablesByKey: Map<string, TableShape>,
  functionsByKey: FunctionShapesByKey,
  ctes: Map<string, ColumnShape[]>,
  outerFromInfo?: SourceInfo
): SourceInfo | undefined {
  const rangeVar = astNodeOf(item, "RangeVar");
  if (rangeVar) {
    return sourceInfoForRangeVar(rangeVar, defaultSchema, tablesByKey, ctes);
  }

  const rangeSubselect = astNodeOf(item, "RangeSubselect");
  if (rangeSubselect) {
    return sourceInfoForRangeSubselect(
      rangeSubselect,
      defaultSchema,
      tablesByKey,
      functionsByKey,
      ctes,
      outerFromInfo
    );
  }

  const rangeFunction = astNodeOf(item, "RangeFunction");
  if (rangeFunction) {
    return sourceInfoForRangeFunction(
      rangeFunction,
      defaultSchema,
      tablesByKey,
      functionsByKey,
      ctes,
      outerFromInfo
    );
  }

  const rangeTableSample = astNodeOf(item, "RangeTableSample");
  if (rangeTableSample) {
    return sourceInfoForRangeTableSample(
      rangeTableSample,
      defaultSchema,
      tablesByKey,
      functionsByKey,
      ctes,
      outerFromInfo
    );
  }

  const join = astNodeOf(item, "JoinExpr");
  if (join) {
    return sourceInfoForJoin(join, defaultSchema, tablesByKey, functionsByKey, ctes, outerFromInfo);
  }
}

function sourceInfoForRangeVar(
  rangeVar: Record<string, unknown>,
  defaultSchema: string,
  tablesByKey: Map<string, TableShape>,
  ctes: Map<string, ColumnShape[]>
): SourceInfo | undefined {
  const relname = readString(rangeVar?.relname);
  if (!relname) {
    return;
  }
  const explicitSchemaName = readString(rangeVar?.schemaname);
  const schemaName = explicitSchemaName ?? defaultSchema;
  const columns =
    explicitSchemaName === undefined
      ? (ctes.get(relname) ??
        tablesByKey.get(`${schemaName}.${relname}`)?.columns ??
        builtinRelationColumns("pg_catalog", relname))
      : (tablesByKey.get(`${schemaName}.${relname}`)?.columns ??
        builtinRelationColumns(schemaName, relname));
  if (!columns) {
    return;
  }
  const aliasName = readString(asRecord(rangeVar.alias)?.aliasname);
  const qualifiedName = `${schemaName}.${relname}`;
  return sourceInfoFromColumns(
    columns,
    aliasName ? [relname, aliasName, qualifiedName] : [relname, qualifiedName]
  );
}

function builtinRelationColumns(schemaName: string, relname: string): ColumnShape[] | undefined {
  if (schemaName === "pg_catalog") {
    return builtinPgCatalogRelations.get(relname);
  }
  if (schemaName === "cron") {
    return builtinPgCronRelations.get(relname);
  }
}

function sourceInfoForRangeSubselect(
  rangeSubselect: Record<string, unknown>,
  defaultSchema: string,
  tablesByKey: Map<string, TableShape>,
  functionsByKey: FunctionShapesByKey,
  ctes: Map<string, ColumnShape[]>,
  outerFromInfo?: SourceInfo
): SourceInfo | undefined {
  const query = selectStatement(rangeSubselect.subquery);
  if (!query) {
    return;
  }
  const alias = asRecord(rangeSubselect.alias);
  const aliasName = readString(alias?.aliasname);
  const columns = applyColumnAliases(
    columnsForSelect(
      query,
      defaultSchema,
      tablesByKey,
      functionsByKey,
      ctes,
      rangeSubselect.lateral === true ? outerFromInfo : undefined
    ),
    stringList(alias?.colnames)
  );
  return sourceInfoFromColumns(columns, aliasName ? [aliasName] : []);
}

function sourceInfoForRangeFunction(
  rangeFunction: Record<string, unknown>,
  defaultSchema: string,
  tablesByKey: Map<string, TableShape>,
  functionsByKey: FunctionShapesByKey,
  ctes: Map<string, ColumnShape[]>,
  outerFromInfo?: SourceInfo
): SourceInfo | undefined {
  const context: InferenceContext = {
    ctes,
    defaultSchema,
    ...(outerFromInfo ? { fromInfo: outerFromInfo, outerFromInfo } : {}),
    functionsByKey,
    tablesByKey,
  };
  const functionColumns = readArray(rangeFunction.functions).flatMap((item) =>
    rangeFunctionColumns(item, context)
  );
  const columns =
    rangeFunction.ordinality === true
      ? [...functionColumns, { name: "ordinality", notNull: false, type: "bigint" }]
      : functionColumns;
  const alias = asRecord(rangeFunction.alias);
  const aliasName = readString(alias?.aliasname);
  return sourceInfoFromColumns(
    applyColumnAliases(columns, stringList(alias?.colnames)),
    aliasName ? [aliasName] : []
  );
}

function sourceInfoForRangeTableSample(
  rangeTableSample: Record<string, unknown>,
  defaultSchema: string,
  tablesByKey: Map<string, TableShape>,
  functionsByKey: FunctionShapesByKey,
  ctes: Map<string, ColumnShape[]>,
  outerFromInfo?: SourceInfo
): SourceInfo | undefined {
  return sourceInfoForFromItem(
    rangeTableSample.relation,
    defaultSchema,
    tablesByKey,
    functionsByKey,
    ctes,
    outerFromInfo
  );
}

function sourceInfoForJoin(
  join: Record<string, unknown>,
  defaultSchema: string,
  tablesByKey: Map<string, TableShape>,
  functionsByKey: FunctionShapesByKey,
  ctes: Map<string, ColumnShape[]>,
  outerFromInfo?: SourceInfo
): SourceInfo | undefined {
  const left = sourceInfoForFromItem(
    join.larg,
    defaultSchema,
    tablesByKey,
    functionsByKey,
    ctes,
    outerFromInfo
  );
  const right = sourceInfoForFromItem(
    join.rarg,
    defaultSchema,
    tablesByKey,
    functionsByKey,
    ctes,
    combinedSourceInfo(outerFromInfo, left)
  );
  const alias = asRecord(join.alias);
  const aliasName = readString(alias?.aliasname);
  if (!left) {
    return aliasName && right
      ? sourceInfoFromColumns(applyColumnAliases(right.columns, stringList(alias?.colnames)), [
          aliasName,
        ])
      : right;
  }
  if (!right) {
    return aliasName
      ? sourceInfoFromColumns(applyColumnAliases(left.columns, stringList(alias?.colnames)), [
          aliasName,
        ])
      : left;
  }
  const usingNames = joinUsingColumnNames(join, left, right);
  const columns = applyColumnAliases(
    usingNames.length > 0
      ? mergedUsingJoinColumns(left.columns, right.columns, usingNames)
      : [...left.columns, ...right.columns],
    stringList(alias?.colnames)
  );
  if (aliasName) {
    return sourceInfoFromColumns(columns, [aliasName]);
  }
  return {
    columns,
    qualifiedColumns: mergedQualifiedColumns(left, right),
  };
}

function joinUsingColumnNames(
  join: Record<string, unknown>,
  left: SourceInfo,
  right: SourceInfo
): string[] {
  const explicit = uniqueStrings(stringList(join.usingClause));
  if (explicit.length > 0) {
    return explicit;
  }
  if (join.isNatural === true) {
    const rightNames = new Set(right.columns.map((column) => column.name));
    return uniqueStrings(
      left.columns.map((column) => column.name).filter((name) => rightNames.has(name))
    );
  }
  return [];
}

function mergedUsingJoinColumns(
  leftColumns: ColumnShape[],
  rightColumns: ColumnShape[],
  usingNames: string[]
): ColumnShape[] {
  const using = new Set(usingNames);
  const leftByName = new Map<string, ColumnShape>();
  const rightByName = new Map<string, ColumnShape>();
  for (const column of leftColumns) {
    leftByName.set(column.name, column);
  }
  for (const column of rightColumns) {
    rightByName.set(column.name, column);
  }
  const merged: ColumnShape[] = [];
  for (const name of usingNames) {
    const column = leftByName.get(name) ?? rightByName.get(name);
    if (column) {
      merged.push(column);
    }
  }
  return [
    ...merged,
    ...leftColumns.filter((column) => !using.has(column.name)),
    ...rightColumns.filter((column) => !using.has(column.name)),
  ];
}

function sourceInfoFromColumns(columns: ColumnShape[], names: string[]): SourceInfo | undefined {
  if (columns.length === 0) {
    return;
  }
  const qualifiedColumns = new Map<string, ColumnShape[]>();
  for (const name of names) {
    setQualifiedColumns(qualifiedColumns, name, columns);
  }
  return { columns: [...columns], qualifiedColumns };
}

function mergeSourceInfo(target: SourceInfo, source: SourceInfo): void {
  target.columns.push(...source.columns);
  for (const [name, columns] of source.qualifiedColumns) {
    setQualifiedColumns(target.qualifiedColumns, name, columns);
  }
}

function mergedQualifiedColumns(...sources: SourceInfo[]): Map<string, ColumnShape[]> {
  const qualifiedColumns = new Map<string, ColumnShape[]>();
  for (const source of sources) {
    for (const [name, columns] of source.qualifiedColumns) {
      setQualifiedColumns(qualifiedColumns, name, columns);
    }
  }
  return qualifiedColumns;
}

function combinedSourceInfo(...sources: (SourceInfo | undefined)[]): SourceInfo | undefined {
  const info: SourceInfo = { columns: [], qualifiedColumns: new Map() };
  for (const source of sources) {
    if (source) {
      mergeSourceInfo(info, source);
    }
  }
  return info.columns.length > 0 ? info : undefined;
}

function setQualifiedColumns(
  qualifiedColumns: Map<string, ColumnShape[]>,
  name: string,
  columns: ColumnShape[]
): void {
  const existing = qualifiedColumns.get(name);
  if (existing === undefined) {
    qualifiedColumns.set(name, columns);
    return;
  }
  if (existing !== columns) {
    qualifiedColumns.set(name, []);
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function applyColumnAliases(columns: ColumnShape[], aliasNames: string[]): ColumnShape[] {
  if (aliasNames.length === 0) {
    return columns;
  }
  return columns.map((column, index) => ({
    ...column,
    name: aliasNames[index] ?? column.name,
  }));
}

function rangeFunctionColumns(item: unknown, context: InferenceContext): ColumnShape[] {
  const func = astNodeOf(listItems(item)[0], "FuncCall");
  if (!func) {
    return [];
  }
  const parts = stringList(func.funcname);
  const fallbackName = parts.at(-1) ?? "value";
  const returns = matchingFunctionReturn(func, context);
  if (returns?.columns) {
    return returns.columns.map((column) => ({ ...column, notNull: false }));
  }
  const type = returns?.type ?? functionReturnType(func, context);
  return type ? [{ name: fallbackName, notNull: false, type }] : [];
}

function findColumn(fromInfo: SourceInfo, target: ViewTarget): ColumnShape | undefined {
  if (!target.sourceColumn) {
    return;
  }
  if (target.starQualifier) {
    return fromInfo.qualifiedColumns
      .get(target.starQualifier)
      ?.find((column) => column.name === target.sourceColumn);
  }
  const matches = fromInfo.columns.filter((column) => column.name === target.sourceColumn);
  return matches.length === 1 ? matches[0] : undefined;
}

function inferExpressionType(expression: unknown, context: InferenceContext): string | undefined {
  switch (astNodeKind(expression)) {
    case "A_ArrayExpr": {
      const array = astNodeOf(expression, "A_ArrayExpr");
      const elementType = firstKnownType(readArray(array?.elements), context);
      return elementType ? `${elementType}[]` : undefined;
    }
    case "A_Expr": {
      const expr = astNodeOf(expression, "A_Expr");
      return expr ? aExprType(expr, context) : undefined;
    }
    case "A_Indirection": {
      const indirection = astNodeOf(expression, "A_Indirection");
      return indirectionType(indirection, context);
    }
    case "BoolExpr":
    case "BooleanTest":
    case "NullTest":
      return "boolean";
    case "CaseExpr": {
      const caseExpr = astNodeOf(expression, "CaseExpr");
      const results = readArray(caseExpr?.args).flatMap((item) => {
        const result = astNodeOf(item, "CaseWhen")?.result;
        return result === undefined ? [] : [result];
      });
      if (caseExpr?.defresult !== undefined) {
        results.push(caseExpr.defresult);
      }
      return firstKnownType(results, context);
    }
    case "CoalesceExpr": {
      const coalesce = astNodeOf(expression, "CoalesceExpr");
      return firstKnownType(readArray(coalesce?.args), context);
    }
    case "ColumnRef": {
      const columnRef = astNodeOf(expression, "ColumnRef");
      return columnRef ? columnRefType(columnRef, context) : undefined;
    }
    case "A_Const": {
      const constant = astNodeOf(expression, "A_Const");
      return constantType(constant);
    }
    case "FuncCall": {
      const func = astNodeOf(expression, "FuncCall");
      return func ? functionReturnType(func, context) : undefined;
    }
    case "MinMaxExpr": {
      const minMax = astNodeOf(expression, "MinMaxExpr");
      return firstKnownType(readArray(minMax?.args), context);
    }
    case "SQLValueFunction": {
      const valueFunction = astNodeOf(expression, "SQLValueFunction");
      return sqlValueFunctionType(valueFunction);
    }
    case "SubLink": {
      const subLink = astNodeOf(expression, "SubLink");
      return subLink ? subLinkType(subLink, context) : undefined;
    }
    case "TypeCast": {
      const typeCast = astNodeOf(expression, "TypeCast");
      return typeCast ? typeNameToSql(typeCast.typeName) : undefined;
    }
    default:
      return;
  }
}

function columnRefType(
  columnRef: Record<string, unknown>,
  context: InferenceContext
): string | undefined {
  const fromInfo = context.fromInfo;
  const fields = stringList(columnRef.fields);
  const columnName = fields.at(-1);
  if (!columnName) {
    return;
  }
  if (fields.length > 1) {
    const qualifier = fields.slice(0, -1).join(".");
    const localColumns = fromInfo?.qualifiedColumns.get(String(qualifier));
    if (localColumns) {
      return localColumns.find((column) => column.name === columnName)?.type;
    }
    return context.outerFromInfo?.qualifiedColumns
      .get(String(qualifier))
      ?.find((column) => column.name === columnName)?.type;
  }
  const localMatches = fromInfo?.columns.filter((column) => column.name === columnName);
  if (localMatches && localMatches.length > 0) {
    return localMatches.length === 1 ? localMatches[0]?.type : undefined;
  }
  const outerMatches = context.outerFromInfo?.columns.filter(
    (column) => column.name === columnName
  );
  return outerMatches?.length === 1 ? outerMatches[0]?.type : undefined;
}

function firstKnownType(expressions: unknown[], context: InferenceContext): string | undefined {
  for (const expression of expressions) {
    const type = inferExpressionType(expression, context);
    if (type && type !== "unknown") {
      return type;
    }
  }
}

function firstResolvedType(types: (string | undefined)[]): string | undefined {
  return types.find((type) => type !== undefined && type !== "unknown");
}

function indirectionType(
  indirection: Record<string, unknown> | undefined,
  context: InferenceContext
): string | undefined {
  const baseType = inferExpressionType(indirection?.arg, context);
  if (!baseType) {
    return;
  }
  return readArray(indirection?.indirection).some((item) => astNodeOf(item, "A_Indices"))
    ? (arrayElementType(baseType) ?? baseType)
    : baseType;
}

function constantType(constant: Record<string, unknown> | undefined): string | undefined {
  if (!constant) {
    return;
  }
  if (asRecord(constant.boolval) !== undefined) {
    return "boolean";
  }
  if (asRecord(constant.ival) !== undefined) {
    return "integer";
  }
  if (asRecord(constant.fval) !== undefined) {
    return "numeric";
  }
  if (asRecord(constant.sval) !== undefined) {
    return "text";
  }
}

function sqlValueFunctionType(
  valueFunction: Record<string, unknown> | undefined
): string | undefined {
  switch (readString(valueFunction?.op)) {
    case "SVFOP_CURRENT_DATE":
      return "date";
    case "SVFOP_CURRENT_TIME":
    case "SVFOP_CURRENT_TIME_N":
      return "time with time zone";
    case "SVFOP_CURRENT_TIMESTAMP":
    case "SVFOP_CURRENT_TIMESTAMP_N":
      return "timestamp with time zone";
    case "SVFOP_CURRENT_USER":
    case "SVFOP_SESSION_USER":
    case "SVFOP_USER":
      return "text";
    default:
      return;
  }
}

function aExprType(expr: Record<string, unknown>, context: InferenceContext): string | undefined {
  if (expr.kind === "AEXPR_NULLIF") {
    return inferExpressionType(expr.lexpr, context);
  }
  const operator = stringList(expr.name).at(-1);
  if (operator === "->>" || operator === "#>>") {
    return "text";
  }
  if (operator === "->" || operator === "#>") {
    return "jsonb";
  }
  if (operator === "||") {
    const left = inferExpressionType(expr.lexpr, context);
    const right = inferExpressionType(expr.rexpr, context);
    return concatExpressionType(left, right);
  }
  if (operator && arithmeticOperators.has(operator)) {
    const left = inferExpressionType(expr.lexpr, context);
    const right = inferExpressionType(expr.rexpr, context);
    if (
      left &&
      right &&
      numericTypes.has(normalizeSqlType(left)) &&
      numericTypes.has(normalizeSqlType(right))
    ) {
      return firstResolvedType([left, right]);
    }
    return;
  }
  if (operator && booleanOperators.has(operator)) {
    return "boolean";
  }
  if (booleanExpressionKinds.has(readString(expr.kind) ?? "")) {
    return "boolean";
  }
}

function subLinkType(link: Record<string, unknown>, context: InferenceContext): string | undefined {
  const kind = readString(link.subLinkType) ?? "";
  if (booleanSubLinkTypes.has(kind)) {
    return "boolean";
  }
  const query = selectStatement(link.subselect);
  if (!query) {
    return;
  }
  const firstColumn = columnsForSelect(
    query,
    context.defaultSchema,
    context.tablesByKey,
    context.functionsByKey,
    context.ctes,
    combinedSourceInfo(context.outerFromInfo, context.fromInfo)
  ).at(0);
  if (!(firstColumn?.type && firstColumn.type !== "unknown")) {
    return;
  }
  if (kind === "ARRAY_SUBLINK") {
    return `${firstColumn.type}[]`;
  }
  return kind === "EXPR_SUBLINK" ? firstColumn.type : undefined;
}

function functionReturnType(
  func: Record<string, unknown>,
  context: InferenceContext
): string | undefined {
  const parts = stringList(func.funcname);
  if (parts.length === 0) {
    return;
  }
  const name = parts.join(".");
  const modeledReturn = matchingFunctionReturn(func, context);
  if (modeledReturn && modeledReturn.columns === undefined) {
    return modeledReturn.type;
  }
  const argTypes = readArray(func.args).map((arg) => inferExpressionType(arg, context));
  const visibleFunctions = visibleFunctionShapes(parts, context);
  if (parts.length > 1 || visibleFunctions.length > 0) {
    return;
  }
  const builtin = builtinFunctionReturnType(name, argTypes, func, context);
  if (builtin) {
    return builtin;
  }
  return functionTypeMap.get(name);
}

function matchingFunctionReturn(
  func: Record<string, unknown>,
  context: InferenceContext
): FunctionShape["returns"] | undefined {
  const parts = stringList(func.funcname);
  const argTypes = readArray(func.args).map((arg) => inferExpressionType(arg, context));
  const visibleFunctions = visibleFunctionShapes(parts, context);
  for (const fn of visibleFunctions) {
    if (!fn.returns) {
      continue;
    }
    if (functionArgsMatch(fn.args, argTypes)) {
      return fn.returns;
    }
  }
}

function visibleFunctionShapes(parts: string[], context: InferenceContext): FunctionShape[] {
  const name = parts.join(".");
  return parts.length === 1
    ? (context.functionsByKey.get(`${context.defaultSchema}.${name}`) ?? [])
    : (context.functionsByKey.get(name) ?? []);
}

function builtinFunctionReturnType(
  name: string,
  argTypes: (string | undefined)[],
  func: Record<string, unknown>,
  context: InferenceContext
): string | undefined {
  if (arrayReturnFunctions.has(name)) {
    return argTypes[0] ? `${argTypes[0]}[]` : undefined;
  }
  if (name === "enum_range") {
    return argTypes[0] ? `${argTypes[0]}[]` : undefined;
  }
  if (firstArgumentReturnFunctions.has(name)) {
    return argTypes[0];
  }
  if (firstResolvedReturnFunctions.has(name)) {
    return firstResolvedType(argTypes);
  }
  const fixedType = fixedBuiltinFunctionTypes.get(name);
  if (fixedType) {
    return fixedType;
  }
  if (orderedSetReturnFunctions.has(name)) {
    return orderedSetReturnType(func, context) ?? argTypes[0];
  }
  if (name === "round") {
    return firstResolvedType(argTypes) ?? "numeric";
  }
  if (name === "unnest") {
    return arrayElementType(argTypes[0]);
  }
}

function orderedSetReturnType(
  func: Record<string, unknown>,
  context: InferenceContext
): string | undefined {
  for (const item of readArray(func.agg_order)) {
    const sortBy = astNodeOf(item, "SortBy");
    const type = inferExpressionType(sortBy?.node, context);
    if (type && type !== "unknown") {
      return type;
    }
  }
}

function arrayElementType(type: string | undefined): string | undefined {
  return type?.endsWith("[]") ? type.slice(0, -2) : undefined;
}

function firstTextType(types: (string | undefined)[]): string | undefined {
  return types.find((type) => type !== undefined && normalizeSqlType(type) === "text");
}

function concatExpressionType(left: string | undefined, right: string | undefined): string {
  if (left !== undefined && arrayElementType(left) && left === right) {
    return left;
  }
  if (isJsonType(left) && isJsonType(right)) {
    return "jsonb";
  }
  return firstTextType([left, right]) ?? "text";
}

function isJsonType(type: string | undefined): boolean {
  return type !== undefined && ["json", "jsonb"].includes(normalizeSqlType(type));
}

function functionArgsMatch(args: FunctionShape["args"], argTypes: (string | undefined)[]): boolean {
  const requiredArgs = args.filter((arg) => !arg.optional).length;
  if (argTypes.length < requiredArgs || argTypes.length > args.length) {
    return false;
  }
  return argTypes.every((argType, index) => {
    const expected = args[index]?.type;
    return (
      argType !== undefined &&
      argType !== "unknown" &&
      expected !== undefined &&
      sqlTypesCompatible(argType, expected)
    );
  });
}

function sqlTypesCompatible(actual: string, expected: string): boolean {
  const normalizedActual = normalizeSqlType(actual);
  const normalizedExpected = normalizeSqlType(expected);
  return (
    normalizedActual === normalizedExpected ||
    (normalizedExpected === "numeric" && numericTypes.has(normalizedActual))
  );
}

function normalizeSqlType(type: string): string {
  return type.toLowerCase();
}

function selectStatement(value: unknown): Record<string, unknown> | undefined {
  const wrapped = astNodeOf(value, "SelectStmt");
  if (wrapped) {
    return wrapped;
  }
  const record = asRecord(value);
  return record &&
    (record.targetList !== undefined ||
      record.fromClause !== undefined ||
      record.valuesLists !== undefined ||
      record.op !== undefined)
    ? record
    : undefined;
}

const booleanSubLinkTypes = new Set([
  "ALL_SUBLINK",
  "ANY_SUBLINK",
  "EXISTS_SUBLINK",
  "ROWCOMPARE_SUBLINK",
]);

const booleanOperators = new Set([
  "=",
  "<>",
  "!=",
  "<",
  ">",
  "<=",
  ">=",
  "~~",
  "!~~",
  "~~*",
  "!~~*",
]);

const arithmeticOperators = new Set(["+", "-", "*", "/", "%"]);

const booleanExpressionKinds = new Set([
  "AEXPR_BETWEEN",
  "AEXPR_BETWEEN_SYM",
  "AEXPR_DISTINCT",
  "AEXPR_ILIKE",
  "AEXPR_IN",
  "AEXPR_LIKE",
  "AEXPR_NOT_BETWEEN",
  "AEXPR_NOT_BETWEEN_SYM",
  "AEXPR_NOT_DISTINCT",
  "AEXPR_OP_ALL",
  "AEXPR_OP_ANY",
  "AEXPR_SIMILAR",
]);

const numericTypes = new Set([
  "bigint",
  "double precision",
  "integer",
  "numeric",
  "real",
  "smallint",
]);

const builtinPgCatalogRelations = new Map<string, ColumnShape[]>([
  [
    "pg_class",
    [
      { name: "oid", notNull: false, type: "oid" },
      { name: "relname", notNull: false, type: "name" },
      { name: "relnamespace", notNull: false, type: "oid" },
      { name: "relkind", notNull: false, type: '"char"' },
    ],
  ],
  [
    "pg_depend",
    [
      { name: "objid", notNull: false, type: "oid" },
      { name: "refobjid", notNull: false, type: "oid" },
      { name: "deptype", notNull: false, type: '"char"' },
    ],
  ],
  [
    "pg_enum",
    [
      { name: "enumtypid", notNull: false, type: "oid" },
      { name: "enumlabel", notNull: false, type: "name" },
      { name: "enumsortorder", notNull: false, type: "real" },
    ],
  ],
  [
    "pg_namespace",
    [
      { name: "oid", notNull: false, type: "oid" },
      { name: "nspname", notNull: false, type: "name" },
    ],
  ],
  [
    "pg_proc",
    [
      { name: "oid", notNull: false, type: "oid" },
      { name: "proname", notNull: false, type: "name" },
      { name: "pronamespace", notNull: false, type: "oid" },
      { name: "provolatile", notNull: false, type: '"char"' },
      { name: "prosecdef", notNull: false, type: "boolean" },
    ],
  ],
  [
    "pg_trigger",
    [
      { name: "oid", notNull: false, type: "oid" },
      { name: "tgrelid", notNull: false, type: "oid" },
      { name: "tgname", notNull: false, type: "name" },
      { name: "tgfoid", notNull: false, type: "oid" },
      { name: "tgisinternal", notNull: false, type: "boolean" },
      { name: "tgenabled", notNull: false, type: '"char"' },
    ],
  ],
  [
    "pg_type",
    [
      { name: "oid", notNull: false, type: "oid" },
      { name: "typname", notNull: false, type: "name" },
      { name: "typnamespace", notNull: false, type: "oid" },
      { name: "typtype", notNull: false, type: '"char"' },
    ],
  ],
]);

const builtinPgCronRelations = new Map<string, ColumnShape[]>([
  [
    "job",
    [
      { name: "jobid", notNull: false, type: "bigint" },
      { name: "schedule", notNull: false, type: "text" },
      { name: "command", notNull: false, type: "text" },
      { name: "nodename", notNull: false, type: "text" },
      { name: "nodeport", notNull: false, type: "integer" },
      { name: "database", notNull: false, type: "text" },
      { name: "username", notNull: false, type: "text" },
      { name: "active", notNull: false, type: "boolean" },
      { name: "jobname", notNull: false, type: "text" },
    ],
  ],
  [
    "job_run_details",
    [
      { name: "jobid", notNull: false, type: "bigint" },
      { name: "runid", notNull: false, type: "bigint" },
      { name: "job_pid", notNull: false, type: "integer" },
      { name: "database", notNull: false, type: "text" },
      { name: "username", notNull: false, type: "text" },
      { name: "command", notNull: false, type: "text" },
      { name: "status", notNull: false, type: "text" },
      { name: "return_message", notNull: false, type: "text" },
      { name: "start_time", notNull: false, type: "timestamp with time zone" },
      { name: "end_time", notNull: false, type: "timestamp with time zone" },
    ],
  ],
]);

const arrayReturnFunctions = new Set(["array_agg", "array_fill"]);

const firstArgumentReturnFunctions = new Set([
  "first_value",
  "generate_series",
  "lag",
  "last_value",
  "lead",
  "max",
  "min",
]);

const firstResolvedReturnFunctions = new Set(["greatest", "least", "nullif"]);

const orderedSetReturnFunctions = new Set(["percentile_cont", "percentile_disc"]);

const fixedBuiltinFunctionTypes = new Map([
  ["avg", "numeric"],
  ["concat", "text"],
  ["concat_ws", "text"],
  ["format", "text"],
  ["json_agg", "json"],
  ["json_array_elements", "json"],
  ["json_array_elements_text", "text"],
  ["json_array_length", "integer"],
  ["json_build_array", "json"],
  ["json_build_object", "json"],
  ["jsonb_agg", "jsonb"],
  ["jsonb_array_elements", "jsonb"],
  ["jsonb_array_elements_text", "text"],
  ["jsonb_array_length", "integer"],
  ["jsonb_build_array", "jsonb"],
  ["jsonb_build_object", "jsonb"],
  ["replace", "text"],
  ["split_part", "text"],
  ["substr", "text"],
  ["substring", "text"],
  ["sum", "numeric"],
]);

const functionTypeMap = new Map([
  ["array_length", "integer"],
  ["btrim", "text"],
  ["cardinality", "integer"],
  ["communication_channel_or_null", "platform.communication_channel"],
  ["concat", "text"],
  ["concat_ws", "text"],
  ["count", "bigint"],
  ["lower", "text"],
  ["ltrim", "text"],
  ["row_number", "bigint"],
  ["rtrim", "text"],
  ["safe_bigint_from_jsonb", "bigint"],
  ["safe_numeric_from_jsonb", "numeric"],
  ["safe_timestamptz_from_jsonb", "timestamp with time zone"],
  ["safe_uuid_from_jsonb", "uuid"],
  ["trim", "text"],
  ["upper", "text"],
]);

const nonUpdatableViewFunctions = new Set([
  "array_agg",
  "avg",
  "bit_and",
  "bit_or",
  "bool_and",
  "bool_or",
  "count",
  "every",
  "generate_series",
  "generate_subscripts",
  "json_agg",
  "json_array_elements",
  "json_array_elements_text",
  "json_each",
  "json_each_text",
  "json_object_agg",
  "json_object_keys",
  "jsonb_agg",
  "jsonb_array_elements",
  "jsonb_array_elements_text",
  "jsonb_each",
  "jsonb_each_text",
  "jsonb_object_agg",
  "jsonb_object_keys",
  "max",
  "min",
  "percentile_cont",
  "percentile_disc",
  "regexp_matches",
  "regexp_split_to_table",
  "string_agg",
  "sum",
  "unnest",
  "xmlagg",
]);
