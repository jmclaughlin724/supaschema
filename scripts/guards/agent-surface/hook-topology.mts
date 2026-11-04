import type TypeScript from "typescript";
import { hookMatcherMatchesTool } from "../../lib/hook-matcher.mts";
import { arrayOf, at, isRecord, type JsonRecord, stringsOf } from "../../lib/json.mts";
import { forEachNode, parseScript, ts } from "../lib/typescript-ast.mts";

export interface HookHandlerRecord extends JsonRecord {
  command: string;
  type: "command";
}

export const sessionLifecycleEntrypointsFor = (runtimeRoot: string): string[] =>
  ["start", "end"].map((phase) => `${runtimeRoot}/hooks/context-session-${phase}.mts`);

export const sessionLifecycleEntrypoints = [
  ...sessionLifecycleEntrypointsFor(".claude"),
  ...sessionLifecycleEntrypointsFor(".codex"),
];

function isHookHandler(candidate: JsonRecord): candidate is HookHandlerRecord {
  return typeof candidate.command === "string" && candidate.type === "command";
}

export function hookHandlers(value: unknown): HookHandlerRecord[] {
  const out: HookHandlerRecord[] = [];
  const visit = (candidate: unknown): void => {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        visit(item);
      }
      return;
    }
    if (!isRecord(candidate)) {
      return;
    }
    if (isHookHandler(candidate)) {
      out.push(candidate);
    }
    for (const item of Object.values(candidate)) {
      visit(item);
    }
  };
  visit(value);
  return out;
}

export function codexPreToolUseCommandsFor(config: unknown, toolName: string): string[] {
  const entries = arrayOf(at(config, "hooks", "PreToolUse"));
  const commands: string[] = [];
  for (const entry of entries) {
    if (!matcherMentionsTool(at(entry, "matcher"), toolName)) {
      continue;
    }
    for (const handler of hookHandlers(entry)) {
      commands.push(handler.command);
    }
  }
  return commands;
}

export function claudePreToolUseCommandsFor(config: unknown, toolName: string): string[] {
  const entries = arrayOf(at(config, "hooks", "PreToolUse"));
  const commands: string[] = [];
  for (const entry of entries) {
    if (!claudeMatcherMentionsTool(at(entry, "matcher"), toolName)) {
      continue;
    }
    for (const handler of hookHandlers(entry)) {
      commands.push(handlerCommandText(handler));
    }
  }
  return commands;
}

export function claudeMatcherMentionsTool(matcher: unknown, toolName: string): boolean {
  if (typeof matcher !== "string" || matcher.length === 0) {
    return true;
  }
  return hookMatcherMatchesTool(matcher, toolName);
}

export function matcherMentionsTool(matcher: unknown, toolName: string): boolean {
  if (typeof matcher !== "string") {
    return false;
  }
  return hookMatcherMatchesTool(matcher, toolName);
}

export function handlerCommandText(handler: HookHandlerRecord): string {
  return [handler.command, ...stringsOf(handler.args)].join(" ");
}

export function runnerImportsEvaluateBashPolicy(text: string): boolean {
  const source = parseScript(text, "scripts/agent-hooks/runner.mts");
  let found = false;
  forEachNode(source, (node) => {
    if (!ts.isImportDeclaration(node)) {
      return;
    }
    if (moduleSpecifierText(node) !== "../../.claude/hooks/guards/bash-policy-checks.mts") {
      return;
    }
    const bindings = node.importClause?.namedBindings;
    if (!(bindings && ts.isNamedImports(bindings))) {
      return;
    }
    found ||= bindings.elements.some((element) => element.name.text === "evaluateBashPolicy");
  });
  return found;
}

function moduleSpecifierText(node: TypeScript.ImportDeclaration): string | undefined {
  return ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : undefined;
}

export function importsNamedBinding(
  text: string,
  sourceName: string,
  moduleSpecifier: string,
  bindingName: string
): boolean {
  const source = parseScript(text, sourceName);
  let found = false;
  forEachNode(source, (node) => {
    if (!ts.isImportDeclaration(node) || moduleSpecifierText(node) !== moduleSpecifier) {
      return;
    }
    const bindings = node.importClause?.namedBindings;
    if (!(bindings && ts.isNamedImports(bindings))) {
      return;
    }
    found ||= bindings.elements.some((element) => element.name.text === bindingName);
  });
  return found;
}

export function runnerDeclaresFunction(text: string, name: string): boolean {
  const source = parseScript(text, "scripts/agent-hooks/runner.mts");
  let found = false;
  forEachNode(source, (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) {
      found = true;
    }
  });
  return found;
}
