#!/usr/bin/env node
import fs from "node:fs";
import { isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type TypeScript from "typescript";
import { at, parseJson, recordOf } from "../../lib/json.mts";
import { assert, ok } from "../lib/assertions.mts";
import { ROOT } from "../lib/repository.mts";
import { forEachNode, parseDiagnosticCount, parseScript, ts } from "../lib/typescript-ast.mts";
import { sessionLifecycleEntrypoints } from "./hook-topology.mts";

export type HookImportEdge =
  | { file: string; kind: "bare" | "builtin"; specifier: string }
  | { file: string; kind: "relative"; specifier: string; target: string };

const roots = [".claude/hooks", ".codex/hooks", "scripts/agent-hooks"];
const hookModuleExtensions = [".mts", ".ts", ".mjs", ".js"];
const lifecycleRuntimeFiles = new Set([
  "scripts/agent-hooks/hook-entrypoint.mts",
  "scripts/agent-hooks/hook-output.mts",
  "scripts/agent-hooks/hook-runtime.mts",
  "scripts/agent-hooks/session-lifecycle.mts",
  "scripts/agent-hooks/state.mts",
]);
const lifecycleBuiltins = new Set(["node:crypto", "node:fs", "node:path", "node:url"]);

function isHookModule(file: string): boolean {
  return hookModuleExtensions.some((extension) => file.endsWith(extension));
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(file));
    } else if (entry.isFile()) {
      out.push(file);
    }
  }
  return out;
}

export function hookFiles(root = ROOT): string[] {
  return roots
    .flatMap((r) =>
      walk(path.join(root, r))
        .filter(isHookModule)
        .map((file) => path.relative(root, file).split(path.sep).join("/"))
    )
    .sort();
}

function importSpecifiers(file: string, root: string): string[] {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  const sourceFile = parseScript(source, file);
  assert(
    parseDiagnosticCount(sourceFile) === 0,
    `${file} has JavaScript parse diagnostics and cannot produce a complete hook import graph`
  );
  const specifiers = new Set<string>();
  forEachNode(sourceFile, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      const value = literalModuleSpecifier(node.moduleSpecifier);
      if (value !== undefined) {
        specifiers.add(value);
      }
      return;
    }
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length >= 1
    ) {
      const value = literalModuleSpecifier(node.arguments[0]);
      if (value !== undefined) {
        specifiers.add(value);
      }
    }
  });
  return [...specifiers].sort();
}

function literalModuleSpecifier(node: TypeScript.Node): string | undefined {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
    ? node.text
    : undefined;
}

function relativeDependency(file: string, specifier: string, root: string): string {
  const target = path.resolve(path.dirname(path.join(root, file)), specifier);
  const relativeTarget = path.relative(root, target);
  assert(
    relativeTarget !== ".." &&
      !relativeTarget.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeTarget),
    `${file} imports outside the repository hook graph: ${specifier}`
  );
  assert(
    fs.existsSync(target) && fs.statSync(target).isFile(),
    `${file} imports missing relative hook dependency ${specifier}`
  );
  return relativeTarget.split(path.sep).join("/");
}

export function hookImportGraph(root = ROOT): HookImportEdge[] {
  const edges: HookImportEdge[] = [];
  const pending = hookFiles(root);
  const visited = new Set<string>();
  const declaredPackages = rootPackageDependencies(root);
  while (pending.length > 0) {
    const file = pending.shift();
    if (file === undefined || visited.has(file)) {
      continue;
    }
    visited.add(file);
    for (const specifier of importSpecifiers(file, root)) {
      if (specifier.startsWith("node:")) {
        assert(isBuiltin(specifier), `${file} imports unknown Node builtin ${specifier}`);
        edges.push({ file, kind: "builtin", specifier });
        continue;
      }
      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const target = relativeDependency(file, specifier, root);
        edges.push({
          file,
          kind: "relative",
          specifier,
          target,
        });
        if (isHookModule(target) && !visited.has(target)) {
          pending.push(target);
        }
        continue;
      }
      assert(
        declaredPackages.has(packageName(specifier)),
        `${file} imports undeclared runtime module ${specifier}`
      );
      edges.push({ file, kind: "bare", specifier });
    }
  }
  return edges;
}

function rootPackageDependencies(root: string): Set<string> {
  const file = path.join(root, "package.json");
  if (!fs.existsSync(file)) {
    return new Set<string>();
  }
  const manifest = parseJson(fs.readFileSync(file, "utf8"));
  return new Set([
    ...Object.keys(recordOf(at(manifest, "dependencies"))),
    ...Object.keys(recordOf(at(manifest, "devDependencies"))),
  ]);
}

function packageName(specifier: string): string {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function reachableHookDependencies(
  graph: readonly HookImportEdge[],
  entrypoint: string
): string[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of graph) {
    if (edge.kind !== "relative") {
      continue;
    }
    const targets = adjacency.get(edge.file) ?? [];
    targets.push(edge.target);
    adjacency.set(edge.file, targets);
  }

  const reachable = new Set<string>();
  const visited = new Set([entrypoint]);
  const pending = [entrypoint];
  while (pending.length > 0) {
    const file = pending.shift();
    if (file === undefined) {
      continue;
    }
    for (const target of adjacency.get(file) ?? []) {
      if (visited.has(target)) {
        continue;
      }
      visited.add(target);
      reachable.add(target);
      pending.push(target);
    }
  }
  return [...reachable].sort();
}

export function check(root = ROOT): void {
  const graph = hookImportGraph(root);
  for (const entrypoint of sessionLifecycleEntrypoints) {
    if (!fs.existsSync(path.join(root, entrypoint))) {
      continue;
    }
    const reachable = reachableHookDependencies(graph, entrypoint);
    const reachableFiles = new Set([entrypoint, ...reachable]);
    const unexpected = [
      ...reachable
        .filter((file) => !lifecycleRuntimeFiles.has(file))
        .map((file) => `relative:${file}`),
      ...graph
        .filter(
          (edge) =>
            edge.kind === "builtin" &&
            reachableFiles.has(edge.file) &&
            !lifecycleBuiltins.has(edge.specifier)
        )
        .map((edge) => `${edge.file} -> ${edge.specifier}`),
      ...graph
        .filter((edge) => edge.kind === "bare" && reachableFiles.has(edge.file))
        .map((edge) => `${edge.file} -> ${edge.specifier}`),
    ];
    assert(
      unexpected.length === 0,
      `${entrypoint} reaches non-lifecycle hook runtime:\n${unexpected.join("\n")}`
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  check();
  ok("HOOK_IMPORT_GRAPH_OK");
}
