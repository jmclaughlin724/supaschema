import type { HookPayload, HookRuntime } from "./hook-runtime.mts";

export interface HookCheckResult {
  block?: string;
  contextParts?: string[];
  deny?: string;
  systemMessage?: string;
}

export interface HookFailureDetails {
  hookPath?: string;
  remediation?: string;
  runtime?: HookRuntime;
}

export type HookCheck<Context> = (
  payload: HookPayload,
  context: Context
) => HookCheckResult | undefined;

interface HookSpecificOutput {
  additionalContext?: string;
  hookEventName: string;
  permissionDecision?: "deny";
  permissionDecisionReason?: string;
}

interface HookOutput {
  decision?: "block";
  hookSpecificOutput?: HookSpecificOutput;
  reason?: string;
  systemMessage?: string;
}

export interface ShapedHookResult {
  exitCode: number;
  output: HookOutput;
  stderr: string;
  stdout: string;
}

const messageKeys: readonly ("block" | "deny" | "systemMessage")[] = [
  "block",
  "deny",
  "systemMessage",
];

const modelContextEvents = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
]);

const decisionBlockEvents = new Set([
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "SubagentStop",
  "TaskCompleted",
]);

const maxDiagnosticValueLength = 800;
const sourceExtensions = [".cjs", ".cts", ".js", ".mjs", ".mts", ".ts"];

export function shapeHookResult(
  eventName: string,
  result: HookCheckResult = {},
  runtime: HookRuntime = "claude"
): ShapedHookResult {
  const output: HookOutput = {};
  const context = joinParts(result.contextParts);
  const exitCode = 0;
  const stderr = "";
  const supportsModelContext = modelContextEvents.has(eventName);

  if (context && supportsModelContext) {
    output.hookSpecificOutput = {
      ...(output.hookSpecificOutput ?? {}),
      additionalContext: context,
      hookEventName: eventName,
    };
  }

  if (result.systemMessage) {
    output.systemMessage = result.systemMessage;
  }

  const preToolPermissionReason =
    eventName === "PreToolUse" ? joinMessages(result.deny, result.block) : result.deny;

  if (preToolPermissionReason) {
    output.hookSpecificOutput = {
      ...(output.hookSpecificOutput ?? {}),
      hookEventName: eventName,
      permissionDecision: "deny",
      permissionDecisionReason: preToolPermissionReason,
    };
  }

  if (result.block && eventName !== "PreToolUse") {
    if (decisionBlockEvents.has(eventName)) {
      output.decision = "block";
      output.reason = result.block;
    } else {
      output.systemMessage = result.block;
    }
  }

  if (runtime === "codex" && (eventName === "Stop" || eventName === "SubagentStop")) {
    return shaped(output, exitCode, stderr, true);
  }

  return shaped(output, exitCode, stderr, false);
}

const defaultRemediation =
  "Inspect the reported source and rerun the action. The crash made no policy decision.";

export function unexpectedFailureResult(
  eventName: string,
  error: unknown,
  checkName = "unknown",
  details: HookFailureDetails = {}
): HookCheckResult {
  const diagnostic = structuredError(eventName, checkName, error, details);
  return { systemMessage: diagnostic };
}

export function shapeSessionStateFailure(
  eventName: string,
  error: unknown,
  details: { hookPath: string; runtime: HookRuntime }
): ShapedHookResult {
  return shapeHookResult(
    eventName,
    unexpectedFailureResult(eventName, error, "sessionState", {
      hookPath: details.hookPath,
      remediation: "Inspect the reported session-state error and rerun the hook.",
      runtime: details.runtime,
    }),
    details.runtime
  );
}

export function runChecks<Context extends HookFailureDetails>(
  eventName: string,
  payload: HookPayload,
  checks: readonly HookCheck<Context>[],
  context: Context
): HookCheckResult {
  const aggregate: HookCheckResult = {
    contextParts: [],
  };

  for (const check of checks) {
    try {
      mergeResult(aggregate, check(payload, context) ?? {});
    } catch (error) {
      mergeResult(
        aggregate,
        unexpectedFailureResult(eventName, error, check.name || "anonymous", {
          hookPath: context.hookPath,
          runtime: context.runtime,
        })
      );
    }
  }

  return aggregate;
}

export function mergeResult(target: HookCheckResult, addition: HookCheckResult): HookCheckResult {
  if (Array.isArray(addition.contextParts)) {
    target.contextParts ??= [];
    target.contextParts.push(...addition.contextParts.filter(Boolean));
  }
  for (const key of messageKeys) {
    if (addition[key]) {
      target[key] = joinMessages(target[key], addition[key]);
    }
  }
  return target;
}

export function structuredError(
  eventName: string,
  checkName: string,
  error: unknown,
  details: HookFailureDetails = {}
): string {
  const message = diagnosticValue(error instanceof Error ? error.message : String(error));
  const hookPath = diagnosticValue(details.hookPath ?? "unknown");
  const remediation = diagnosticValue(details.remediation ?? defaultRemediation);
  return [
    "Agent hook warning: check crashed; no policy decision was made.",
    `runtime=${diagnosticValue(details.runtime ?? "unknown")}`,
    `event=${eventName}`,
    `hook=${hookPath}`,
    `check=${checkName}`,
    `source=${sourceLocation(error)}`,
    `error=${message}`,
    `remediation=${remediation}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function writeHookResult(result: ShapedHookResult): void {
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(`${result.stderr}\n`);
  }
}

function shaped(
  output: HookOutput,
  exitCode: number,
  stderr: string,
  forceJson: boolean
): ShapedHookResult {
  const hasOutput = Object.keys(output).length > 0;
  return {
    exitCode,
    output,
    stderr,
    stdout: hasOutput || forceJson ? `${JSON.stringify(output)}\n` : "",
  };
}

function joinParts(parts: readonly string[] | undefined): string {
  return (parts ?? []).filter(Boolean).join("\n\n---\n\n");
}

function joinMessages(...messages: (string | undefined)[]): string {
  return [...new Set(messages.filter(Boolean))].join("\n\n");
}

function diagnosticValue(value: string): string {
  let normalized = "";
  let previousWasWhitespace = false;
  for (const character of String(value)) {
    const isWhitespace = character.trim().length === 0;
    if (!isWhitespace) {
      normalized += character;
    } else if (!previousWasWhitespace) {
      normalized += " ";
    }
    previousWasWhitespace = isWhitespace;
  }
  return normalized.trim().slice(0, maxDiagnosticValueLength);
}

function sourceLocation(error: unknown): string {
  const stack = error instanceof Error && error.stack ? error.stack : "";
  for (const line of stack.split("\n").slice(1)) {
    const candidate = stackLocation(line);
    if (candidate) {
      return diagnosticValue(candidate);
    }
  }
  return "unknown";
}

function stackLocation(line: string): string | undefined {
  let candidate = line.trim();
  if (candidate.endsWith(")")) {
    candidate = candidate.slice(0, -1);
  }
  const columnSeparator = candidate.lastIndexOf(":");
  const lineSeparator = candidate.lastIndexOf(":", columnSeparator - 1);
  if (columnSeparator < 0 || lineSeparator < 0) {
    return;
  }
  const column = candidate.slice(columnSeparator + 1);
  const lineNumber = candidate.slice(lineSeparator + 1, columnSeparator);
  if (!(isDecimal(lineNumber) && isDecimal(column))) {
    return;
  }
  let source = candidate.slice(0, lineSeparator);
  const openParenthesis = source.lastIndexOf("(");
  if (openParenthesis >= 0) {
    source = source.slice(openParenthesis + 1);
  } else if (source.startsWith("at ")) {
    source = source.slice(3);
  }
  if (source.startsWith("file://")) {
    source = source.slice("file://".length);
  }
  if (!sourceExtensions.some((extension) => source.endsWith(extension))) {
    return;
  }
  return `${source}:${lineNumber}:${column}`;
}

function isDecimal(value: string): boolean {
  return value.length > 0 && [...value].every((character) => character >= "0" && character <= "9");
}
