import {
  type AstNode,
  asRecord,
  astStatements,
  collectColumnReferences,
  readArray,
  readString,
  stringList,
} from "./ast.js";
import { parseSqlAst } from "./parser.js";

export function policyMetadataFromAst(node: AstNode): Record<string, unknown> {
  const usingColumns = [...collectColumnReferences(node.qual)].sort(
    (left, right) => Number(left > right) - Number(left < right)
  );
  const checkColumns = [...collectColumnReferences(node.with_check)].sort(
    (left, right) => Number(left > right) - Number(left < right)
  );
  const functionFacts = policyFunctionFacts([node.qual, node.with_check]);
  const roles = policyRoles(node);
  return {
    command: readString(node.cmd_name)?.toLowerCase() ?? "all",
    hasCheckPredicate: node.with_check !== undefined,
    hasUsingPredicate: node.qual !== undefined,
    ...(checkColumns.length === 0 ? {} : { checkColumns }),
    ...(functionFacts.functionCalls.length === 0
      ? {}
      : { functionCalls: functionFacts.functionCalls }),
    ...(functionFacts.unwrappedFunctionCalls.length === 0
      ? {}
      : { unwrappedFunctionCalls: functionFacts.unwrappedFunctionCalls }),
    ...(roles.length === 0 ? {} : { roles }),
    ...(usingColumns.length === 0 ? {} : { usingColumns }),
  };
}

export async function policyMetadataFromSql(sql: string): Promise<Record<string, unknown>> {
  const parsed = await parseSqlAst(sql);
  for (const statement of astStatements(parsed.ast, sql)) {
    const policy = asRecord(statement.node.CreatePolicyStmt);
    if (policy !== undefined) {
      return policyMetadataFromAst(policy);
    }
  }
  return {};
}

function policyFunctionFacts(values: unknown[]): {
  functionCalls: string[];
  unwrappedFunctionCalls: string[];
} {
  const facts = {
    functionCalls: new Set<string>(),
    unwrappedFunctionCalls: new Set<string>(),
  };
  for (const value of values) {
    visitPolicyFunctionValue(value, false, facts);
  }
  return {
    functionCalls: [...facts.functionCalls].sort(
      (left, right) => Number(left > right) - Number(left < right)
    ),
    unwrappedFunctionCalls: [...facts.unwrappedFunctionCalls].sort(
      (left, right) => Number(left > right) - Number(left < right)
    ),
  };
}

function visitPolicyFunctionValue(
  value: unknown,
  insideSubLink: boolean,
  facts: { functionCalls: Set<string>; unwrappedFunctionCalls: Set<string> }
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitPolicyFunctionValue(item, insideSubLink, facts);
    }
    return;
  }
  const node = asRecord(value);
  if (!node) {
    return;
  }
  const subLink = asRecord(node.SubLink);
  if (subLink) {
    visitPolicyFunctionValue(subLink, true, facts);
    return;
  }
  collectPolicyFunctionCall(node, insideSubLink, facts);
  for (const child of Object.values(node)) {
    if (child && typeof child === "object") {
      visitPolicyFunctionValue(child, insideSubLink, facts);
    }
  }
}

function collectPolicyFunctionCall(
  node: AstNode,
  insideSubLink: boolean,
  facts: { functionCalls: Set<string>; unwrappedFunctionCalls: Set<string> }
): void {
  const funcCall = asRecord(node.FuncCall);
  if (!funcCall) {
    return;
  }
  const name = stringList(funcCall.funcname).join(".").toLowerCase();
  if (name.length === 0) {
    return;
  }
  facts.functionCalls.add(name);
  if (!insideSubLink) {
    facts.unwrappedFunctionCalls.add(name);
  }
}

function policyRoles(node: AstNode): string[] {
  return readArray(node.roles)
    .map((item) => {
      const role = asRecord(asRecord(item)?.RoleSpec);
      const type = readString(role?.roletype);
      if (type === "ROLESPEC_PUBLIC") {
        return "public";
      }
      return readString(role?.rolename)?.toLowerCase();
    })
    .filter((item): item is string => item !== undefined && item.length > 0)
    .sort((left, right) => left.localeCompare(right));
}
