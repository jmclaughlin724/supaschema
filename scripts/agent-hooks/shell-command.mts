import path from "node:path";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { Minimatch } from "minimatch";
import {
  type ArithmeticExpression,
  type AssignmentPrefix,
  type Command,
  type Node,
  type ParsedScript,
  type ParseError,
  parse,
  type Redirect,
  type TestExpression,
  type Word,
  type WordPart,
} from "unbash";

export interface ShellInvocation {
  arguments: Word[];
  assignments: AssignmentPrefix[];
  captured: boolean;
  depth: number;
  executable: string | null;
  executableText: string;
  hasRedirection: boolean;
  nested: boolean;
  node: Command;
  piped: boolean;
  redirections: Redirect[];
  source: string;
}

export interface ShellAnalysis {
  errors: ParseError[];
  invocations: ShellInvocation[];
  script: ParsedScript;
}

interface ShellContext {
  captured: boolean;
  depth: number;
  nested: boolean;
  piped: boolean;
  redirections: Redirect[];
  source: string;
}

interface ShellState {
  errors: ParseError[];
  invocations: ShellInvocation[];
  seenScripts: WeakSet<ParsedScript>;
}

type StaticValue = string | null;

const maxNestedShellDepth = 6;
const maxInvocations = 256;
const shellExecutables = new Set(["bash", "dash", "ksh", "sh", "zsh"]);

export function parseShellCommand(source: unknown): ShellAnalysis {
  const state: ShellState = { errors: [], invocations: [], seenScripts: new WeakSet() };
  const script = parse(String(source ?? ""));
  collectScript(script, emptyContext(), state);
  expandStaticExecutors(state);
  return { errors: state.errors, invocations: state.invocations, script };
}

export function staticWordValue(word: Word | null | undefined): StaticValue {
  if (!(word && typeof word === "object")) {
    return null;
  }
  const parts = word.parts;
  if (Array.isArray(parts)) {
    return parts.every(staticWordPart) ? word.value : null;
  }
  return shellGlobHasMagic(word.value) ? null : word.value;
}

export function wordText(word: Word | undefined): string {
  return typeof word?.text === "string" ? word.text : "";
}

export function executableName(value: string | null | undefined): string {
  const normalized = String(value ?? "")
    .split("\\")
    .join("/");
  const name = path.posix.basename(normalized);
  return name.endsWith(".exe") ? name.slice(0, -4) : name;
}

export function parseStaticArguments(
  words: readonly Word[],
  options: { options?: ParseArgsOptionsConfig } = {}
) {
  const dynamicIndexes = new Set<number>();
  const args = words.map((word, index) => {
    const value = staticWordValue(word);
    if (value !== null) {
      return value;
    }
    dynamicIndexes.add(index);
    return `agent-hook-dynamic-${index}`;
  });
  const parsed = parseArgs({
    allowPositionals: true,
    args,
    options: options.options ?? {},
    strict: false,
    tokens: true,
  });
  return { ...parsed, args, dynamicIndexes };
}

function collectSource(source: string, context: ShellContext, state: ShellState): void {
  if (context.depth > maxNestedShellDepth) {
    state.errors.push({ message: "nested shell source exceeded the parser depth limit", pos: 0 });
    return;
  }
  collectScript(parse(source), context, state);
}

function collectScript(
  script: ParsedScript | undefined,
  context: ShellContext,
  state: ShellState
): void {
  if (!(script && typeof script === "object") || state.seenScripts.has(script)) {
    return;
  }
  state.seenScripts.add(script);
  if (Array.isArray(script.errors)) {
    state.errors.push(...script.errors);
  }
  for (const statement of script.commands ?? []) {
    visitNode(statement, context, state);
  }
}

function visitNode(node: Node | undefined, context: ShellContext, state: ShellState): void {
  if (!(node && typeof node === "object")) {
    return;
  }
  switch (node.type) {
    case "Statement":
      visitNode(
        node.command,
        { ...context, redirections: [...context.redirections, ...(node.redirects ?? [])] },
        state
      );
      visitRedirects(node.redirects, context, state);
      break;
    case "Command":
      visitCommand(node, context, state);
      break;
    case "Pipeline":
      for (const command of node.commands ?? []) {
        visitNode(command, { ...context, piped: true }, state);
      }
      break;
    case "AndOr":
      visitNodes(node.commands, context, state);
      break;
    case "If":
      visitNode(node.clause, context, state);
      visitNode(node.then, context, state);
      visitNode(node.else, context, state);
      break;
    case "For":
    case "Select":
      visitWords(node.wordlist, context, state);
      visitNode(node.body, context, state);
      break;
    case "ArithmeticFor":
      visitArithmetic(node.initialize, context, state);
      visitArithmetic(node.test, context, state);
      visitArithmetic(node.update, context, state);
      visitNode(node.body, context, state);
      break;
    case "While":
      visitNode(node.clause, context, state);
      visitNode(node.body, context, state);
      break;
    case "Function":
    case "Coproc":
      visitNode(node.body, context, state);
      visitRedirects(node.redirects, context, state);
      break;
    case "Subshell":
    case "BraceGroup":
      visitNode(node.body, context, state);
      break;
    case "CompoundList":
      visitNodes(node.commands, context, state);
      break;
    case "Case":
      visitWord(node.word, context, state);
      for (const item of node.items ?? []) {
        visitWords(item.pattern, context, state);
        visitNode(item.body, context, state);
      }
      break;
    case "TestCommand":
      visitTestExpression(node.expression, context, state);
      break;
    case "ArithmeticCommand":
      visitArithmetic(node.expression, context, state);
      break;
    default:
      break;
  }
}

function visitCommand(node: Command, context: ShellContext, state: ShellState): void {
  if (state.invocations.length < maxInvocations) {
    const redirections = [...context.redirections, ...(node.redirects ?? [])];
    state.invocations.push({
      arguments: node.suffix ?? [],
      assignments: node.prefix ?? [],
      captured: context.captured,
      depth: context.depth,
      executable: staticWordValue(node.name),
      executableText: wordText(node.name),
      hasRedirection: redirections.length > 0,
      nested: context.nested,
      node,
      piped: context.piped,
      redirections,
      source: context.source,
    });
  } else if (!state.errors.some((error) => error.message === "shell invocation limit exceeded")) {
    state.errors.push({ message: "shell invocation limit exceeded", pos: node.pos ?? 0 });
  }
  visitWord(node.name, context, state);
  for (const assignment of node.prefix ?? []) {
    visitWord(assignment.value, context, state);
    visitWords(assignment.array, context, state);
  }
  visitWords(node.suffix, context, state);
  visitRedirects(node.redirects, context, state);
}

function visitNodes(
  nodes: readonly Node[] | undefined,
  context: ShellContext,
  state: ShellState
): void {
  for (const node of nodes ?? []) {
    visitNode(node, context, state);
  }
}

function visitWords(
  words: readonly Word[] | undefined,
  context: ShellContext,
  state: ShellState
): void {
  for (const word of words ?? []) {
    visitWord(word, context, state);
  }
}

function visitWord(word: Word | undefined, context: ShellContext, state: ShellState): void {
  if (!(word && typeof word === "object")) {
    return;
  }
  for (const part of word.parts ?? []) {
    visitWordPart(part, context, state);
  }
}

function visitWordPart(part: WordPart, context: ShellContext, state: ShellState): void {
  if (!(part && typeof part === "object")) {
    return;
  }
  if (part.type === "DoubleQuoted" || part.type === "LocaleString") {
    for (const child of part.parts ?? []) {
      visitWordPart(child, context, state);
    }
    return;
  }
  if (part.type === "ParameterExpansion") {
    visitWord(part.operand, context, state);
    visitWord(part.slice?.offset, context, state);
    visitWord(part.slice?.length, context, state);
    visitWord(part.replace?.pattern, context, state);
    visitWord(part.replace?.replacement, context, state);
    return;
  }
  if (part.type === "ArithmeticExpansion") {
    visitArithmetic(part.expression, context, state);
    return;
  }
  if (part.type === "CommandExpansion" || part.type === "ProcessSubstitution") {
    visitDeferredScript(part.script, context, state);
  }
}

function visitDeferredScript(
  script: ParsedScript | undefined,
  context: ShellContext,
  state: ShellState
): void {
  collectScript(
    script,
    {
      ...context,
      captured: true,
      depth: context.depth + 1,
      nested: true,
      source: "expansion",
    },
    state
  );
}

function visitArithmetic(
  expression: ArithmeticExpression | undefined,
  context: ShellContext,
  state: ShellState
): void {
  if (!(expression && typeof expression === "object")) {
    return;
  }
  switch (expression.type) {
    case "ArithmeticBinary":
      visitArithmetic(expression.left, context, state);
      visitArithmetic(expression.right, context, state);
      break;
    case "ArithmeticUnary":
      visitArithmetic(expression.operand, context, state);
      break;
    case "ArithmeticTernary":
      visitArithmetic(expression.test, context, state);
      visitArithmetic(expression.consequent, context, state);
      visitArithmetic(expression.alternate, context, state);
      break;
    case "ArithmeticGroup":
      visitArithmetic(expression.expression, context, state);
      break;
    case "ArithmeticCommandExpansion":
      visitDeferredScript(expression.script, context, state);
      break;
    default:
      break;
  }
}

function visitTestExpression(
  expression: TestExpression | undefined,
  context: ShellContext,
  state: ShellState
): void {
  if (!(expression && typeof expression === "object")) {
    return;
  }
  switch (expression.type) {
    case "TestUnary":
      visitWord(expression.operand, context, state);
      break;
    case "TestBinary":
      visitWord(expression.left, context, state);
      visitWord(expression.right, context, state);
      break;
    case "TestLogical":
      visitTestExpression(expression.left, context, state);
      visitTestExpression(expression.right, context, state);
      break;
    case "TestNot":
      visitTestExpression(expression.operand, context, state);
      break;
    case "TestGroup":
      visitTestExpression(expression.expression, context, state);
      break;
    default:
      break;
  }
}

function visitRedirects(
  redirects: readonly Redirect[] | undefined,
  context: ShellContext,
  state: ShellState
): void {
  for (const redirect of redirects ?? []) {
    visitWord(redirect.target, context, state);
    visitWord(redirect.body, context, state);
  }
}

function expandStaticExecutors(state: ShellState): void {
  for (const invocation of state.invocations) {
    if (invocation.depth > maxNestedShellDepth) {
      continue;
    }
    const name = executableName(invocation.executable);
    if (shellExecutables.has(name)) {
      expandShellCommand(invocation, state);
      continue;
    }
    if (name === "env") {
      expandEnvCommand(invocation, state);
      continue;
    }
    const commandIndex = wrappedCommandIndex(name, invocation.arguments);
    if (commandIndex !== null) {
      appendWrappedInvocation(invocation, commandIndex, state);
    }
  }
}

function expandShellCommand(invocation: ShellInvocation, state: ShellState): void {
  const values = invocation.arguments.map(staticWordValue);
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === null) {
      return;
    }
    if (value === "--") {
      continue;
    }
    if (!(value.startsWith("-") && value !== "-")) {
      return;
    }
    if (!value.slice(1).includes("c")) {
      continue;
    }
    const nestedSource = values[index + 1];
    if (nestedSource !== null && nestedSource !== undefined) {
      collectSource(nestedSource, nestedContext(invocation, "shell"), state);
    }
    return;
  }
}

function expandEnvCommand(invocation: ShellInvocation, state: ShellState): void {
  const values = invocation.arguments.map(staticWordValue);
  const index = scanEnvCommandOptions(values, invocation, state);
  if (index === null) {
    return;
  }
  appendWrappedInvocation(invocation, index, state);
}

function handleEnvSplitString(
  values: readonly StaticValue[],
  index: number,
  invocation: ShellInvocation,
  state: ShellState
): boolean {
  const value = values[index];
  if (value === "-S" || value === "--split-string") {
    const nestedSource = values[index + 1];
    if (nestedSource !== null && nestedSource !== undefined) {
      collectSource(nestedSource, nestedContext(invocation, "env-split"), state);
    }
    return true;
  }
  if (!(typeof value === "string" && value.startsWith("--split-string="))) {
    return false;
  }
  collectSource(
    value.slice("--split-string=".length),
    nestedContext(invocation, "env-split"),
    state
  );
  return true;
}

function scanEnvCommandOptions(
  values: readonly StaticValue[],
  invocation: ShellInvocation,
  state: ShellState
): number | null {
  let index = 0;
  while (index < values.length) {
    const value = values[index];
    if (value === null) {
      return null;
    }
    if (value === "--" || value === "-") {
      return index + 1;
    }
    if (handleEnvSplitString(values, index, invocation, state)) {
      return null;
    }
    if (environmentAssignment(value)) {
      index += 1;
      continue;
    }
    if (!value.startsWith("-")) {
      return index;
    }
    const consumed = envOptionWidth(value, values[index + 1]);
    if (consumed === 0) {
      return null;
    }
    index += consumed;
  }
  return index;
}

function envOptionWidth(value: string, next: StaticValue | undefined): number {
  if (
    value === "-i" ||
    value === "--ignore-environment" ||
    value === "-0" ||
    value === "--null" ||
    value === "-v" ||
    value === "--debug" ||
    value.startsWith("--unset=") ||
    value.startsWith("--chdir=") ||
    value.startsWith("--argv0=")
  ) {
    return 1;
  }
  if (["-u", "--unset", "-C", "--chdir", "-a", "--argv0"].includes(value)) {
    return next === null || next === undefined ? 0 : 2;
  }
  return 0;
}

function wrappedCommandIndex(name: string, words: readonly Word[]): number | null {
  const values = words.map(staticWordValue);
  if (!values.every((value) => value !== null)) {
    return null;
  }
  if (name === "command") {
    let index = 0;
    while (index < values.length && values[index]?.startsWith("-")) {
      const value = values[index];
      if (value === "--") {
        return index + 1;
      }
      if (value.includes("v") || value.includes("V")) {
        return null;
      }
      if (![...value.slice(1)].every((flag) => flag === "p")) {
        return null;
      }
      index += 1;
    }
    return index;
  }
  if (name === "exec") {
    return execCommandIndex(values);
  }
  if (name === "sudo") {
    return sudoCommandIndex(values);
  }
  return null;
}

function execCommandIndex(values: readonly string[]): number | null {
  let index = 0;
  while (index < values.length) {
    const value = values[index];
    if (value === "--") {
      return index + 1;
    }
    if (!value.startsWith("-") || value === "-") {
      return index;
    }
    if (value === "-a") {
      index += 2;
      continue;
    }
    if (value.startsWith("-a") && value.length > 2) {
      index += 1;
      continue;
    }
    if (![...value.slice(1)].every((flag) => flag === "c" || flag === "l")) {
      return null;
    }
    index += 1;
  }
  return null;
}

const SUDO_NO_COMMAND_OPTIONS = new Set([
  "--edit",
  "--help",
  "--list",
  "--remove-timestamp",
  "--reset-timestamp",
  "--validate",
  "--version",
  "-K",
  "-V",
  "-e",
  "-k",
  "-l",
  "-v",
]);
const SUDO_VALUE_OPTIONS = new Set([
  "--chdir",
  "--close-from",
  "--group",
  "--host",
  "--prompt",
  "--role",
  "--type",
  "--user",
  "-C",
  "-D",
  "-R",
  "-T",
  "-U",
  "-g",
  "-h",
  "-p",
  "-r",
  "-t",
  "-u",
]);
const SUDO_FLAG_OPTIONS = new Set([
  "--askpass",
  "--background",
  "--bell",
  "--login",
  "--non-interactive",
  "--preserve-env",
  "--set-home",
  "--shell",
  "--stdin",
  "-A",
  "-B",
  "-E",
  "-H",
  "-P",
  "-S",
  "-b",
  "-i",
  "-n",
  "-s",
]);
function sudoCommandIndex(values: readonly string[]): number | null {
  let index = 0;
  while (index < values.length) {
    const action = sudoOptionStep(values, index);
    if (action === null) {
      return null;
    }
    if (typeof action === "number") {
      return action;
    }
    index += action.skip;
  }
  return null;
}

function sudoOptionStep(
  values: readonly string[],
  index: number
): number | { skip: number } | null {
  const value = values[index];
  if (value === "--") {
    return index + 1;
  }
  if (environmentAssignment(value)) {
    return { skip: 1 };
  }
  if (!value.startsWith("-") || value === "-") {
    return index;
  }
  const option = value.includes("=") ? value.slice(0, value.indexOf("=")) : value;
  if (SUDO_NO_COMMAND_OPTIONS.has(option)) {
    return null;
  }
  if (value.includes("=") && SUDO_VALUE_OPTIONS.has(option)) {
    return { skip: 1 };
  }
  if (SUDO_VALUE_OPTIONS.has(value)) {
    return values[index + 1] === undefined ? null : { skip: 2 };
  }
  if (SUDO_FLAG_OPTIONS.has(value) || value.startsWith("--preserve-env=")) {
    return { skip: 1 };
  }
  return null;
}

function appendWrappedInvocation(
  invocation: ShellInvocation,
  commandIndex: number,
  state: ShellState
): void {
  const executableWord = invocation.arguments[commandIndex];
  const executable = staticWordValue(executableWord);
  if (
    executable === null ||
    executable === undefined ||
    state.invocations.length >= maxInvocations
  ) {
    return;
  }
  state.invocations.push({
    ...invocation,
    arguments: invocation.arguments.slice(commandIndex + 1),
    depth: invocation.depth + 1,
    executable,
    executableText: wordText(executableWord),
    nested: true,
    source: "wrapper",
  });
}

function nestedContext(invocation: ShellInvocation, source: string): ShellContext {
  return {
    captured: invocation.captured,
    depth: invocation.depth + 1,
    nested: true,
    piped: invocation.piped,
    redirections: invocation.redirections,
    source,
  };
}

function emptyContext(): ShellContext {
  return {
    captured: false,
    depth: 0,
    nested: false,
    piped: false,
    redirections: [],
    source: "direct",
  };
}

function staticWordPart(part: WordPart): boolean {
  if (part?.type === "AnsiCQuoted" || part?.type === "Literal" || part?.type === "SingleQuoted") {
    return true;
  }
  if (part?.type === "DoubleQuoted" || part?.type === "LocaleString") {
    return Array.isArray(part.parts) && part.parts.every(staticWordPart);
  }
  return false;
}

function shellGlobHasMagic(value: string): boolean {
  return new Minimatch(String(value ?? ""), {
    dot: true,
    magicalBraces: true,
    nocase: false,
    nonegate: true,
  }).hasMagic();
}

function environmentAssignment(value: string): boolean {
  const separator = value.indexOf("=");
  if (separator <= 0) {
    return false;
  }
  const name = value.slice(0, separator);
  const first = name.charCodeAt(0);
  if (!((first >= 65 && first <= 90) || (first >= 97 && first <= 122) || first === 95)) {
    return false;
  }
  return [...name.slice(1)].every((character) => {
    const code = character.charCodeAt(0);
    return (
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 95
    );
  });
}
