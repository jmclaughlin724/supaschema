import { parse as parseShell, type Comment as ShellComment } from "sh-syntax";
import type TypeScript from "typescript";
import { isRecord, parseJson, stringsOf } from "../../lib/json.mts";
import { jsTsComments } from "../../lib/source-comments.mts";
import { run } from "../lib/process.mts";
import { readText } from "../lib/repository.mts";
import { parse as parseJsTs, ts } from "../lib/typescript-ast.mts";
import { forbiddenSurfaceNameTerms, jsTsSearchableValue } from "./ast-scan.mts";

interface TermHit {
  node: TypeScript.Node;
  term: string;
}

const deferredMarkerTerms = [
  ["TO", "DO"].join(""),
  ["FIX", "ME"].join(""),
  ["T", "BD"].join(""),
  ["place", "holder"].join(""),
];
const externalContractExportOnlyFiles = new Map([
  ["src/index.ts", "npm package public API entry point"],
]);
const monetizationTerms = [
  "STRIPE_SECRET_KEY",
  "STRIPE_PRICE_MAP",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_CATALOG_APPROVED",
  "STRIPE_LIVE_APPROVED",
  "SUPASCHEMA_LICENSE_PRIVATE_KEY",
  "GITHUB_MARKETPLACE_WEBHOOK_SECRET",
  "checkout/sessions",
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "marketplace_purchase",
  "marketplace_listing_plan_id",
  "X-Hub-Signature-256",
  "x-hub-signature-256",
  "api.stripe.com",
];

export async function changeDisciplineViolations(
  codeFiles: readonly string[],
  jsTsFiles: readonly string[],
  pythonFiles: readonly string[],
  shellFiles: readonly string[],
  root: string
): Promise<string[]> {
  return [
    ...forbiddenFileNameViolations(codeFiles),
    ...exportOnlyModuleViolations(jsTsFiles, root),
    ...(await jsTsCommentViolations(jsTsFiles, root)),
    ...jsTsTypeAssertionViolations(jsTsFiles, root),
    ...jsTsCopiedEnumTupleViolations(jsTsFiles, root),
    ...jsTsDeferredMarkerViolations(jsTsFiles, root),
    ...pythonCommentViolations(pythonFiles, root),
    ...pythonDeferredMarkerViolations(pythonFiles, root),
    ...(await shellCommentViolations(shellFiles, root)),
    ...shellDeferredMarkerViolations(shellFiles, root),
    ...monetizationSurfaceViolations(jsTsFiles, root),
  ];
}

function forbiddenFileNameViolations(candidates: readonly string[]): string[] {
  return candidates
    .filter((file) => {
      const base = pathBasename(file);
      return forbiddenSurfaceNameTerms.some((term) => base.includes(term));
    })
    .map(
      (file) =>
        `${file} has a forbidden compatibility or parallel-contract module name; rename or delete it in the canonical owner.`
    );
}

function pathBasename(file: string): string {
  const slash = Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\"));
  return slash === -1 ? file.toLowerCase() : file.slice(slash + 1).toLowerCase();
}

function exportOnlyModuleViolations(candidates: readonly string[], root: string): string[] {
  return candidates.flatMap((file) => {
    if (!isExportOnlyModule(file, root)) {
      return [];
    }
    const externalContract = externalContractExportOnlyFiles.get(file);
    if (externalContract !== undefined) {
      return [];
    }
    return [
      `${file} is export-only; move the exported symbols to the canonical owner and delete this surface.`,
    ];
  });
}

async function jsTsCommentViolations(
  candidates: readonly string[],
  root: string
): Promise<string[]> {
  return (
    await Promise.all(
      candidates.map(async (file) =>
        (
          await jsTsComments(file, readText(file, root))
        ).map(
          (comment) =>
            `${file}:${comment.line}:${comment.character} contains a ${comment.kind} comment; move durable explanation to the owning rule, test, or docs surface.`
        )
      )
    )
  ).flat();
}

function jsTsTypeAssertionViolations(candidates: readonly string[], root: string): string[] {
  return candidates.flatMap((file) => {
    const text = readText(file, root);
    const source = parseJsTs(text, { fileName: file });
    const found: TypeScript.Node[] = [];
    collectJsTsTypeAssertionViolations(source, source, found);
    return found.map((node) => {
      const location = source.getLineAndCharacterOfPosition(node.getStart(source));
      return `${file}:${location.line + 1}:${location.character + 1} contains a TypeScript assertion; use the generated contract, parser, or scanner owner instead.`;
    });
  });
}

function jsTsCopiedEnumTupleViolations(candidates: readonly string[], root: string): string[] {
  return candidates.flatMap((file) => {
    const text = readText(file, root);
    const source = parseJsTs(text, { fileName: file });
    const found: TypeScript.Node[] = [];
    collectJsTsCopiedEnumTupleViolations(source, source, found);
    return found.map((node) => {
      const location = source.getLineAndCharacterOfPosition(node.getStart(source));
      return `${file}:${location.line + 1}:${location.character + 1} contains an inline z.enum tuple; use the canonical enum owner.`;
    });
  });
}

function jsTsDeferredMarkerViolations(candidates: readonly string[], root: string): string[] {
  return candidates.flatMap((file) => {
    const text = readText(file, root);
    const source = parseJsTs(text, { fileName: file });
    const found: TermHit[] = [];
    collectJsTsDeferredMarkerViolations(source, source, found);
    return found.map(({ node, term }) => {
      const location = source.getLineAndCharacterOfPosition(node.getStart(source));
      return `${file}:${location.line + 1}:${location.character + 1} contains deferred marker ${term}; resolve it in the canonical owner.`;
    });
  });
}

function pythonCommentViolations(candidates: readonly string[], root: string): string[] {
  if (candidates.length === 0) {
    return [];
  }
  const source = [
    "import json, sys, tokenize",
    "hits = []",
    "for path in sys.argv[1:]:",
    "    with open(path, 'rb') as stream:",
    "        for token in tokenize.tokenize(stream.readline):",
    "            if token.type == tokenize.COMMENT and not (token.start[0] == 1 and token.string.startswith('#!')):",
    "                hits.append(f'{path}:{token.start[0]}:{token.start[1] + 1}')",
    "print(json.dumps(hits))",
  ].join("\n");
  const result = run("python3", ["-c", source, ...candidates], {}, root).stdout;
  return stringsOf(parseJson(result)).map(
    (location) =>
      `${location} contains a Python comment; move durable explanation to the owning rule, test, or docs surface.`
  );
}

function pythonDeferredMarkerViolations(candidates: readonly string[], root: string): string[] {
  if (candidates.length === 0) {
    return [];
  }
  const source = [
    "import ast, json, sys",
    `terms = ${JSON.stringify(deferredMarkerTerms)}`,
    "hits = []",
    "for path in sys.argv[1:]:",
    "    tree = ast.parse(open(path, encoding='utf8').read(), filename=path)",
    "    for node in ast.walk(tree):",
    "        value = None",
    "        if isinstance(node, ast.Name):",
    "            value = node.id",
    "        elif isinstance(node, ast.Constant) and isinstance(node.value, str):",
    "            value = node.value",
    "        if value:",
    "            for term in terms:",
    "                if term in value:",
    "                    hits.append(f'{path}:{node.lineno}:{node.col_offset + 1}:{term}')",
    "                    break",
    "print(json.dumps(hits))",
  ].join("\n");
  return stringsOf(parseJson(run("python3", ["-c", source, ...candidates], {}, root).stdout)).map(
    (entry) => {
      const [file, line, column, term] = entry.split(":");
      return `${file}:${line}:${column} contains deferred marker ${term}; resolve it in the canonical owner.`;
    }
  );
}

async function shellCommentViolations(
  candidates: readonly string[],
  root: string
): Promise<string[]> {
  return (
    await Promise.all(
      candidates.map(async (file) => {
        const tree = await parseShell(readText(file, root), { filepath: file });
        const comments: ShellComment[] = [];
        collectShellComments(tree, comments);
        return comments
          .filter((comment) => !(comment.Pos?.Line === 1 && comment.Text.startsWith("!")))
          .map(
            (comment) =>
              `${file}:${comment.Pos.Line}:${comment.Pos.Col} contains a shell comment; move durable explanation to the owning rule, test, or docs surface.`
          );
      })
    )
  ).flat();
}

function shellDeferredMarkerViolations(candidates: readonly string[], root: string): string[] {
  return candidates.flatMap((file) => {
    const text = readText(file, root);
    return deferredMarkerTerms
      .filter((term) => text.includes(term))
      .map(
        (term) => `${file} contains deferred marker ${term}; resolve it in the canonical owner.`
      );
  });
}

function monetizationSurfaceViolations(candidates: readonly string[], root: string): string[] {
  return candidates.flatMap((file) => {
    if (
      file.startsWith("tests/") ||
      file.startsWith("services/license-worker/") ||
      file.startsWith("scripts/stripe/") ||
      file === "scripts/guards/code-shape/check-change-discipline.mts"
    ) {
      return [];
    }
    const source = parseJsTs(readText(file, root), { fileName: file });
    const found: TermHit[] = [];
    collectMonetizationTerms(source, source, found);
    return found.map(({ node, term }) => {
      const location = source.getLineAndCharacterOfPosition(node.getStart(source));
      return `${file}:${location.line + 1}:${location.character + 1} contains monetization term ${term}; keep checkout, Stripe, GitHub Marketplace, and license issuance implementation outside the public repository.`;
    });
  });
}

function collectJsTsTypeAssertionViolations(
  node: TypeScript.Node,
  _source: TypeScript.SourceFile,
  found: TypeScript.Node[]
): void {
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    found.push(node);
  }
  ts.forEachChild(node, (child) => collectJsTsTypeAssertionViolations(child, _source, found));
}

function collectJsTsCopiedEnumTupleViolations(
  node: TypeScript.Node,
  _source: TypeScript.SourceFile,
  found: TypeScript.Node[]
): void {
  if (isInlineZodEnumTuple(node)) {
    found.push(node);
  }
  ts.forEachChild(node, (child) => collectJsTsCopiedEnumTupleViolations(child, _source, found));
}

function isInlineZodEnumTuple(node: TypeScript.Node): boolean {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === "z" &&
    node.expression.name.text === "enum" &&
    node.arguments.length > 0 &&
    ts.isArrayLiteralExpression(node.arguments[0])
  );
}

function collectJsTsDeferredMarkerViolations(
  node: TypeScript.Node,
  _source: TypeScript.SourceFile,
  found: TermHit[]
): void {
  const value = jsTsSearchableValue(node);
  if (value !== undefined) {
    const term = deferredMarkerTerms.find((candidate) => value.includes(candidate));
    if (term !== undefined) {
      found.push({ node, term });
    }
  }
  ts.forEachChild(node, (child) => collectJsTsDeferredMarkerViolations(child, _source, found));
}

function collectMonetizationTerms(
  node: TypeScript.Node,
  _source: TypeScript.SourceFile,
  found: TermHit[]
): void {
  const value = jsTsSearchableValue(node);
  if (value !== undefined) {
    const term = monetizationTerms.find((candidate) => value.includes(candidate));
    if (term !== undefined) {
      found.push({ node, term });
    }
  }
  ts.forEachChild(node, (child) => collectMonetizationTerms(child, _source, found));
}

function isShellComment(value: unknown): value is ShellComment {
  return isRecord(value) && typeof value.Text === "string" && isRecord(value.Pos);
}

function collectShellComments(value: unknown, comments: ShellComment[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectShellComments(item, comments);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (Array.isArray(value.Comments)) {
    comments.push(...value.Comments.filter(isShellComment));
  }
  for (const item of Object.values(value)) {
    collectShellComments(item, comments);
  }
}

function isExportOnlyModule(file: string, root: string): boolean {
  const source = parseJsTs(readText(file, root), { fileName: file });
  const statements = source.statements.filter((statement) => !isEmptyStatement(statement));
  if (statements.length === 0) {
    return false;
  }
  const nonImports = statements.filter((statement) => !ts.isImportDeclaration(statement));
  return nonImports.length > 0 && nonImports.every(isReExportStatement);
}

function isEmptyStatement(statement: TypeScript.Statement): boolean {
  return statement.kind === ts.SyntaxKind.EmptyStatement;
}

function isReExportStatement(statement: TypeScript.Statement): boolean {
  if (ts.isExportDeclaration(statement)) {
    return statement.moduleSpecifier !== undefined;
  }
  if (ts.isExportAssignment(statement)) {
    return false;
  }
  return false;
}
