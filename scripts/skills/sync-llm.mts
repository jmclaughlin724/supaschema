#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills } from "../agent-hooks/skill-frontmatter.mts";
import { hookMatcherMatchesTool } from "../lib/hook-matcher.mts";
import { at, type JsonRecord } from "../lib/json.mts";
import { agentSurfaceManifest } from "./agent-surface-manifest.mts";
import {
  assertSafeAgentSurfaceSources,
  assertSafeAgentSurfaceTargets,
} from "./agent-surface-safety.mts";
import { bundleDocsFiles } from "./bundle-docs.mts";
import { renderCodexAgent, renderCodexRule } from "./codex-rules.mts";

interface Runner {
  args: string[];
  command: string;
  commandString: string;
}

interface HookHandler extends JsonRecord {
  command: string;
  type: "command";
}

type SurfaceFiles = Map<string, Buffer | string>;

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export function publicSkillNames(root = ROOT): string[] {
  return discoverSkills(root, "claude")
    .filter((skill) => skill.isPublic)
    .map((skill) => skill.name)
    .sort((left, right) => left.localeCompare(right));
}
const claudeProjectDir = shellParameter("CLAUDE_PROJECT_DIR");
const codexProjectDir = ["$(", "git rev-parse --show-toplevel", ")"].join("");
const codexEditTools = ["apply_patch"];
const preToolContextTools = [
  "Agent",
  "Bash",
  "Edit",
  "Glob",
  "Grep",
  "MultiEdit",
  "NotebookEdit",
  "Read",
  "Task",
  "WebFetch",
  "WebSearch",
  "Write",
  "apply_patch",
];
const postToolContextTools = ["Bash", "Read", "Skill"];
const codexEditToolMatcher = codexToolMatcher(codexEditTools);
const codexPreToolContextMatcher = codexToolMatcher(preToolContextTools);
const codexPostToolContextMatcher = codexToolMatcher(postToolContextTools);

export function runCli(argv = process.argv.slice(2), root = ROOT): void {
  if (argv.length > 0) {
    process.stderr.write(`Unknown sync:llm argument(s): ${argv.join(", ")}\n`);
    process.exit(2);
  }

  const result = syncAgentSurfaces({ root });
  process.stdout.write(
    `SYNC_LLM_OK skills=${result.skills} skillTargets=${result.skillTargets} publicSkills=${result.publicSkills} agents=${result.agents} hooks=${result.hooks} codexHookConfig=${result.codexHookConfig} rules=${result.rules} agentBundle=${result.agentBundle}\n`
  );
}

export function syncAgentSurfaces({ root = ROOT }: { root?: string } = {}) {
  assertSafeAgentSurfaceSources(root);
  assertSafeAgentSurfaceTargets(root);
  const skillResult = syncSkills(root);
  const publicSkillResult = syncPublicSkills(root);
  const hookResult = syncDirectoryMirror(root, agentSurfaceManifest.hooks);
  const codexHookConfigResult = syncCodexHookConfig(root);
  const agentResult = syncCodexAgents(root);
  const ruleResult = syncCodexRules(root);
  const agentBundleResult = syncAgentBundle(root);
  assertSafeAgentSurfaceSources(root);
  assertSafeAgentSurfaceTargets(root);

  return {
    agentBundle: agentBundleResult.files,
    agents: agentResult.files,
    codexHookConfig: codexHookConfigResult.files,
    hooks: hookResult.files,
    publicSkills: publicSkillResult.files,
    rules: ruleResult.files,
    skills: skillResult.files,
    skillTargets: skillResult.targets,
  };
}

function syncSkills(root: string): { files: number; targets: number } {
  const { sourceRoot, targetRoots } = agentSurfaceManifest.skills;
  let files = 0;
  let targets = 0;

  for (const targetRoot of targetRoots) {
    const result = syncDirectoryMirror(root, { sourceRoot, targetRoot });
    files = result.files;
    targets += 1;
  }

  return { files, targets };
}

function syncPublicSkills(root: string): { files: number } {
  const { sourceRoot, targetRoot } = agentSurfaceManifest.publicSkills;
  const files = curatedSkillFiles(root, sourceRoot);
  const skillFileCount = files.size;
  const readme = path.join(root, targetRoot, "README.md");
  if (fs.existsSync(readme)) {
    files.set("README.md", fs.readFileSync(readme));
  }
  syncTextFiles(path.join(root, targetRoot), files);
  return { files: skillFileCount };
}

function syncAgentBundle(root: string): { files: number } {
  const targetRootPath = path.join(root, agentSurfaceManifest.agentBundle.targetRoot);
  const files = agentBundleFiles(root);
  syncTextFiles(targetRootPath, files);
  return { files: files.size };
}

function syncCodexHookConfig(root: string): { files: number } {
  const target = path.join(root, agentSurfaceManifest.codexHookConfig.targetFile);
  writeFileIfChanged(target, jsonText(renderSourceCodexHooks(root)));
  return { files: 1 };
}

function agentBundleFiles(root: string): SurfaceFiles {
  const sourceCodexHooks = renderSourceCodexHooks(root);
  const sourcePrompt = agentSurfaceManifest.sourcePrompts;
  const files: SurfaceFiles = new Map([
    ["INSTALL.md", fs.readFileSync(path.join(root, "agent-bundle", "INSTALL.md"), "utf8")],
    ["skills-manifest.json", jsonText({ skills: publicSkillNames(root) })],
    [
      path.relative(agentSurfaceManifest.agentBundle.targetRoot, sourcePrompt.targetFile),
      fs.readFileSync(path.join(root, sourcePrompt.sourceFile), "utf8"),
    ],
    [
      "claude/rules/supaschema.md",
      fs.readFileSync(path.join(root, ".claude/rules/supaschema.md"), "utf8"),
    ],
    [
      "codex/rules/supaschema.rules",
      fs.readFileSync(path.join(root, ".codex/rules/supaschema.rules"), "utf8"),
    ],
  ]);

  for (const packageManager of ["npm", "pnpm", "yarn", "bun"]) {
    const runner = localRunnerForPackageManager(packageManager);
    const claudeSettings = claudeHookConfig(runner);
    const codexHooks = materializeCodexRunner(consumerCodexHooks(sourceCodexHooks), runner);
    files.set(`claude/settings.${packageManager}.json`, jsonText(claudeSettings));
    files.set(`codex/hooks.${packageManager}.json`, jsonText(codexHooks));
  }

  for (const [file, content] of curatedSkillFiles(root, ".agents/skills")) {
    files.set(`agents/skills/${file}`, content);
  }
  for (const [file, content] of curatedSkillFiles(root, ".claude/skills")) {
    files.set(`claude/skills/${file}`, content);
  }

  for (const [file, content] of bundleDocsFiles(root)) {
    files.set(file, content);
  }

  return files;
}

function curatedSkillFiles(root: string, sourceRoot: string): SurfaceFiles {
  const files: SurfaceFiles = new Map();
  for (const skillName of publicSkillNames(root)) {
    const skillRoot = path.join(root, sourceRoot, skillName);
    assertDirectory(skillRoot, `missing curated skill dir ${sourceRoot}/${skillName}`);
    for (const file of listFiles(skillRoot)) {
      files.set(`${skillName}/${file}`, fs.readFileSync(path.join(skillRoot, file)));
    }
  }
  return files;
}

function shellParameter(expression: string): string {
  return ["$", "{", expression, "}"].join("");
}

function codexToolMatcher(tools: readonly string[]): string {
  return tools.map(codexMatcherSegment).join("|");
}

function codexMatcherSegment(tool: string): string {
  const wildcardSuffix = [".", "*"].join("");
  if (tool.endsWith(wildcardSuffix)) {
    return `${escapeCodexMatcherLiteral(tool.slice(0, -wildcardSuffix.length))}.*`;
  }
  return escapeCodexMatcherLiteral(tool);
}

function escapeCodexMatcherLiteral(value: string): string {
  const special = "\\^$+?.()|[]{}";
  let out = "";
  for (const char of value) {
    out += special.includes(char) ? `\\${char}` : char;
  }
  return out;
}

function claudeHookConfig(runner: Runner) {
  return {
    hooks: {
      PostToolUse: [
        {
          hooks: [
            {
              command: `${runner.commandString} hook schema-write`,
              statusMessage: "Running supaschema auto-diff on schema change",
              timeout: 130,
              type: "command",
            },
          ],
          matcher: "Write|Edit|MultiEdit|apply_patch",
        },
      ],
      PreToolUse: [
        {
          hooks: [
            {
              command: `${runner.commandString} hook generated-artifact-edit --runtime claude`,
              statusMessage: "Checking supaschema generated-artifact policy",
              timeout: 10,
              type: "command",
            },
          ],
          matcher: "Write|Edit|MultiEdit|apply_patch",
        },
      ],
    },
  };
}

export function renderSourceCodexHooks(root = ROOT) {
  assertClaudeHookSource(root);
  return {
    hooks: {
      PostToolUse: [
        {
          hooks: [
            codexHookCommand(
              ".codex/hooks/context-post-tool-use.mts",
              10,
              "Recording supaschema hook evidence"
            ),
          ],
          matcher: codexPostToolContextMatcher,
        },
        {
          hooks: [
            codexHookCommand(
              ".codex/hooks/supaschema-source-hook.mts",
              130,
              "Running supaschema auto-diff on schema change",
              "hook schema-write"
            ),
          ],
          matcher: codexEditToolMatcher,
        },
      ],
      PreToolUse: [
        {
          hooks: [
            codexHookCommand(
              ".codex/hooks/context-pre-tool-use.mts",
              10,
              "Checking required supaschema context"
            ),
          ],
          matcher: codexPreToolContextMatcher,
        },
        {
          hooks: [
            codexHookCommand(
              ".codex/hooks/supaschema-source-hook.mts",
              10,
              "Checking supaschema generated-artifact policy",
              "hook generated-artifact-edit --runtime codex"
            ),
          ],
          matcher: codexEditToolMatcher,
        },
      ],
      SessionStart: [
        {
          hooks: [
            codexHookCommand(
              ".codex/hooks/context-session-start.mts",
              10,
              "Refreshing agent hook state"
            ),
          ],
          matcher: "startup|resume|clear|compact",
        },
      ],
      SessionEnd: [
        {
          hooks: [
            codexHookCommand(
              ".codex/hooks/context-session-end.mts",
              2,
              "Clearing supaschema agent hook state"
            ),
          ],
        },
      ],
      SubagentStart: [
        {
          hooks: [
            codexHookCommand(
              ".codex/hooks/context-subagent-start.mts",
              10,
              "Loading supaschema subagent context"
            ),
          ],
        },
      ],
      SubagentStop: [
        {
          hooks: [
            codexHookCommand(
              ".codex/hooks/context-subagent-stop.mts",
              10,
              "Checking supaschema subagent closeout"
            ),
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            codexHookCommand(
              ".codex/hooks/context-stop.mts",
              10,
              "Checking supaschema final-response evidence"
            ),
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            codexHookCommand(
              ".codex/hooks/context-user-prompt-submit.mts",
              10,
              "Checking prompt-scoped supaschema context"
            ),
          ],
        },
      ],
    },
  };
}

function codexHookCommand(relativePath: string, timeout: number, statusMessage: string, args = "") {
  const commandArgs = args ? ` ${args}` : "";
  return {
    command: `node "${codexProjectDir}/${relativePath}"${commandArgs}`,
    commandWindows: `for /f "delims=" %S in ('git rev-parse --show-toplevel') do @node "%S/${relativePath}"${commandArgs}`,
    statusMessage,
    timeout,
    type: "command",
  };
}

function assertClaudeHookSource(root: string): void {
  const settingsPath = path.join(root, ".claude/settings.json");
  if (!fs.existsSync(settingsPath)) {
    return;
  }
  const settings: unknown = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  const hooks = at(settings, "hooks");
  if (!isRecord(hooks)) {
    throw new Error(".claude/settings.json missing hooks");
  }

  for (const [eventName, relativePath] of [
    ["SessionStart", ".claude/hooks/context-session-start.mts"],
    ["UserPromptSubmit", ".claude/hooks/context-user-prompt-submit.mts"],
    ["PreToolUse", ".claude/hooks/context-pre-tool-use.mts"],
    ["PostToolUse", ".claude/hooks/context-post-tool-use.mts"],
    ["PostToolUseFailure", ".claude/hooks/context-post-tool-use-failure.mts"],
    ["SubagentStart", ".claude/hooks/context-subagent-start.mts"],
    ["TaskCompleted", ".claude/hooks/context-task-completed.mts"],
    ["SubagentStop", ".claude/hooks/context-subagent-stop.mts"],
    ["Stop", ".claude/hooks/context-stop.mts"],
    ["SessionEnd", ".claude/hooks/context-session-end.mts"],
  ]) {
    assertClaudeNodeHook(hooks, eventName, relativePath);
  }

  assertSourceClaudeBashPreToolUseTopology(hooks);
  assertClaudeCommand(hooks, "PreToolUse", "generated-artifact-edit");
  assertClaudeCommand(hooks, "PostToolUse", "schema-write");
}

function assertSourceClaudeBashPreToolUseTopology(hooks: JsonRecord): void {
  const entries = hooks.PreToolUse;
  if (!Array.isArray(entries)) {
    throw new Error(".claude/settings.json missing PreToolUse hooks");
  }
  const bashHandlers = entries
    .filter((entry) => claudeMatcherMentionsTool(at(entry, "matcher"), "Bash"))
    .flatMap(hookHandlersFromValue);
  const handlerText = bashHandlers.map(claudeHandlerText).join("\n");
  const contextPath = `${claudeProjectDir}/.claude/hooks/context-pre-tool-use.mts`;
  const contextEntries = entries.filter((entry) =>
    hookHandlersFromValue(entry).some((handler) => claudeHandlerText(handler).includes(contextPath))
  );
  if (!handlerText.includes(contextPath)) {
    throw new Error(
      ".claude/settings.json Bash PreToolUse must resolve through .claude/hooks/context-pre-tool-use.mts"
    );
  }
  const expectedMatcher = preToolContextTools.join("|");
  if (contextEntries.length !== 1 || at(contextEntries[0], "matcher") !== expectedMatcher) {
    throw new Error(`.claude/settings.json context PreToolUse must use matcher ${expectedMatcher}`);
  }
  if (handlerText.includes(".claude/hooks/guards/bash-policy-checks.mts")) {
    throw new Error(
      ".claude/settings.json must not register a direct source Claude Bash guard; context-pre-tool-use.mjs dispatches Bash safety"
    );
  }
}

function claudeMatcherMentionsTool(matcher: unknown, toolName: string): boolean {
  if (typeof matcher !== "string" || matcher.length === 0) {
    return true;
  }
  return hookMatcherMatchesTool(matcher, toolName);
}

function claudeHandlerText(handler: HookHandler): string {
  return [handler.command, ...(Array.isArray(handler.args) ? handler.args : [])].join(" ");
}

function assertClaudeNodeHook(hooks: JsonRecord, eventName: string, relativePath: string): void {
  const handlers = hookHandlersForEvent(hooks, eventName);
  const expectedArg = `${claudeProjectDir}/${relativePath}`;
  if (
    !handlers.some(
      (handler) =>
        handler.command === "node" &&
        Array.isArray(handler.args) &&
        handler.args.includes(expectedArg)
    )
  ) {
    throw new Error(`.claude/settings.json must register ${relativePath} for ${eventName}`);
  }
}

function assertClaudeCommand(hooks: JsonRecord, eventName: string, arg: string): void {
  const handlers = hookHandlersForEvent(hooks, eventName);
  if (!handlers.some((handler) => Array.isArray(handler.args) && handler.args.includes(arg))) {
    throw new Error(`.claude/settings.json must register ${arg} for ${eventName}`);
  }
}

function hookHandlersForEvent(hooks: JsonRecord, eventName: string): HookHandler[] {
  const entries = hooks[eventName];
  if (!Array.isArray(entries)) {
    throw new Error(`.claude/settings.json missing ${eventName} hooks`);
  }
  return hookHandlersFromValue(entries);
}

function isHookHandler(value: JsonRecord): value is HookHandler {
  return value.type === "command" && typeof value.command === "string";
}

function hookHandlersFromValue(value: unknown): HookHandler[] {
  const handlers: HookHandler[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }
    if (!isRecord(value)) {
      return;
    }
    if (isHookHandler(value)) {
      handlers.push(value);
    }
    for (const item of Object.values(value)) {
      visit(item);
    }
  };
  visit(value);
  return handlers;
}

function localRunnerForPackageManager(packageManager: string): Runner {
  if (packageManager === "pnpm") {
    return {
      args: ["exec", "supaschema"],
      command: "pnpm",
      commandString: "pnpm exec supaschema",
    };
  }
  if (packageManager === "yarn") {
    return {
      args: ["exec", "supaschema"],
      command: "yarn",
      commandString: "yarn exec supaschema",
    };
  }
  if (packageManager === "bun") {
    return {
      args: [],
      command: "./node_modules/.bin/supaschema",
      commandString: "./node_modules/.bin/supaschema",
    };
  }
  return {
    args: ["exec", "--", "supaschema"],
    command: "npm",
    commandString: "npm exec -- supaschema",
  };
}

function materializeCodexRunner(value: unknown, runner: Runner): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => materializeCodexRunner(item, runner));
  }
  if (!isRecord(value)) {
    return value;
  }
  const next: JsonRecord = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] =
      key === "command" && typeof item === "string"
        ? materializeSupaschemaCommand(item, runner)
        : materializeCodexRunner(item, runner);
  }
  return next;
}

function materializeSupaschemaCommand(command: string, runner: Runner): string {
  for (const prefix of [
    "npm exec -- supaschema",
    "pnpm exec supaschema",
    "yarn exec supaschema",
    "bunx --no-install supaschema",
    "./node_modules/.bin/supaschema",
    "npx --no-install supaschema",
  ]) {
    if (command.startsWith(prefix)) {
      return `${runner.commandString}${command.slice(prefix.length)}`;
    }
  }
  return command;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function consumerCodexHooks(config: unknown): unknown {
  const next: unknown = structuredClone(config);
  const hooks = at(next, "hooks");
  if (!isRecord(hooks)) {
    return next;
  }
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      continue;
    }
    const consumerEntries = entries
      .map(withoutRepoLocalCodexHooks)
      .filter((entry) => entry !== undefined);
    if (consumerEntries.length > 0) {
      hooks[eventName] = consumerEntries;
    } else {
      delete hooks[eventName];
    }
  }
  return next;
}

function withoutRepoLocalCodexHooks(entry: unknown): unknown {
  if (!isRecord(entry)) {
    return entry;
  }
  if (isRepoLocalCodexHook(entry)) {
    return;
  }
  if (!Array.isArray(entry.hooks)) {
    return consumerCodexHookCommands(entry);
  }
  const hooks = entry.hooks
    .filter((hook) => !isRepoLocalCodexHook(hook))
    .map(consumerCodexHookCommands);
  return hooks.length > 0 ? consumerCodexHookCommands({ ...entry, hooks }) : undefined;
}

function isRepoLocalCodexHook(hook: unknown): boolean {
  return (
    isRecord(hook) &&
    typeof hook.command === "string" &&
    (hook.command.includes("/.codex/hooks/context-") ||
      hook.command.includes("/.codex/hooks/general-guard.mjs") ||
      hook.command.includes("/.codex/hooks/guards/bash-policy-checks.mts") ||
      hook.command.includes("scripts/agent-hooks/"))
  );
}

function consumerCodexHookCommands(entry: unknown): unknown {
  if (!isRecord(entry)) {
    return entry;
  }
  if (typeof entry.command === "string") {
    const command = consumerSupaschemaCommand(entry.command);
    if (command === entry.command) {
      return entry;
    }
    const portableEntry = { ...entry, command };
    Reflect.deleteProperty(portableEntry, "commandWindows");
    return portableEntry;
  }
  return entry;
}

function consumerSupaschemaCommand(command: string): string {
  for (const sourcePrefix of [
    `node "${codexProjectDir}/.codex/hooks/supaschema-source-hook.mts"`,
  ]) {
    if (command.startsWith(sourcePrefix)) {
      return `npm exec -- supaschema${command.slice(sourcePrefix.length)}`;
    }
  }
  return command;
}

function syncDirectoryMirror(
  root: string,
  surface: { sourceRoot: string; targetRoot: string }
): { files: number } {
  const sourceRootPath = path.join(root, surface.sourceRoot);
  const targetRootPath = path.join(root, surface.targetRoot);
  assertDirectory(sourceRootPath, `missing source dir ${surface.sourceRoot}`);
  const sourceFiles = listFiles(sourceRootPath);
  syncCopiedFiles(sourceRootPath, targetRootPath, sourceFiles);
  removeUnmanagedFiles(targetRootPath, new Set(sourceFiles));
  return { files: sourceFiles.length };
}

function syncCodexAgents(root: string): { files: number } {
  const { sourceRoot, targetRoot } = agentSurfaceManifest.agents;
  const sourceRootPath = path.join(root, sourceRoot);
  const targetRootPath = path.join(root, targetRoot);
  if (!fs.existsSync(sourceRootPath)) {
    syncTextFiles(targetRootPath, new Map<string, string>());
    return { files: 0 };
  }

  const sourceFiles = listFiles(sourceRootPath);
  const renderedFiles = new Map<string, string>();
  for (const file of sourceFiles) {
    assertMarkdownFile(sourceRoot, file, "agent");
    const sourcePath = path.join(sourceRootPath, file);
    renderedFiles.set(
      codexTargetPath(file, ".toml"),
      renderCodexAgent(fs.readFileSync(sourcePath, "utf8"), display(root, sourcePath))
    );
  }
  syncTextFiles(targetRootPath, renderedFiles);

  return { files: sourceFiles.length };
}

function syncCodexRules(root: string): { files: number } {
  const { sourceRoot, targetRoot } = agentSurfaceManifest.rules;
  const sourceRootPath = path.join(root, sourceRoot);
  const targetRootPath = path.join(root, targetRoot);
  assertDirectory(sourceRootPath, `missing source rule dir ${sourceRoot}`);

  const sourceFiles = listFiles(sourceRootPath);
  const renderedFiles = new Map<string, string>();
  for (const file of sourceFiles) {
    assertMarkdownFile(sourceRoot, file, "rule");
    const sourcePath = path.join(sourceRootPath, file);
    renderedFiles.set(
      codexTargetPath(file, ".rules"),
      renderCodexRule(fs.readFileSync(sourcePath, "utf8"), display(root, sourcePath))
    );
  }
  syncTextFiles(targetRootPath, renderedFiles);

  return { files: sourceFiles.length };
}

function assertDirectory(dir: string, message: string): void {
  if (!fs.existsSync(dir)) {
    throw new Error(message);
  }
}

function assertMarkdownFile(root: string, file: string, kind: string): void {
  if (!file.endsWith(".md")) {
    throw new Error(`${kind} mirror only supports Markdown sources under ${root}: ${file}`);
  }
}

function writeFileIfChanged(file: string, content: Buffer | string): void {
  const current = readExistingFile(file, Buffer.isBuffer(content) ? undefined : "utf8");
  if (fileContentsEqual(current, content)) {
    return;
  }
  writeFile(file, content);
}

function fileContentsEqual(
  actual: Buffer | string | undefined,
  expected: Buffer | string
): boolean {
  return Buffer.isBuffer(expected)
    ? Buffer.isBuffer(actual) && actual.equals(expected)
    : actual === expected;
}

function syncCopiedFiles(
  sourceRootPath: string,
  targetRootPath: string,
  sourceFiles: readonly string[]
): void {
  fs.mkdirSync(targetRootPath, { recursive: true });
  for (const file of sourceFiles) {
    copyFileIfChanged(path.join(sourceRootPath, file), path.join(targetRootPath, file));
  }
}

function syncTextFiles(targetRootPath: string, filesToText: SurfaceFiles): void {
  fs.mkdirSync(targetRootPath, { recursive: true });
  for (const [file, text] of filesToText) {
    writeFileIfChanged(path.join(targetRootPath, file), text);
  }
  removeUnmanagedFiles(targetRootPath, new Set(filesToText.keys()));
}

function copyFileIfChanged(sourceFile: string, targetFile: string): void {
  const sourceBytes = fs.readFileSync(sourceFile);
  const currentBytes = readExistingFile(targetFile);
  if (Buffer.isBuffer(currentBytes) && currentBytes.equals(sourceBytes)) {
    return;
  }
  writeFile(targetFile, sourceBytes);
}

function readExistingFile(file: string, encoding?: "utf8"): Buffer | string | undefined {
  try {
    return encoding ? fs.readFileSync(file, encoding) : fs.readFileSync(file);
  } catch (error) {
    if (isNotFoundError(error)) {
      return;
    }
    throw error;
  }
}

function writeFile(file: string, content: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function isNotFoundError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function removeUnmanagedFiles(targetRootPath: string, expectedFiles: ReadonlySet<string>): void {
  const unmanaged = listFiles(targetRootPath).filter((file) => !expectedFiles.has(file));
  const preserved = gitIgnoredFiles(targetRootPath, unmanaged);
  for (const file of unmanaged) {
    if (!preserved.has(file)) {
      fs.rmSync(path.join(targetRootPath, file), { force: true });
    }
  }
  pruneEmptyDirectories(targetRootPath);
  fs.mkdirSync(targetRootPath, { recursive: true });
}

const GIT_CHECK_IGNORE_MAX_BUFFER = 64 * 1024 * 1024;

function gitIgnoredFiles(targetRootPath: string, files: readonly string[]): Set<string> {
  if (files.length === 0) {
    return new Set<string>();
  }
  const result = spawnSync("git", ["check-ignore", "--stdin", "-z"], {
    cwd: targetRootPath,
    encoding: "utf8",
    input: files.join("\0"),
    maxBuffer: GIT_CHECK_IGNORE_MAX_BUFFER,
  });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    return new Set<string>();
  }
  return new Set(result.stdout.split("\0").filter((entry) => entry.length > 0));
}

function pruneEmptyDirectories(root: string): void {
  if (!fs.existsSync(root)) {
    return;
  }

  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        visit(path.join(dir, entry.name));
      }
    }
    if (dir !== root && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
    }
  };
  visit(root);
}

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) {
    return [];
  }
  const rootStats = fs.lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(`agent-surface source must be a regular directory: ${root}`);
  }
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        out.push(path.relative(root, absolute).split(path.sep).join("/"));
      } else if (entry.isSymbolicLink()) {
        throw new Error(`agent-surface directory contains a symbolic link: ${absolute}`);
      }
    }
  };
  visit(root);
  return out.sort((left, right) => Number(left > right) - Number(left < right));
}

function codexTargetPath(file: string, extension: string): string {
  return file.endsWith(".md") ? `${file.slice(0, -3)}${extension}` : `${file}${extension}`;
}

function display(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCli();
}
