#!/usr/bin/env node
import type TypeScript from "typescript";
import { assert, ok } from "../lib/assertions.mts";
import { exists, gitTrackedFiles, ROOT, readText } from "../lib/repository.mts";
import { forEachNode, parse, ts } from "../lib/typescript-ast.mts";

const ALLOWED = new Set(["src/paths.ts"]);

function calleeName(node: TypeScript.Node): string | null {
  if (!ts.isCallExpression(node)) {
    return null;
  }
  const expression = node.expression;
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return null;
}

function isRelativeCall(node: TypeScript.Node): boolean {
  return ts.isCallExpression(node) && calleeName(node) === "relative";
}

function isEmptyString(node: TypeScript.Node): boolean {
  return ts.isStringLiteral(node) && node.text === "";
}

function isEqualsOrNotEquals(kind: TypeScript.SyntaxKind): boolean {
  return (
    kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
    kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
  );
}

function scanFile(file: string, root: string): void {
  const source = parse(readText(file, root), { fileName: file });
  const relativeVars = new Set<string>();
  forEachNode(source, (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      isRelativeCall(node.initializer) &&
      ts.isIdentifier(node.name)
    ) {
      relativeVars.add(node.name.text);
    }
  });
  forEachNode(source, (node) => {
    if (!(ts.isBinaryExpression(node) && isEqualsOrNotEquals(node.operatorToken.kind))) {
      return;
    }
    const { left, right } = node;
    const rightEmpty = isEmptyString(right);
    const leftEmpty = isEmptyString(left);
    if (!(rightEmpty || leftEmpty)) {
      return;
    }
    const operand = rightEmpty ? left : right;
    const flagged =
      isRelativeCall(operand) || (ts.isIdentifier(operand) && relativeVars.has(operand.text));
    assert(
      !flagged,
      `${file}: do not compare path.relative(...) to "" — it is byte-exact and trailing-separator-fragile across Node versions (nodejs/node#55424). Use pathContainsOrEqual / pathsOverlap from src/paths.ts.`
    );
  });
}

const files = gitTrackedFiles(ROOT).filter(
  (file) =>
    !ALLOWED.has(file) &&
    (file.endsWith(".ts") ||
      file.endsWith(".mts") ||
      file.endsWith(".mjs") ||
      file.endsWith(".js") ||
      file.endsWith(".cjs")) &&
    exists(file, ROOT)
);
for (const file of files) {
  scanFile(file, ROOT);
}
ok("PATH_COMPARISON_OK");
