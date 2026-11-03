import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type ParseResult, parse } from "libpg-query";

export function classifyPostgresDdl(parsed: ParseResult | undefined): {
  ddl: boolean;
  tag: string;
} {
  for (const statement of parsed?.stmts ?? []) {
    const entry = Object.entries(statement?.stmt ?? {})[0];
    if (!entry) {
      continue;
    }
    const [tag] = entry;
    if (postgresDdlNode(tag)) {
      return { ddl: true, tag };
    }
  }
  return { ddl: false, tag: "" };
}

function postgresDdlNode(tag: string): boolean {
  const action = leadingNodeWord(tag);
  if (action === "Create" || action === "Alter" || action === "Drop") {
    return true;
  }
  if (action === "Grant" || action === "Rename" || action === "Truncate") {
    return true;
  }
  return (
    tag === "CommentStmt" ||
    tag === "CompositeTypeStmt" ||
    tag === "DefineStmt" ||
    tag === "DoStmt" ||
    tag === "ImportForeignSchemaStmt" ||
    tag === "IndexStmt" ||
    tag === "RefreshMatViewStmt" ||
    tag === "ReindexStmt" ||
    tag === "RuleStmt" ||
    tag === "SecLabelStmt" ||
    tag === "ViewStmt"
  );
}

function leadingNodeWord(value: string): string {
  let word = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (word && code >= 65 && code <= 90) {
      break;
    }
    word += character;
  }
  return word;
}

async function main(): Promise<void> {
  const sql = readFileSync(0, "utf8");
  if (!sql.trim()) {
    process.stdout.write(`${JSON.stringify({ ddl: false, tag: "" })}\n`);
    return;
  }
  try {
    const parsed = await parse(sql);
    process.stdout.write(`${JSON.stringify(classifyPostgresDdl(parsed))}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ ddl: false, tag: "" })}\n`);
  }
}

const entry = process.argv[1];
if (entry && path.resolve(entry) === fileURLToPath(import.meta.url)) {
  await main();
}
