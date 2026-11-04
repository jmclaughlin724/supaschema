import { createRequire } from "node:module";
import type TypeScript from "typescript";

type TypeScriptApi = typeof TypeScript;

export interface ParseOptions {
  fileName?: string;
  scriptKind?: TypeScript.ScriptKind;
}

const require = createRequire(import.meta.url);

let loadedTypescript: TypeScriptApi | undefined;

function loadTypescript(): TypeScriptApi {
  if (loadedTypescript !== undefined) {
    return loadedTypescript;
  }
  const loaded: TypeScriptApi = require("typescript");
  loadedTypescript = loaded;
  return loaded;
}

export const ts: TypeScriptApi = new Proxy<TypeScriptApi>(Object.create(null), {
  get(_target, property) {
    return Reflect.get(loadTypescript(), property);
  },
});

export function parse(
  text: string,
  { fileName = "inline.ts", scriptKind }: ParseOptions = {}
): TypeScript.SourceFile {
  const tsApi = loadTypescript();
  return tsApi.createSourceFile(
    fileName,
    text,
    tsApi.ScriptTarget.Latest,
    true,
    scriptKind ?? scriptKindForFile(fileName)
  );
}

export function parseScript(text: string, name = "inline.mjs"): TypeScript.SourceFile {
  return parse(text, { fileName: name });
}

export function parseDiagnosticCount(sourceFile: TypeScript.SourceFile): number {
  const diagnostics: unknown = Reflect.get(sourceFile, "parseDiagnostics");
  if (!Array.isArray(diagnostics)) {
    throw new Error(`${sourceFile.fileName} does not expose TypeScript parse diagnostics`);
  }
  return diagnostics.length;
}

export function forEachNode(
  sourceFile: TypeScript.Node,
  callback: (node: TypeScript.Node) => void
): void {
  function visit(node: TypeScript.Node): void {
    callback(node);
    loadTypescript().forEachChild(node, visit);
  }
  visit(sourceFile);
}

function scriptKindForFile(fileName: string): TypeScript.ScriptKind {
  const tsApi = loadTypescript();
  if (fileName.endsWith(".tsx")) {
    return tsApi.ScriptKind.TSX;
  }
  if (fileName.endsWith(".jsx")) {
    return tsApi.ScriptKind.JSX;
  }
  if (fileName.endsWith(".json")) {
    return tsApi.ScriptKind.JSON;
  }
  if (fileName.endsWith(".js") || fileName.endsWith(".mjs") || fileName.endsWith(".cjs")) {
    return tsApi.ScriptKind.JS;
  }
  return tsApi.ScriptKind.TS;
}
