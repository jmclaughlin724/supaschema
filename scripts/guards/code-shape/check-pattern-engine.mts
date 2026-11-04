import { parse as parseShell } from "sh-syntax";
import type TypeScript from "typescript";
import { at, isRecord, type JsonRecord, parseJson, stringsOf } from "../../lib/json.mts";
import { run } from "../lib/process.mts";
import { readText } from "../lib/repository.mts";
import { parse as parseJsTs, ts } from "../lib/typescript-ast.mts";
import { jsTsStringValue } from "./ast-scan.mts";

export async function patternEngineViolations(
  jsTsFiles: readonly string[],
  pythonFiles: readonly string[],
  shellFiles: readonly string[],
  root: string
): Promise<string[]> {
  return [
    ...jsTsPatternEngineViolations(jsTsFiles, root),
    ...jsTsRegexStringContractViolations(jsTsFiles, root),
    ...pythonPatternEngineViolations(pythonFiles, root),
    ...(await shellPatternEngineViolations(shellFiles, root)),
  ];
}

function jsTsPatternEngineViolations(candidates: readonly string[], root: string): string[] {
  return candidates.flatMap((file) => {
    const text = readText(file, root);
    const source = parseJsTs(text, { fileName: file });
    const found: TypeScript.Node[] = [];
    collectJsTsPatternEngineViolations(source, source, found);
    return found.map((node) => {
      const location = source.getLineAndCharacterOfPosition(node.getStart(source));
      return `${file}:${location.line + 1}:${location.character + 1} contains pattern-engine syntax; use parser or AST helpers.`;
    });
  });
}

function jsTsRegexStringContractViolations(candidates: readonly string[], root: string): string[] {
  return candidates.flatMap((file) => {
    const text = readText(file, root);
    const source = parseJsTs(text, { fileName: file });
    const found: TypeScript.Node[] = [];
    collectJsTsRegexStringContractViolations(source, source, found);
    return found.map((node) => {
      const location = source.getLineAndCharacterOfPosition(node.getStart(source));
      return `${file}:${location.line + 1}:${location.character + 1} contains a regex-shaped string contract; move validation to the canonical scanner or parser owner.`;
    });
  });
}

function pythonPatternEngineViolations(candidates: readonly string[], root: string): string[] {
  if (candidates.length === 0) {
    return [];
  }
  const source = [
    "import ast, json, sys",
    "hits = []",
    "for path in sys.argv[1:]:",
    "    tree = ast.parse(open(path, encoding='utf8').read(), filename=path)",
    "    aliases = set()",
    "    for node in ast.walk(tree):",
    "        if isinstance(node, ast.Import):",
    "            for alias in node.names:",
    "                if alias.name == 're':",
    "                    aliases.add(alias.asname or alias.name)",
    "        if isinstance(node, ast.ImportFrom) and node.module == 're':",
    "            hits.append(f'{path}:{node.lineno}:{node.col_offset + 1}')",
    "        if isinstance(node, ast.Call):",
    "            fn = node.func",
    "            if isinstance(fn, ast.Attribute) and isinstance(fn.value, ast.Name) and fn.value.id in aliases:",
    "                hits.append(f'{path}:{node.lineno}:{node.col_offset + 1}')",
    "print(json.dumps(hits))",
  ].join("\n");
  return stringsOf(parseJson(run("python3", ["-c", source, ...candidates], {}, root).stdout)).map(
    (location) => `${location} contains pattern-engine usage; use parser or AST helpers.`
  );
}

async function shellPatternEngineViolations(
  candidates: readonly string[],
  root: string
): Promise<string[]> {
  return (
    await Promise.all(
      candidates.map(async (file) => {
        const tree = await parseShell(readText(file, root), { filepath: file });
        const found: JsonRecord[] = [];
        collectShellPatternEngineUse(tree, found);
        return found.map(
          (node) =>
            `${file}:${at(node, "Pos", "Line") ?? 1}:${at(node, "Pos", "Col") ?? 1} contains shell pattern-engine usage; use parser or AST helpers.`
        );
      })
    )
  ).flat();
}

function collectJsTsPatternEngineViolations(
  node: TypeScript.Node,
  _source: TypeScript.SourceFile,
  found: TypeScript.Node[]
): void {
  if (node.kind === ts.SyntaxKind.RegularExpressionLiteral || isRegExpConstructorCall(node)) {
    found.push(node);
  }
  ts.forEachChild(node, (child) => collectJsTsPatternEngineViolations(child, _source, found));
}

function isRegExpConstructorCall(node: TypeScript.Node): boolean {
  return (
    (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "RegExp"
  );
}

function collectJsTsRegexStringContractViolations(
  node: TypeScript.Node,
  _source: TypeScript.SourceFile,
  found: TypeScript.Node[]
): void {
  const value = jsTsStringValue(node);
  if (value !== undefined && isRegexShapedString(value)) {
    found.push(node);
  }
  ts.forEachChild(node, (child) => collectJsTsRegexStringContractViolations(child, _source, found));
}

function isRegexShapedString(value: string): boolean {
  if (value.length === 0) {
    return false;
  }
  const groupStart = ["(", "?", ":"].join("");
  const lookaheadStart = ["(", "?", "="].join("");
  const namedStart = ["(", "?", "<"].join("");
  const startsLikePattern =
    value.startsWith("^") ||
    value.startsWith(groupStart) ||
    value.startsWith(lookaheadStart) ||
    value.startsWith(namedStart);
  if (!startsLikePattern) {
    return false;
  }
  const slash = "\\";
  const tokenTerms = [
    [slash, "d"].join(""),
    [slash, "w"].join(""),
    [slash, "s"].join(""),
    [".", "*"].join(""),
    [".", "+"].join(""),
    ["?", ":"].join(""),
    ["(", "?"].join(""),
    "$",
  ];
  return tokenTerms.some((token) => value.includes(token));
}

function collectShellPatternEngineUse(value: unknown, found: JsonRecord[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectShellPatternEngineUse(item, found);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (value.Op === "=~" || value.Value === "=~") {
    found.push(value);
  }
  for (const item of Object.values(value)) {
    collectShellPatternEngineUse(item, found);
  }
}
