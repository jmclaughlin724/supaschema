import type {
  ColumnShape,
  FunctionArgShape,
  FunctionShape,
  RelationshipShape,
  SchemaEntry,
  SchemaShapes,
} from "./model.js";
import {
  chaseColumnType,
  computedRelationshipFunctions,
  functionReturnsMultipleRows,
  isDeclaredDomainType,
  isNonWritableColumn,
  isOptionalInsertColumn,
  sortedByName,
} from "./model.js";

export interface GenerateDatabaseTypesOptions {
  postgrestVersion?: string;
}

export function generateDatabaseTypes(
  shapes: SchemaShapes,
  options: GenerateDatabaseTypesOptions = {}
): string {
  const schemas = [...shapes.schemas.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  );
  const lines = [
    "export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];",
    "",
    "export type Database = {",
  ];
  if (options.postgrestVersion) {
    lines.push(
      "  __InternalSupabase: {",
      `    PostgrestVersion: ${quoteCodeString(options.postgrestVersion)};`,
      "  };"
    );
  }
  for (const [schema, entry] of schemas) {
    emitDatabaseSchema(lines, shapes, schema, entry);
  }
  lines.push("};", "");
  emitHelperTypes(lines);
  emitConstants(lines, schemas);
  return `${lines.join("\n")}\n`;
}

function emitDatabaseSchema(
  lines: string[],
  shapes: SchemaShapes,
  schema: string,
  entry: SchemaEntry
): void {
  lines.push(`  ${quoteKey(schema)}: {`);
  emitTables(lines, shapes, schema, entry);
  emitViews(lines, shapes, schema, entry);
  emitFunctions(lines, shapes, schema, entry);
  emitEnums(lines, entry);
  emitCompositeTypes(lines, shapes, schema, entry);
  lines.push("  };");
}

function emitTables(
  lines: string[],
  shapes: SchemaShapes,
  schema: string,
  entry: SchemaEntry
): void {
  lines.push("    Tables: {");
  const tables = sortedByName(entry.tables);
  if (tables.length === 0) {
    lines.push("      [_ in never]: never;");
  } else {
    for (const table of tables) {
      const typeOf = (sqlType: string) => tsType(shapes, schema, sqlType);
      lines.push(`      ${quoteKey(table.name)}: {`, "        Row: {");
      for (const column of table.columns) {
        lines.push(
          `          ${quoteKey(column.name)}: ${nullable(typeOf(column.type), !column.notNull)};`
        );
      }
      for (const field of computedRelationshipFields(shapes, schema, entry, table.name)) {
        lines.push(`          ${quoteKey(field.name)}: ${nullable(field.type, true)};`);
      }
      lines.push("        };", "        Insert: {");
      for (const column of table.columns) {
        lines.push(`          ${insertField(column, typeOf)}`);
      }
      lines.push("        };", "        Update: {");
      for (const column of table.columns) {
        lines.push(`          ${updateField(column, typeOf)}`);
      }
      lines.push(
        "        };",
        `        Relationships: ${renderRelationships(
          table.relationships.filter((relationship) => relationship.referencedSchema === schema)
        )};`,
        "      };"
      );
    }
  }
  lines.push("    };");
}

function emitViews(
  lines: string[],
  shapes: SchemaShapes,
  schema: string,
  entry: SchemaEntry
): void {
  lines.push("    Views: {");
  const views = sortedByName(entry.views);
  if (views.length === 0) {
    lines.push("      [_ in never]: never;");
  } else {
    for (const view of views) {
      emitView(lines, shapes, schema, entry, view);
    }
  }
  lines.push("    };");
}

function emitView(
  lines: string[],
  shapes: SchemaShapes,
  schema: string,
  entry: SchemaEntry,
  view: SchemaEntry["views"][number]
): void {
  const typeOf = (sqlType: string) => tsType(shapes, schema, sqlType);
  lines.push(`      ${quoteKey(view.name)}: {`, "        Row: {");
  for (const column of view.columns) {
    lines.push(
      `          ${quoteKey(column.name)}: ${nullable(typeOf(column.type), !column.notNull)};`
    );
  }
  for (const field of computedRelationshipFields(shapes, schema, entry, view.name)) {
    lines.push(`          ${quoteKey(field.name)}: ${nullable(field.type, true)};`);
  }
  lines.push("        };");
  if (view.updatable) {
    lines.push("        Insert: {");
    for (const column of view.columns) {
      lines.push(`          ${viewInsertField(column, typeOf)}`);
    }
    lines.push("        };", "        Update: {");
    for (const column of view.columns) {
      lines.push(`          ${viewUpdateField(column, typeOf)}`);
    }
    lines.push("        };");
  }
  lines.push(`        Relationships: ${renderRelationships(view.relationships)};`, "      };");
}

function emitFunctions(
  lines: string[],
  shapes: SchemaShapes,
  schema: string,
  entry: SchemaEntry
): void {
  lines.push("    Functions: {");
  const functions = groupedFunctions(entry.functions).filter(([, overloads]) =>
    overloads.some((fn) => isPostgrestVisibleFunction(shapes, schema, fn))
  );
  if (functions.length === 0) {
    lines.push("      [_ in never]: never;");
  } else {
    for (const [name, overloads] of functions) {
      const visible = overloads.filter((fn) => isPostgrestVisibleFunction(shapes, schema, fn));
      lines.push(`      ${quoteKey(name)}: ${renderFunctionSignatures(shapes, schema, visible)};`);
    }
  }
  lines.push("    };");
}

function emitEnums(lines: string[], entry: SchemaEntry): void {
  lines.push("    Enums: {");
  const enums = sortedByName(entry.enums);
  if (enums.length === 0) {
    lines.push("      [_ in never]: never;");
  } else {
    for (const item of enums) {
      const union = item.values.map(quoteCodeString).join(" | ");
      lines.push(`      ${quoteKey(item.name)}: ${union.length > 0 ? union : "never"};`);
    }
  }
  lines.push("    };");
}

function emitCompositeTypes(
  lines: string[],
  shapes: SchemaShapes,
  schema: string,
  entry: SchemaEntry
): void {
  lines.push("    CompositeTypes: {");
  const composites = sortedByName(entry.composites);
  if (composites.length === 0) {
    lines.push("      [_ in never]: never;");
  } else {
    const typeOf = (sqlType: string) => tsType(shapes, schema, sqlType);
    for (const composite of composites) {
      lines.push(`      ${quoteKey(composite.name)}: {`);
      for (const column of composite.columns) {
        lines.push(`        ${quoteKey(column.name)}: ${nullable(typeOf(column.type), true)};`);
      }
      lines.push("      };");
    }
  }
  lines.push("    };");
}

function emitHelperTypes(lines: string[]): void {
  lines.push(
    'type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;',
    "",
    'type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];',
    "",
    "export type Tables<",
    "  DefaultSchemaTableNameOrOptions extends",
    '    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])',
    "    | { schema: keyof DatabaseWithoutInternals },",
    "  TableName extends DefaultSchemaTableNameOrOptions extends {",
    "    schema: keyof DatabaseWithoutInternals;",
    "  }",
    '    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &',
    '        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])',
    "    : never = never,",
    "> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }",
    '  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &',
    '      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {',
    "      Row: infer R;",
    "    }",
    "    ? R",
    "    : never",
    '  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])',
    '    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {',
    "        Row: infer R;",
    "      }",
    "      ? R",
    "      : never",
    "    : never;",
    "",
    "export type TablesInsert<",
    "  DefaultSchemaTableNameOrOptions extends",
    '    | keyof DefaultSchema["Tables"]',
    "    | { schema: keyof DatabaseWithoutInternals },",
    "  TableName extends DefaultSchemaTableNameOrOptions extends {",
    "    schema: keyof DatabaseWithoutInternals;",
    "  }",
    '    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]',
    "    : never = never,",
    "> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }",
    '  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {',
    "      Insert: infer I;",
    "    }",
    "    ? I",
    "    : never",
    '  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]',
    '    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {',
    "        Insert: infer I;",
    "      }",
    "      ? I",
    "      : never",
    "    : never;",
    "",
    "export type TablesUpdate<",
    "  DefaultSchemaTableNameOrOptions extends",
    '    | keyof DefaultSchema["Tables"]',
    "    | { schema: keyof DatabaseWithoutInternals },",
    "  TableName extends DefaultSchemaTableNameOrOptions extends {",
    "    schema: keyof DatabaseWithoutInternals;",
    "  }",
    '    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]',
    "    : never = never,",
    "> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }",
    '  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {',
    "      Update: infer U;",
    "    }",
    "    ? U",
    "    : never",
    '  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]',
    '    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {',
    "        Update: infer U;",
    "      }",
    "      ? U",
    "      : never",
    "    : never;",
    "",
    "export type Enums<",
    "  DefaultSchemaEnumNameOrOptions extends",
    '    | keyof DefaultSchema["Enums"]',
    "    | { schema: keyof DatabaseWithoutInternals },",
    "  EnumName extends DefaultSchemaEnumNameOrOptions extends {",
    "    schema: keyof DatabaseWithoutInternals;",
    "  }",
    '    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]',
    "    : never = never,",
    "> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }",
    '  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]',
    '  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]',
    '    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]',
    "    : never;",
    "",
    "export type CompositeTypes<",
    "  PublicCompositeTypeNameOrOptions extends",
    '    | keyof DefaultSchema["CompositeTypes"]',
    "    | { schema: keyof DatabaseWithoutInternals },",
    "  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {",
    "    schema: keyof DatabaseWithoutInternals;",
    "  }",
    '    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]',
    "    : never = never,",
    "> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }",
    '  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]',
    '  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]',
    '    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]',
    "    : never;",
    ""
  );
}

function emitConstants(lines: string[], schemas: [string, SchemaEntry][]): void {
  lines.push("export const Constants = {");
  for (const [schema, entry] of schemas) {
    lines.push(`  ${quoteKey(schema)}: {`, "    Enums: {");
    for (const item of sortedByName(entry.enums)) {
      lines.push(`      ${quoteKey(item.name)}: [${item.values.map(quoteCodeString).join(", ")}],`);
    }
    lines.push("    },", "  },");
  }
  lines.push("} as const;");
}

function tsType(shapes: SchemaShapes, schema: string, sqlType: string): string {
  const resolved = chaseColumnType(shapes, schema, sqlType);
  let mapped: string;
  if (resolved.kind === "enum" && resolved.enumRef) {
    mapped = databasePath(resolved.enumRef.schema, "Enums", resolved.enumRef.name);
  } else if (resolved.kind === "composite" && resolved.compositeRef) {
    mapped = databasePath(
      resolved.compositeRef.schema,
      "CompositeTypes",
      resolved.compositeRef.name
    );
  } else if (resolved.kind === "relation" && resolved.relationRef) {
    mapped = `${databasePath(resolved.relationRef.schema, resolved.relationRef.collection, resolved.relationRef.name)}["Row"]`;
  } else if (resolved.kind === "json") {
    mapped = "Json";
  } else if (resolved.kind === "record") {
    mapped = "Record<string, unknown>";
  } else if (resolved.kind === "void") {
    mapped = "undefined";
  } else if (resolved.kind === "unknown") {
    mapped = "unknown";
  } else {
    mapped = resolved.kind;
  }
  return mapped + "[]".repeat(resolved.arrayDepth);
}

function databasePath(schema: string, collection: string, name: string): string {
  return `Database[${quoteCodeString(schema)}][${quoteCodeString(collection)}][${quoteCodeString(name)}]`;
}

function nullable(type: string, isNullable: boolean): string {
  if (!isNullable || type === "unknown" || type === "any") {
    return type;
  }
  return `${type} | null`;
}

function insertField(column: ColumnShape, typeOf: (sqlType: string) => string): string {
  if (isNonWritableColumn(column)) {
    return `${quoteKey(column.name)}?: never;`;
  }
  const base = typeOf(column.type);
  const type = nullable(base, !column.notNull);
  return `${quoteKey(column.name)}${isOptionalInsertColumn(column) ? "?" : ""}: ${type};`;
}

function updateField(column: ColumnShape, typeOf: (sqlType: string) => string): string {
  if (isNonWritableColumn(column)) {
    return `${quoteKey(column.name)}?: never;`;
  }
  return `${quoteKey(column.name)}?: ${nullable(typeOf(column.type), !column.notNull)};`;
}

function viewInsertField(column: ColumnShape, typeOf: (sqlType: string) => string): string {
  if (!column.updatable) {
    return `${quoteKey(column.name)}?: never;`;
  }
  return `${quoteKey(column.name)}?: ${nullable(typeOf(column.type), true)};`;
}

function viewUpdateField(column: ColumnShape, typeOf: (sqlType: string) => string): string {
  if (!column.updatable) {
    return `${quoteKey(column.name)}?: never;`;
  }
  return `${quoteKey(column.name)}?: ${nullable(typeOf(column.type), true)};`;
}

function groupedFunctions(functions: FunctionShape[]): [string, FunctionShape[]][] {
  const grouped = new Map<string, FunctionShape[]>();
  for (const fn of functions) {
    const overloads = grouped.get(fn.name) ?? [];
    overloads.push(fn);
    grouped.set(fn.name, overloads);
  }
  return [...grouped.entries()]
    .map(sortFunctionOverloads)
    .sort(([left], [right]) => left.localeCompare(right));
}

function sortFunctionOverloads([name, overloads]: [string, FunctionShape[]]): [
  string,
  FunctionShape[],
] {
  return [name, [...overloads].sort(compareFunctionSignatures)];
}

function compareFunctionSignatures(left: FunctionShape, right: FunctionShape): number {
  const leftArgs = left.args.map((arg) => `${arg.name}:${arg.type}`).join(",");
  const rightArgs = right.args.map((arg) => `${arg.name}:${arg.type}`).join(",");
  return (
    leftArgs.localeCompare(rightArgs) ||
    (left.returns?.type ?? "").localeCompare(right.returns?.type ?? "")
  );
}

function renderFunctionSignatures(
  shapes: SchemaShapes,
  schema: string,
  overloads: FunctionShape[]
): string {
  return overloads
    .map((fn) => {
      const conflict = functionConflictError(schema, overloads, fn);
      const tableRowError = tableRowFunctionError(shapes, schema, fn);
      const args = renderFunctionArgs(shapes, schema, fn);
      const returns = conflict ?? tableRowError ?? renderFunctionReturns(shapes, schema, fn);
      const setofOptions = renderSetofOptions(shapes, schema, fn);
      return `{ Args: ${args}; Returns: ${returns}${setofOptions ? `; SetofOptions: ${setofOptions}` : ""} }`;
    })
    .join(" | ");
}

function renderFunctionArgs(shapes: SchemaShapes, schema: string, fn: FunctionShape): string {
  if (fn.args.length === 0) {
    return "never";
  }
  return `{ ${fn.args
    .map(
      (arg) =>
        `${quoteKey(arg.name)}${arg.optional ? "?" : ""}: ${tsType(shapes, schema, arg.type)}`
    )
    .join("; ")} }`;
}

function renderFunctionReturns(shapes: SchemaShapes, schema: string, fn: FunctionShape): string {
  const base = renderFunctionReturnBase(shapes, schema, fn);
  return functionReturnsMultipleRows(fn) ? `${base}[]` : base;
}

function renderFunctionReturnBase(shapes: SchemaShapes, schema: string, fn: FunctionShape): string {
  const returns = fn.returns;
  if (returns?.columns && returns.columns.length > 0) {
    return renderFunctionRow(shapes, schema, returns.columns);
  }
  const relation = returns ? relationRowType(shapes, schema, returns.type) : undefined;
  if (relation) {
    const entry = shapes.schemas.get(relation.schema);
    const columns =
      entry?.tables.find((table) => table.name === relation.name)?.columns ??
      entry?.views.find((view) => view.name === relation.name)?.columns;
    if (columns) {
      return renderFunctionRow(shapes, relation.schema, columns);
    }
  }
  return returns ? tsType(shapes, schema, returns.type) : "unknown";
}

function renderFunctionRow(
  shapes: SchemaShapes,
  schema: string,
  columns: { name: string; notNull?: boolean; type: string }[]
): string {
  const row = columns
    .map((column) => {
      const type = tsType(shapes, schema, column.type);
      return `${quoteKey(column.name)}: ${nullable(type, column.notNull === false)}`;
    })
    .join("; ");
  return `{ ${row} }`;
}

function renderSetofOptions(
  shapes: SchemaShapes,
  schema: string,
  fn: FunctionShape
): string | undefined {
  const returnRelation = fn.returns ? relationRowType(shapes, schema, fn.returns.type) : undefined;
  const singleArg = fn.args.length === 1 ? fn.args[0] : undefined;
  const sourceRelation = singleArg ? relationRowType(shapes, schema, singleArg.type) : undefined;
  if (!returnRelation) {
    return;
  }
  const from = sourceRelation ? postgresTypeFormat(sourceRelation) : "*";
  return `{ from: ${quoteCodeString(from)}; to: ${quoteCodeString(returnRelation.name)}; isOneToOne: ${!functionReturnsMultipleRows(fn)}; isSetofReturn: ${fn.returns?.setof === true} }`;
}

function computedRelationshipFields(
  shapes: SchemaShapes,
  schema: string,
  entry: SchemaEntry,
  relationName: string
): { name: string; type: string }[] {
  return computedRelationshipFunctions(shapes, schema, entry, relationName).map((fn) => ({
    name: fn.name,
    type: renderFunctionReturnBase(shapes, schema, fn),
  }));
}

function isPostgrestVisibleFunction(
  shapes: SchemaShapes,
  schema: string,
  fn: FunctionShape
): boolean {
  if (fn.args.length === 0 || fn.args.every((arg) => arg.name.length > 0)) {
    return true;
  }
  if (
    fn.args.every((arg) => arg.name.length > 0 || (arg.optional && isValidUnnamedScalarArg(arg)))
  ) {
    return true;
  }
  return (
    fn.args.length === 1 &&
    fn.args[0] !== undefined &&
    isValidUnnamedArg(shapes, schema, fn.args[0])
  );
}

function isValidUnnamedArg(shapes: SchemaShapes, schema: string, arg: FunctionArgShape): boolean {
  if (arg.name.length > 0) {
    return true;
  }
  return isValidUnnamedScalarArg(arg) || relationRowType(shapes, schema, arg.type) !== undefined;
}

function isValidUnnamedScalarArg(arg: FunctionArgShape): boolean {
  const normalized = arg.type.trim().toLowerCase();
  if (normalized.endsWith("[]")) {
    return false;
  }
  const parenStart = normalized.indexOf("(");
  const typeName = parenStart === -1 ? normalized : normalized.slice(0, parenStart);
  const parts = typeName.split(".");
  if (parts.length > 1 && parts.slice(0, -1).join(".") !== "pg_catalog") {
    return false;
  }
  const base = parts.at(-1) ?? typeName;
  return base === "json" || base === "jsonb" || base === "text";
}

function relationRowType(
  shapes: SchemaShapes,
  schema: string,
  sqlType: string
): { name: string; schema: string } | undefined {
  const resolved = chaseColumnType(shapes, schema, sqlType);
  if (resolved.arrayDepth > 0 || isDeclaredDomainType(shapes, schema, sqlType)) {
    return;
  }
  if (resolved.kind === "relation") {
    return resolved.relationRef;
  }
  return resolved.kind === "composite" ? resolved.compositeRef : undefined;
}

function postgresTypeFormat(type: { name: string; schema: string }): string {
  const name = quotePostgresIdentifier(type.name);
  return type.schema === "public" ? name : `${quotePostgresIdentifier(type.schema)}.${name}`;
}

function quotePostgresIdentifier(name: string): string {
  let simple = name.length > 0;
  for (let index = 0; index < name.length; index += 1) {
    const character = name[index] ?? "";
    const valid =
      (character >= "a" && character <= "z") ||
      character === "_" ||
      (index > 0 && ((character >= "0" && character <= "9") || character === "$"));
    if (!valid) {
      simple = false;
      break;
    }
  }
  return simple ? name : `"${name.split('"').join('""')}"`;
}

function functionConflictError(
  schema: string,
  overloads: FunctionShape[],
  fn: FunctionShape
): string | undefined {
  if (overloads.length <= 1) {
    return;
  }
  if (fn.args.length === 0) {
    const conflict = overloads.find(
      (other) =>
        other !== fn &&
        other.args.length === 1 &&
        other.args[0]?.name === "" &&
        other.args[0]?.optional
    );
    if (conflict) {
      return `{ error: true } & ${quoteCodeString(
        `Could not choose the best candidate function between: ${schema}.${fn.name}(), ${schema}.${fn.name}( => ${
          conflict.returns ? postgresCatalogTypeName(conflict.returns.type) : "unknown"
        }). Try renaming the parameters or the function itself in the database so function overloading can be resolved`
      )}`;
    }
  }
  if (fn.args.length === 1 && fn.args[0]?.name) {
    const conflicts = overloads.filter(
      (other) =>
        other !== fn &&
        other.args.length === 1 &&
        other.args[0]?.name === fn.args[0]?.name &&
        other.args[0]?.type !== fn.args[0]?.type
    );
    if (conflicts.length > 0) {
      const conflictList = [fn, ...conflicts]
        .sort(compareConflictArgumentTypes)
        .map((item) => {
          const arg = item.args[0];
          return `${schema}.${fn.name}(${arg?.name ?? ""} => ${arg ? postgresCatalogTypeName(arg.type) : "unknown"})`;
        })
        .join(", ");
      return `{ error: true } & ${quoteCodeString(
        `Could not choose the best candidate function between: ${conflictList}. Try renaming the parameters or the function itself in the database so function overloading can be resolved`
      )}`;
    }
  }
}

function compareConflictArgumentTypes(left: FunctionShape, right: FunctionShape): number {
  const leftType = postgresCatalogTypeName(left.args[0]?.type ?? "unknown");
  const rightType = postgresCatalogTypeName(right.args[0]?.type ?? "unknown");
  return (
    (postgresCatalogTypeOids.get(leftType) ?? Number.MAX_SAFE_INTEGER) -
      (postgresCatalogTypeOids.get(rightType) ?? Number.MAX_SAFE_INTEGER) ||
    leftType.localeCompare(rightType)
  );
}

function tableRowFunctionError(
  shapes: SchemaShapes,
  schema: string,
  fn: FunctionShape
): string | undefined {
  const arg = fn.args[0];
  if (
    fn.args.length === 1 &&
    arg?.name === "" &&
    relationRowType(shapes, schema, arg.type) &&
    !(fn.returns && relationRowType(shapes, schema, fn.returns.type))
  ) {
    return `{ error: true } & ${quoteCodeString(
      `the function ${schema}.${fn.name} with parameter or with a single unnamed json/jsonb parameter, but no matches were found in the schema cache`
    )}`;
  }
}

function unqualifiedTypeName(base: string): string {
  const trimmed = base.trim();
  const withoutArray = trimmed.endsWith("[]") ? trimmed.slice(0, -2) : trimmed;
  const parenStart = withoutArray.indexOf("(");
  const name = parenStart === -1 ? withoutArray : withoutArray.slice(0, parenStart);
  return name.includes(".") ? (name.split(".").at(-1) ?? name) : name;
}

function postgresCatalogTypeName(sqlType: string): string {
  const name = unqualifiedTypeName(sqlType).toLowerCase();
  return postgresCatalogTypeNames.get(name) ?? name;
}

function renderRelationships(relationships: RelationshipShape[]): string {
  if (relationships.length === 0) {
    return "[]";
  }
  return `[${relationships
    .map(
      (item) =>
        `{ foreignKeyName: ${quoteCodeString(item.foreignKeyName)}; columns: ${tupleType(item.columns)}; isOneToOne: ${item.isOneToOne}; referencedRelation: ${quoteCodeString(item.referencedRelation)}; referencedColumns: ${tupleType(item.referencedColumns)} }`
    )
    .join(", ")}]`;
}

function tupleType(values: string[]): string {
  return `[${values.map(quoteCodeString).join(", ")}]`;
}

export function quoteKey(name: string): string {
  let simple = name.length > 0;
  for (let index = 0; index < name.length; index += 1) {
    const character = name[index] ?? "";
    const word =
      (character >= "a" && character <= "z") ||
      (character >= "A" && character <= "Z") ||
      character === "_" ||
      (index > 0 && character >= "0" && character <= "9");
    if (!word) {
      simple = false;
      break;
    }
  }
  return simple ? name : quoteCodeString(name);
}

export function quoteCodeString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

const postgresCatalogTypeNames = new Map([
  ["bigint", "int8"],
  ["boolean", "bool"],
  ["character", "bpchar"],
  ["character varying", "varchar"],
  ["decimal", "numeric"],
  ["double precision", "float8"],
  ["int", "int4"],
  ["integer", "int4"],
  ["real", "float4"],
  ["smallint", "int2"],
  ["time with time zone", "timetz"],
  ["time without time zone", "time"],
  ["timestamp with time zone", "timestamptz"],
  ["timestamp without time zone", "timestamp"],
]);

const postgresCatalogTypeOids = new Map([
  ["bool", 16],
  ["bytea", 17],
  ["char", 18],
  ["name", 19],
  ["int8", 20],
  ["int2", 21],
  ["int4", 23],
  ["text", 25],
  ["oid", 26],
  ["json", 114],
  ["xml", 142],
  ["float4", 700],
  ["float8", 701],
  ["inet", 869],
  ["bpchar", 1042],
  ["varchar", 1043],
  ["date", 1082],
  ["time", 1083],
  ["timestamp", 1114],
  ["timestamptz", 1184],
  ["interval", 1186],
  ["timetz", 1266],
  ["numeric", 1700],
  ["record", 2249],
  ["uuid", 2950],
  ["jsonb", 3802],
]);
