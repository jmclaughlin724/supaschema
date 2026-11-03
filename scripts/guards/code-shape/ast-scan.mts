import type TypeScript from "typescript";
import { ts } from "../lib/typescript-ast.mts";

export const forbiddenSurfaceNameTerms = [
  "alias",
  "compat",
  "compatibility",
  "deprecated",
  "dto",
  "facade",
  "legacy",
  "shim",
  "view-model",
  "viewmodel",
  "wrapper",
];

export function jsTsStringValue(node: TypeScript.Node): string | undefined {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("");
  }
}

export function jsTsSearchableValue(node: TypeScript.Node): string | undefined {
  if (ts.isIdentifier(node)) {
    return node.text;
  }
  return jsTsStringValue(node);
}
