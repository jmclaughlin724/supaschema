#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { arrayOf, at, stringsOf } from "../../lib/json.mts";
import { assert, ok } from "../lib/assertions.mts";
import { exists, ROOT, readJson, readText } from "../lib/repository.mts";
import {
  claudePreToolUseCommandsFor,
  codexPreToolUseCommandsFor,
  hookHandlers,
  importsNamedBinding,
  runnerDeclaresFunction,
  runnerImportsEvaluateBashPolicy,
  sessionLifecycleEntrypoints,
  sessionLifecycleEntrypointsFor,
} from "./hook-topology.mts";

const claudeHookFiles = [
  ".claude/hooks/supaschema-source-hook.mts",
  ".claude/hooks/guards/bash-policy-checks.mts",
];
const sourceRepoClaudeRegisteredHookPaths = [".claude/hooks/supaschema-source-hook.mts"];
const claudeLifecycleEntrypoints = sessionLifecycleEntrypointsFor(".claude");
const codexLifecycleEntrypoints = sessionLifecycleEntrypointsFor(".codex");
const sourceRepoClaudeContextHooks = [
  ...claudeLifecycleEntrypoints,
  ".claude/hooks/context-user-prompt-submit.mts",
  ".claude/hooks/context-pre-tool-use.mts",
  ".claude/hooks/context-post-tool-use.mts",
  ".claude/hooks/context-post-tool-use-failure.mts",
  ".claude/hooks/context-subagent-start.mts",
  ".claude/hooks/context-task-completed.mts",
  ".claude/hooks/context-subagent-stop.mts",
  ".claude/hooks/context-stop.mts",
];
const codexMirrorHookPaths = [
  ".codex/hooks/supaschema-source-hook.mts",
  ".codex/hooks/guards/bash-policy-checks.mts",
];
const sourceRepoCodexContextHooks = [
  ...codexLifecycleEntrypoints,
  ".codex/hooks/context-user-prompt-submit.mts",
  ".codex/hooks/context-pre-tool-use.mts",
  ".codex/hooks/context-post-tool-use.mts",
  ".codex/hooks/context-post-tool-use-failure.mts",
  ".codex/hooks/context-subagent-start.mts",
  ".codex/hooks/context-task-completed.mts",
  ".codex/hooks/context-subagent-stop.mts",
  ".codex/hooks/context-stop.mts",
];
const codexRegisteredHookPaths = [
  ...codexLifecycleEntrypoints,
  ".codex/hooks/context-user-prompt-submit.mts",
  ".codex/hooks/context-pre-tool-use.mts",
  ".codex/hooks/context-post-tool-use.mts",
  ".codex/hooks/context-subagent-start.mts",
  ".codex/hooks/context-subagent-stop.mts",
  ".codex/hooks/context-stop.mts",
];
const removedHookPaths = [
  ".claude/hooks/auto-diff-on-schema-change.mjs",
  ".claude/hooks/block-generated-migration-edits.mjs",
  ".claude/hooks/context-permission-denied.mjs",
  ".claude/hooks/context-worktree-create.mjs",
  ".claude/hooks/sync-llm-on-claude-surface-change.mjs",
  ".codex/hooks/auto-diff-on-schema-change.mjs",
  ".codex/hooks/block-generated-migration-edits.mjs",
  ".codex/hooks/context-permission-denied.mjs",
  ".codex/hooks/context-worktree-create.mjs",
  ".codex/hooks/sync-llm-on-claude-surface-change.mjs",
  ".codex/hooks/general-guard.mjs",
  "agent-bundle/claude/hooks/guards/bash-policy-checks.mjs",
  "agent-bundle/codex/hooks/general-guard.mjs",
  "agent-bundle/codex/hooks/guards/bash-policy-checks.mjs",
  "scripts/agent-hooks/evidence-gate.mjs",
  "scripts/agent-hooks/merged-branch-state.mjs",
  "scripts/agent-hooks/repository-boundary.mjs",
  "scripts/agent-hooks/response-shape.mjs",
];
const sourceRepoHookRuntimeOwners = [
  ".claude/hooks/supaschema-source-hook.mts",
  "scripts/agent-hooks/hook-entrypoint.mts",
  "scripts/agent-hooks/runner.mts",
  "scripts/agent-hooks/session-lifecycle.mts",
];
const consumerClaudeSettingsFiles = ["npm", "pnpm", "yarn", "bun"].map(
  (packageManager) => `agent-bundle/claude/settings.${packageManager}.json`
);
const contextPreToolMatcher =
  "Agent|Bash|Edit|Glob|Grep|MultiEdit|NotebookEdit|Read|Task|WebFetch|WebSearch|Write|apply_patch";
const claudeEditToolMatcher = "Write|Edit|MultiEdit|apply_patch";
const codexEditToolMatcher = "apply_patch";
const contextPostToolMatcher = "Bash|Read|Skill";

function assertLabeledCommandHandlers(value: unknown, owner: string): void {
  const invalid = hookHandlers(value).filter(
    (handler) =>
      typeof handler.statusMessage !== "string" ||
      handler.statusMessage.trim().length === 0 ||
      handler.statusMessage !== handler.statusMessage.trim() ||
      handler.statusMessage.includes("\n")
  );
  assert(
    invalid.length === 0,
    `${owner} command hook handlers must define a non-empty single-line statusMessage`
  );
}

function assertClaudeSettings(claudeSettings: unknown, root: string): void {
  const settingsText = JSON.stringify(claudeSettings);
  const claudeHandlers = hookHandlers(claudeSettings);
  assertLabeledCommandHandlers(claudeSettings, ".claude/settings.json");
  const claudeRegisteredHookPaths = [
    ...sourceRepoClaudeRegisteredHookPaths,
    ...sourceRepoClaudeContextHooks,
  ];
  const shellQuotedClaudeNodeCommands = [
    ['node "', "$CLAUDE_PROJECT_DIR", '"'].join(""),
    ['node "', "${", "CLAUDE_PROJECT_DIR", "}"].join(""),
  ];
  for (const hook of claudeRegisteredHookPaths) {
    assert(
      settingsText.includes(path.basename(hook)),
      `.claude/settings.json does not register ${hook}`
    );
  }
  assert(
    settingsText.includes("/.claude/hooks/supaschema-source-hook.mts") &&
      settingsText.includes('"generated-artifact-edit"') &&
      settingsText.includes('"schema-write"'),
    ".claude/settings.json must register the tracked source-repo supaschema hook launcher"
  );
  assert(
    !settingsText.includes("/bin/"),
    ".claude/settings.json must use tracked source hook launchers, not package bin wrappers"
  );
  assert(
    !(settingsText.includes('"npx"') && settingsText.includes('"supaschema"')),
    ".claude/settings.json must not use consumer package-manager supaschema commands in this source repo"
  );
  assert(
    !(
      settingsText.includes("auto-diff-on-schema-change.mjs") ||
      settingsText.includes("block-generated-migration-edits.mjs")
    ),
    ".claude/settings.json must not register removed supaschema hook scripts"
  );
  for (const hook of claudeRegisteredHookPaths.filter((item) => item.endsWith(".mts"))) {
    const expectedArg = `\${CLAUDE_PROJECT_DIR}/${hook}`;
    assert(
      claudeHandlers.some(
        (handler) =>
          handler.command === "node" &&
          Array.isArray(handler.args) &&
          handler.args.includes(expectedArg)
      ),
      `.claude/settings.json must register ${hook} as exec-form node command with args`
    );
  }
  const sourceClaudeBashCommands = claudePreToolUseCommandsFor(claudeSettings, "Bash");
  const sourceClaudeContextCommands = sourceClaudeBashCommands.filter((command) =>
    command.includes(".claude/hooks/context-pre-tool-use.mts")
  );
  const sourceClaudeSchemaCommands = sourceClaudeBashCommands.filter(
    (command) =>
      command.includes(".claude/hooks/supaschema-source-hook.mts") &&
      command.includes("generated-artifact-edit")
  );
  assert(
    sourceClaudeContextCommands.length === 1 && sourceClaudeSchemaCommands.length === 0,
    ".claude/settings.json Bash PreToolUse must resolve only through the context hook"
  );
  const claudeContextPreToolUse = arrayOf(at(claudeSettings, "hooks", "PreToolUse")).filter(
    (entry) =>
      hookHandlers(entry).some((handler) =>
        stringsOf(handler.args).some((arg) =>
          arg.endsWith("/.claude/hooks/context-pre-tool-use.mts")
        )
      )
  );
  assert(
    claudeContextPreToolUse.length === 1 &&
      at(claudeContextPreToolUse[0], "matcher") === contextPreToolMatcher,
    `.claude/settings.json context PreToolUse must use ${contextPreToolMatcher}`
  );
  const sourceClaudeApplyPatchSchemaCommands = claudePreToolUseCommandsFor(
    claudeSettings,
    "apply_patch"
  ).filter(
    (command) =>
      command.includes(".claude/hooks/supaschema-source-hook.mts") &&
      command.includes("generated-artifact-edit")
  );
  assert(
    sourceClaudeApplyPatchSchemaCommands.length === 1,
    ".claude/settings.json apply_patch PreToolUse must register the generated-artifact policy hook"
  );
  const claudeProductPreToolUse = arrayOf(at(claudeSettings, "hooks", "PreToolUse")).find((entry) =>
    hookHandlers(entry).some((handler) =>
      stringsOf(handler.args).some((arg) => arg === "generated-artifact-edit")
    )
  );
  assert(
    at(claudeProductPreToolUse, "matcher") === claudeEditToolMatcher,
    `.claude/settings.json generated-artifact PreToolUse must use ${claudeEditToolMatcher}`
  );
  assert(
    !sourceClaudeBashCommands.some((command) =>
      command.includes(".claude/hooks/guards/bash-policy-checks.mts")
    ),
    ".claude/settings.json must not register a direct source Claude Bash guard"
  );
  assert(
    !shellQuotedClaudeNodeCommands.some((fragment) => settingsText.includes(fragment)),
    ".claude/settings.json must use command+args instead of shell-quoted node hook paths"
  );
  for (const removedHook of [
    "skill_session_init.sh",
    "skill_inject.sh",
    "skill_gate.sh",
    "skill_subagent_gate.sh",
    "skill_record.sh",
  ]) {
    assert(
      !exists(`.claude/hooks/${removedHook}`, root),
      `.claude/hooks/${removedHook} should not exist`
    );
    assert(
      !settingsText.includes(removedHook),
      `.claude/settings.json still registers ${removedHook}`
    );
  }
  const claudePostToolUse = arrayOf(at(claudeSettings, "hooks", "PostToolUse"));
  const claudeContextPostToolUse = claudePostToolUse.find((entry) =>
    hookHandlers(entry).some((handler) =>
      stringsOf(handler.args).some((arg) =>
        arg.endsWith("/.claude/hooks/context-post-tool-use.mts")
      )
    )
  );
  assert(
    at(claudeContextPostToolUse, "matcher") === contextPostToolMatcher,
    `.claude/settings.json context PostToolUse must use ${contextPostToolMatcher}`
  );
  for (const commandFragment of ["schema-write"]) {
    const entry = claudePostToolUse.find((candidate) =>
      hookHandlers(candidate).some((handler) =>
        [handler.command, ...stringsOf(handler.args)].join(" ").includes(commandFragment)
      )
    );
    assert(
      at(entry, "matcher") === claudeEditToolMatcher,
      `.claude/settings.json ${commandFragment} PostToolUse must use ${claudeEditToolMatcher}`
    );
  }
  const claudePostToolUseFailure = arrayOf(at(claudeSettings, "hooks", "PostToolUseFailure"));
  const claudePostToolUseFailureText = JSON.stringify(claudePostToolUseFailure);
  assert(
    claudePostToolUseFailureText.includes("context-post-tool-use-failure.mts") &&
      claudePostToolUseFailure.length === 1 &&
      at(claudePostToolUseFailure[0], "matcher") === "Bash" &&
      !claudePostToolUseFailureText.includes("sync-llm-on-claude-surface-change.mjs"),
    ".claude/settings.json must record failed Bash evidence without running surface sync"
  );
  assert(
    at(claudeSettings, "hooks", "PermissionDenied") === undefined,
    ".claude/settings.json must not register PermissionDenied without an explicit retry policy"
  );
  assert(
    !readText("agent-bundle/claude/settings.npm.json", root).includes(
      "sync-llm-on-claude-surface-change.mjs"
    ),
    "agent-bundle/claude/settings.npm.json must strip the source-only surface sync hook"
  );
  assert(
    at(claudeSettings, "hooks", "PostToolBatch") === undefined,
    ".claude/settings.json must not register the removed PostToolBatch wrapper"
  );
  assert(
    Array.isArray(at(claudeSettings, "hooks", "Stop")) &&
      Array.isArray(at(claudeSettings, "hooks", "SubagentStop")),
    ".claude/settings.json must register Stop and SubagentStop continuation hooks"
  );
  assert(
    Array.isArray(at(claudeSettings, "hooks", "TaskCompleted")) &&
      settingsText.includes("context-task-completed.mts") &&
      at(claudeSettings, "hooks", "WorktreeCreate") === undefined,
    ".claude/settings.json must register TaskCompleted and omit WorktreeCreate"
  );
}

function assertCodexConfig(codexConfig: unknown, root: string): void {
  const codexHooksJson = JSON.stringify(codexConfig);
  assertLabeledCommandHandlers(codexConfig, ".codex/hooks.json");
  for (const hook of codexRegisteredHookPaths) {
    assert(
      codexHooksJson.includes(path.basename(hook)),
      `.codex/hooks.json does not register ${hook}`
    );
  }
  assert(
    !codexHooksJson.includes("scripts/agent-hooks"),
    ".codex/hooks.json must use hook entrypoints, not scripts/agent-hooks directly"
  );
  for (const hook of [
    "context-session-start.mts",
    "context-user-prompt-submit.mts",
    "context-pre-tool-use.mts",
    "context-post-tool-use.mts",
    "context-subagent-start.mts",
    "context-subagent-stop.mts",
    "context-stop.mts",
    "context-session-end.mts",
  ]) {
    assert(codexHooksJson.includes(hook), `.codex/hooks.json must register ${hook}`);
  }
  assert(
    !codexHooksJson.includes("general-guard.mjs"),
    ".codex/hooks.json must not register source-repo Codex general-guard fan-out"
  );
  assert(
    codexHooksJson.includes("$(git rev-parse --show-toplevel)") &&
      !codexHooksJson.includes("CODEX_PROJECT_DIR"),
    ".codex/hooks.json must resolve repo-local commands from the git root"
  );
  assert(
    hookHandlers(codexConfig).every(
      (handler) =>
        typeof handler.commandWindows === "string" &&
        handler.commandWindows.includes("git rev-parse --show-toplevel") &&
        handler.commandWindows.includes('do @node "')
    ),
    ".codex/hooks.json must provide git-rooted, echo-suppressed commandWindows overrides"
  );
  assert(
    at(codexConfig, "hooks", "PermissionDenied") === undefined &&
      at(codexConfig, "hooks", "PostToolUseFailure") === undefined,
    ".codex/hooks.json must not register unsupported Codex hook events"
  );
  const codexContextPreToolUse = arrayOf(at(codexConfig, "hooks", "PreToolUse")).filter((entry) =>
    hookHandlers(entry).some((handler) =>
      handler.command.includes(".codex/hooks/context-pre-tool-use.mts")
    )
  );
  assert(
    codexContextPreToolUse.length === 1 &&
      at(codexContextPreToolUse[0], "matcher") === contextPreToolMatcher,
    `.codex/hooks.json context PreToolUse must use ${contextPreToolMatcher}`
  );
  const expectedSchemaCommandsByTool: readonly (readonly [string, number])[] = [
    ["Bash", 0],
    ["apply_patch", 1],
  ];
  for (const [toolName, expectedSchemaCommands] of expectedSchemaCommandsByTool) {
    const commands = codexPreToolUseCommandsFor(codexConfig, toolName);
    const contextCommands = commands.filter((command) =>
      command.includes(".codex/hooks/context-pre-tool-use.mts")
    );
    const schemaCommands = commands.filter(
      (command) =>
        command.includes(".codex/hooks/supaschema-source-hook.mts") &&
        command.includes("generated-artifact-edit")
    );
    assert(
      contextCommands.length === 1 && schemaCommands.length === expectedSchemaCommands,
      `.codex/hooks.json ${toolName} PreToolUse must keep the expected context and generated-artifact hook topology`
    );
  }
  const codexProductPreToolUse = arrayOf(at(codexConfig, "hooks", "PreToolUse")).find((entry) =>
    hookHandlers(entry).some((handler) => handler.command.includes("generated-artifact-edit"))
  );
  assert(
    at(codexProductPreToolUse, "matcher") === codexEditToolMatcher,
    `.codex/hooks.json generated-artifact PreToolUse must use ${codexEditToolMatcher}`
  );
  for (const commandFragment of ["schema-write"]) {
    const entry = arrayOf(at(codexConfig, "hooks", "PostToolUse")).find((candidate) =>
      hookHandlers(candidate).some((handler) => handler.command.includes(commandFragment))
    );
    assert(
      at(entry, "matcher") === codexEditToolMatcher,
      `.codex/hooks.json ${commandFragment} PostToolUse must use ${codexEditToolMatcher}`
    );
  }
  const packageCodexConfig = readJson("agent-bundle/codex/hooks.npm.json", root);
  const packageCodexHooksJson = JSON.stringify(packageCodexConfig);
  const packageCodexHandlers = hookHandlers(packageCodexConfig);
  assert(
    !(
      packageCodexHooksJson.includes("general-guard.mjs") ||
      packageCodexHooksJson.includes("bash-policy-checks.") ||
      packageCodexHooksJson.includes("context-") ||
      packageCodexHooksJson.includes("supaschema-source-hook.") ||
      packageCodexHooksJson.includes("sync-llm-on-claude-surface-change.mjs") ||
      packageCodexHooksJson.includes("scripts/agent-hooks")
    ) &&
      packageCodexHooksJson.includes("hook generated-artifact-edit") &&
      packageCodexHooksJson.includes("hook schema-write"),
    "agent-bundle/codex/hooks.npm.json must contain only Supaschema product hooks"
  );
  assert(
    packageCodexHandlers.length === 2 &&
      packageCodexHandlers.every(
        (handler) =>
          typeof handler.command === "string" &&
          handler.command.includes("supaschema hook") &&
          handler.commandWindows === undefined
      ),
    "agent-bundle Codex handlers must be the two portable Supaschema hook commands"
  );
  const packagePreToolUse = arrayOf(at(packageCodexConfig, "hooks", "PreToolUse"));
  const packagePostToolUse = arrayOf(at(packageCodexConfig, "hooks", "PostToolUse"));
  assert(
    packagePreToolUse.length === 1 &&
      at(packagePreToolUse[0], "matcher") === codexEditToolMatcher &&
      packagePostToolUse.length === 1 &&
      at(packagePostToolUse[0], "matcher") === codexEditToolMatcher,
    "agent-bundle Codex product hooks must use apply_patch"
  );
  assert(
    codexHooksJson.includes(".codex/hooks/supaschema-source-hook.mts") &&
      codexHooksJson.includes("hook generated-artifact-edit") &&
      codexHooksJson.includes("hook schema-write"),
    ".codex/hooks.json must register the tracked source-repo supaschema hook launcher"
  );
  assert(
    !codexHooksJson.includes("bin/"),
    ".codex/hooks.json must use tracked source hook launchers, not package bin wrappers"
  );
  assert(
    !(
      codexHooksJson.includes("npm exec -- supaschema") ||
      codexHooksJson.includes("pnpm exec supaschema") ||
      codexHooksJson.includes("npx --no-install supaschema")
    ),
    ".codex/hooks.json must not use consumer package-manager supaschema commands in this source repo"
  );
  assert(
    !(
      codexHooksJson.includes("auto-diff-on-schema-change.mjs") ||
      codexHooksJson.includes("block-generated-migration-edits.mjs")
    ),
    ".codex/hooks.json must not register removed supaschema hook scripts"
  );
  assert(
    at(codexConfig, "hooks", "TaskCompleted") === undefined &&
      at(codexConfig, "hooks", "WorktreeCreate") === undefined,
    ".codex/hooks.json must omit Claude-only TaskCompleted and removed WorktreeCreate events"
  );
  const codexContextPostToolUse = arrayOf(at(codexConfig, "hooks", "PostToolUse")).find((entry) =>
    hookHandlers(entry).some((handler) =>
      handler.command.includes(".codex/hooks/context-post-tool-use.mts")
    )
  );
  assert(
    at(codexContextPostToolUse, "matcher") === contextPostToolMatcher,
    `.codex/hooks.json context PostToolUse must use ${contextPostToolMatcher}`
  );
}

function assertConsumerClaudeSettings(root: string): void {
  for (const settingsFile of consumerClaudeSettingsFiles) {
    const settings = readJson(settingsFile, root);
    const settingsText = JSON.stringify(settings);
    const handlers = hookHandlers(settings);
    const supaschemaHandlers = handlers.filter(
      (handler) =>
        typeof handler.command === "string" && handler.command.includes("supaschema hook")
    );
    assert(
      handlers.length === 2 &&
        supaschemaHandlers.length === 2 &&
        supaschemaHandlers.every((handler) => handler.args === undefined),
      `${settingsFile} must contain only the two package-manager Supaschema hook commands`
    );
    const preToolUse = arrayOf(at(settings, "hooks", "PreToolUse"));
    const postToolUse = arrayOf(at(settings, "hooks", "PostToolUse"));
    assert(
      preToolUse.length === 1 &&
        at(preToolUse[0], "matcher") === claudeEditToolMatcher &&
        postToolUse.length === 1 &&
        at(postToolUse[0], "matcher") === claudeEditToolMatcher,
      `${settingsFile} product hooks must use ${claudeEditToolMatcher}`
    );
    assert(
      !(settingsText.includes("bash-policy-checks.") || settingsText.includes("general-guard.mjs")),
      `${settingsFile} must not register the repository Bash policy`
    );
  }
}

function assertAgentBundleHookLabels(root: string): void {
  for (const packageManager of ["npm", "pnpm", "yarn", "bun"]) {
    for (const [runtime, path] of [
      ["Claude", `agent-bundle/claude/settings.${packageManager}.json`],
      ["Codex", `agent-bundle/codex/hooks.${packageManager}.json`],
    ]) {
      assertLabeledCommandHandlers(
        readJson(path, root),
        `${runtime} ${packageManager} agent-bundle hook config`
      );
    }
  }
}

export function check(root = ROOT) {
  const sourceRepoAgentRuntimeFiles = [
    ".claude/settings.json",
    "scripts/agent-hooks/command-evidence.mts",
    "scripts/agent-hooks/hook-entrypoint.mts",
    "scripts/agent-hooks/hook-output.mts",
    "scripts/agent-hooks/hook-runtime.mts",
    "scripts/agent-hooks/postgres-ddl.mts",
    "scripts/agent-hooks/response-claims.mts",
    "scripts/agent-hooks/response-evidence.mts",
    "scripts/agent-hooks/runner.mts",
    "scripts/agent-hooks/session-lifecycle.mts",
    "scripts/agent-hooks/shell-command.mts",
    "scripts/agent-hooks/skill-frontmatter.mts",
    "scripts/agent-hooks/state.mts",
  ];
  assert(
    sourceRepoAgentRuntimeFiles.every((file) => exists(file, root)),
    `source-repo agent hook runtime is incomplete; missing ${sourceRepoAgentRuntimeFiles.filter((file) => !exists(file, root)).join(", ")}`
  );
  const hookEntrypointText = readText("scripts/agent-hooks/hook-entrypoint.mts", root);
  const hookRuntimeText = readText("scripts/agent-hooks/hook-runtime.mts", root);
  const hookRunnerText = readText("scripts/agent-hooks/runner.mts", root);
  const hookStateText = readText("scripts/agent-hooks/state.mts", root);
  const sessionLifecycleText = readText("scripts/agent-hooks/session-lifecycle.mts", root);
  const sourceHookText = readText(".claude/hooks/supaschema-source-hook.mts", root);
  const agentMcpText = readText("services/agent-mcp/supaschema_agent_mcp/server.py", root);
  const codexRuntimeConfig = parseToml(readText(".codex/config.toml", root));
  assert(
    at(codexRuntimeConfig, "features", "hooks") === false,
    ".codex/config.toml must keep native Codex hooks disabled"
  );
  assert(
    hookRuntimeText.includes("process.env.CODEX_THREAD_ID") &&
      hookRuntimeText.includes('return runtime === "codex"') &&
      hookEntrypointText.includes("disabledHookResult") &&
      hookEntrypointText.indexOf("disabledHookResult") <
        hookEntrypointText.indexOf("readStdinJson"),
    "the shared hook entrypoint must disable an active Codex runtime before reading hook input"
  );
  assert(
    [hookEntrypointText, sourceHookText].every((source) =>
      source.includes("hookRuntimeDisabled")
    ) &&
      [hookEntrypointText, hookRunnerText, sessionLifecycleText, sourceHookText].every(
        (source) => !source.includes(".codex/config.toml")
      ),
    "every active hook family must delegate Codex hook-disable enforcement to hook-runtime.mts"
  );
  assert(
    sourceHookText.indexOf("hookRuntimeDisabled") < sourceHookText.indexOf("existsSync(cli)"),
    "the standalone source hook must disable Codex before filesystem reads or subprocesses"
  );
  assert(
    !(
      hookStateText.includes(".tmp/agent-hooks") ||
      hookStateText.includes("defaultStateDir") ||
      agentMcpText.includes("STATE_DIR")
    ),
    "repository hook and MCP owners must not synthesize persistent hook state"
  );
  for (const lifecycleEntrypoint of sessionLifecycleEntrypoints) {
    const entrypointText = readText(lifecycleEntrypoint, root);
    assert(
      importsNamedBinding(
        entrypointText,
        lifecycleEntrypoint,
        "../../scripts/agent-hooks/session-lifecycle.mts",
        "runSessionLifecycleEvent"
      ),
      `${lifecycleEntrypoint} must delegate directly to the session lifecycle owner`
    );
    assert(
      !importsNamedBinding(
        entrypointText,
        lifecycleEntrypoint,
        "../../scripts/agent-hooks/runner.mts",
        "runAgentHookEvent"
      ),
      `${lifecycleEntrypoint} must not import the non-lifecycle hook runner`
    );
  }

  for (const hook of [
    ...claudeHookFiles,
    ...sourceRepoClaudeContextHooks,
    ...codexMirrorHookPaths,
    ...sourceRepoCodexContextHooks,
  ]) {
    assert(exists(hook, root), `missing hook ${hook}`);
  }
  for (const hook of removedHookPaths) {
    assert(!exists(hook, root), `${hook} must not exist; remove the stale hook entrypoint`);
  }
  const claudeSettings = readJson(".claude/settings.json", root);
  assertClaudeSettings(claudeSettings, root);
  assertConsumerClaudeSettings(root);
  for (const runtimeOwner of sourceRepoHookRuntimeOwners) {
    assert(
      !readText(runtimeOwner, root).includes("CODEX_PROJECT_DIR"),
      `${runtimeOwner} must derive runtime and project ownership from its entrypoint, not CODEX_PROJECT_DIR`
    );
  }

  const codexConfig = readJson(".codex/hooks.json", root);
  assertCodexConfig(codexConfig, root);
  assertAgentBundleHookLabels(root);
  for (const eventName of ["PreToolUse", "PostToolUse"]) {
    const entries = at(codexConfig, "hooks", eventName);
    assert(Array.isArray(entries), `.codex/hooks.json missing ${eventName} entries`);
    for (const entry of arrayOf(entries)) {
      const matcher = at(entry, "matcher");
      assert(
        typeof matcher === "string" && matcher.length > 0,
        `.codex/hooks.json ${eventName} entries must use explicit matchers`
      );
    }
  }
  const codexPostToolUseText = JSON.stringify(at(codexConfig, "hooks", "PostToolUse") ?? []);
  assert(
    !codexPostToolUseText.includes("sync-llm-on-claude-surface-change.mjs"),
    ".codex/hooks.json must not run agent-surface sync from PostToolUse; sync:llm is an explicit command"
  );
  assert(
    Array.isArray(at(codexConfig, "hooks", "Stop")) &&
      Array.isArray(at(codexConfig, "hooks", "SubagentStop")) &&
      Array.isArray(at(codexConfig, "hooks", "SessionEnd")),
    ".codex/hooks.json must register Stop, SubagentStop, and SessionEnd lifecycle hooks"
  );
  assert(
    runnerImportsEvaluateBashPolicy(hookRunnerText) &&
      runnerDeclaresFunction(hookRunnerText, "bashSafety"),
    "scripts/agent-hooks/runner.mts must own source-repo PreToolUse Bash safety"
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  check();
  ok("AGENT_HOOKS_OK");
}
