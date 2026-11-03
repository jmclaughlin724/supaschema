import { loadModule, type ParseResult, parse } from "libpg-query";
import { isRecord, type JsonRecord, stringAt } from "../../lib/json.mts";

let loaded = false;

export async function parseSql(text: string): Promise<ParseResult> {
  if (!loaded) {
    await loadModule();
    loaded = true;
  }
  return parse(text);
}

export function stmtKind(stmt: JsonRecord | null | undefined): string {
  return Object.keys(stmt ?? {})[0] ?? "UnknownStmt";
}

export function relName(rel: unknown): { name: string; schema: string } | undefined {
  if (!isRecord(rel)) {
    return;
  }
  const schema = typeof rel.schemaname === "string" ? rel.schemaname : "public";
  const name = typeof rel.relname === "string" ? rel.relname : undefined;
  return name ? { name, schema } : undefined;
}

export function dottedName(
  list: unknown
): { name: string | undefined; schema: string } | undefined {
  const parts = arrayItems(list)
    .map((item) => stringAt(item, "String", "sval") ?? stringAt(item, "String", "str") ?? "")
    .filter(Boolean);
  if (parts.length === 0) {
    return;
  }
  if (parts.length === 1) {
    return { name: parts[0], schema: "public" };
  }
  return { name: parts.at(-1), schema: parts.slice(0, -1).join(".") };
}

export function arrayItems(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
