import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import {
  genericMigrationsDir,
  genericProviderPreset,
  genericSchemaPath,
  mergeInstalledConfig,
  providerMigrationsDirs,
  providerPresets,
  providerSchemaPaths,
} from "./config-contract.mjs";

const defaultPackageRoot = fileURLToPath(new URL("../", import.meta.url));
const manifestPath = ".supaschema/install.json";
const agentBundleInstructions = "node_modules/supaschema/agent-bundle/INSTALL.md";
const pnpmWorkspaceFile = "pnpm-workspace.yaml";
const pnpmBuildApprovalLine = "  supaschema: true";
const packageScripts = {
  "supaschema:check": "supaschema check",
  "supaschema:diff": "supaschema diff",
  "supaschema:stage": "supaschema stage",
  "supaschema:types": "supaschema types",
};
const agentBundleCopies = [
  ["agents/prompts/supaschema-install.md", ".agents/prompts/supaschema-install.md"],
  ["claude/rules/supaschema.md", ".claude/rules/supaschema.md"],
  ["codex/rules/supaschema.rules", ".codex/rules/supaschema.rules"],
];
const claudeProjectDirExpression = ["$", "{CLAUDE_PROJECT_DIR}"].join("");
const codexProjectDirExpression = ["$", "{CODEX_PROJECT_DIR:-$PWD}"].join("");
const obsoleteAgentBundleHookCommands = new Set([
  `node ${claudeProjectDirExpression}/.claude/hooks/sync-llm-on-claude-surface-change.mjs`,
  `node ${codexProjectDirExpression}/.codex/hooks/sync-llm-on-claude-surface-change.mjs`,
]);
const retiredAgentBundleHookCommandFragments = [
  ".claude/hooks/guards/bash-policy-checks.mjs",
  ".codex/hooks/general-guard.mjs",
];
const obsoleteAgentBundleHookFiles = [
  ".claude/hooks/sync-llm-on-claude-surface-change.mjs",
  ".codex/hooks/sync-llm-on-claude-surface-change.mjs",
];
const obsoleteAgentBundleHookSha256 =
  "2b6979dc84aad94b23f54ac5804b1809322eac2b65fa8574e74c242419c0149f";
const obsoleteAgentBundleHookName = "sync-llm-on-claude-surface-change.mjs";
const inventoryWorkflowOverrides = {
  migration_sync: "manual",
  schema_diff: "manual",
};
const ignoredSqlCandidateDirNames = new Set([
  "debug",
  "fixtures",
  "generated",
  "logs",
  "seeds",
  "snippets",
  "templates",
  "tests",
  "tmp",
]);
const skippedDirNames = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".supaschema",
  "coverage",
  "dist",
  "node_modules",
  "out",
]);
const databaseUrlEnvPriority = [
  "DIRECT_URL",
  "DATABASE_DIRECT_URL",
  "POSTGRES_URL_NON_POOLING",
  "SUPABASE_DB_URL",
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "POSTGRES_DATABASE_URL",
  "PGDATABASE_URL",
];
export async function scaffoldProject({
  targetDir,
  packageRoot = defaultPackageRoot,
  packageVersion,
  interactive = false,
  dryRun = false,
  repair = false,
}) {
  const installed = [];
  const scan = scanProject(targetDir);
  const existingConfig = readExistingConfig(targetDir);
  const selection = await resolvePathSelection(targetDir, scan, existingConfig, interactive);
  const configContents = scaffoldConfigAndDirectories({
    dryRun,
    existingConfig,
    installed,
    repair,
    selection,
    targetDir,
  });

  const packageManager = detectPackageManager(targetDir);
  if (ensurePnpmBuildApproval({ dryRun, packageManager, targetDir })) {
    installed.push("pnpm build approval");
  }

  if (ensurePackageScripts({ dryRun, repair, targetDir })) {
    installed.push("package scripts");
  }

  const agentBundle = installAgentBundle({
    dryRun,
    packageManager,
    packageRoot,
    targetDir,
  });
  if (agentBundle.changed) {
    installed.push("agent bundle");
  }

  const installStateChanged = writeInstallState({
    dryRun,
    existingConfig,
    packageVersion,
    scan,
    selection,
    targetDir,
  });
  if (selection.pathConfirmationNeeded && installStateChanged) {
    installed.push("manifest");
  } else if (!selection.pathConfirmationNeeded && installStateChanged) {
    installed.push("manifest cleanup");
  }

  return {
    agentBundle,
    config: configContents === undefined ? undefined : JSON.parse(configContents),
    dryRun,
    existingConfig,
    installed,
    pathConfirmationNeeded: selection.pathConfirmationNeeded,
    preserved: agentBundle.preserved,
    selection,
    skipped: agentBundle.skipped,
  };
}

function scaffoldConfigAndDirectories({
  dryRun,
  existingConfig,
  installed,
  repair,
  selection,
  targetDir,
}) {
  const configContents = selection.pathConfirmationNeeded
    ? undefined
    : scaffoldConfig(selection, existingConfig.parsed);

  const configChanged =
    configContents !== undefined &&
    shouldWriteConfig(existingConfig, repair) &&
    writeProjectFile(targetDir, "supaschema.config.json", configContents, { dryRun });
  if (configChanged) {
    installed.push(existingConfig.exists ? "config repair" : "config");
  }

  const directoriesChanged =
    !selection.pathConfirmationNeeded &&
    createConfiguredDirectories(targetDir, selection, { dryRun });
  if (directoriesChanged) {
    installed.push("directories");
  }

  return configContents;
}

function detectPackageManager(projectDir) {
  const manifestSignals = [];
  const lockfileSignals = [];
  for (const dir of packageManagerEvidenceDirs(projectDir)) {
    const manifest = readJson(join(dir, "package.json"));
    const manifestManager = manifestPackageManager(manifest);
    if (manifestManager !== undefined) {
      manifestSignals.push(manifestManager);
    }
    lockfileSignals.push(...lockfilePackageManagers(dir));
  }
  const signals = [...new Set([...manifestSignals, ...lockfileSignals])];
  if (signals.length > 1) {
    throw new Error(`conflicting package-manager signals: ${signals.join(", ")}`);
  }
  return signals[0] ?? "npm";
}

function packageManagerEvidenceDirs(projectDir) {
  if (!(hasPackageManagerEvidence(projectDir) || existsSync(join(projectDir, "package.json")))) {
    return [projectDir];
  }
  const dirs = [];
  let current = projectDir;
  while (true) {
    dirs.push(current);
    if (current !== projectDir && hasPackageManagerEvidence(current)) {
      return dirs;
    }
    if (current === projectDir && hasPackageManagerEvidence(current)) {
      return dirs;
    }
    const parent = dirname(current);
    if (parent === current) {
      return dirs;
    }
    current = parent;
  }
}

function hasPackageManagerEvidence(dir) {
  const manifest = readJson(join(dir, "package.json"));
  return (
    manifestPackageManager(manifest) !== undefined ||
    manifestHasWorkspaces(manifest) ||
    lockfilePackageManagers(dir).length > 0
  );
}

function manifestHasWorkspaces(manifest) {
  return Array.isArray(manifest?.workspaces) || isRecord(manifest?.workspaces);
}

function manifestPackageManager(manifest) {
  const direct = packageManagerName(manifest?.packageManager);
  if (direct !== undefined) {
    return direct;
  }
  return packageManagerName(manifest?.devEngines?.packageManager);
}

function packageManagerName(value) {
  if (typeof value === "string") {
    return packageManagerNameFromSpec(value);
  }
  if (isRecord(value) && typeof value.name === "string") {
    return packageManagerNameFromSpec(value.name);
  }
}

function packageManagerNameFromSpec(value) {
  for (const manager of ["npm", "pnpm", "yarn", "bun"]) {
    if (value === manager || value.startsWith(`${manager}@`)) {
      return manager;
    }
  }
}

function lockfilePackageManagers(dir) {
  const managers = [];
  if (existsSync(join(dir, "package-lock.json")) || existsSync(join(dir, "npm-shrinkwrap.json"))) {
    managers.push("npm");
  }
  if (existsSync(join(dir, "pnpm-lock.yaml")) || existsSync(join(dir, "pnpm-workspace.yaml"))) {
    managers.push("pnpm");
  }
  if (existsSync(join(dir, "yarn.lock"))) {
    managers.push("yarn");
  }
  if (existsSync(join(dir, "bun.lock")) || existsSync(join(dir, "bun.lockb"))) {
    managers.push("bun");
  }
  return managers;
}

function ensurePnpmBuildApproval({ dryRun, packageManager, targetDir }) {
  if (packageManager !== "pnpm") {
    return false;
  }
  const path = findPnpmWorkspaceFile(targetDir);
  if (path === undefined) {
    return false;
  }
  const current = readText(path);
  if (current === undefined) {
    return false;
  }
  const next = withPnpmBuildApproval(current);
  if (next === current) {
    return false;
  }
  if (!dryRun) {
    writeFileAtomic(path, next);
  }
  return true;
}

function findPnpmWorkspaceFile(targetDir) {
  let current = targetDir;
  while (true) {
    const candidate = join(current, pnpmWorkspaceFile);
    if (existsSync(candidate)) {
      return candidate;
    }
    const parent = dirname(current);
    if (parent === current) {
      return;
    }
    current = parent;
  }
}

function withPnpmBuildApproval(text) {
  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }
  const allowBuildsIndex = topLevelKeyIndex(lines, "allowBuilds:");
  if (allowBuildsIndex === -1) {
    const next = [...lines];
    if (next.length > 0 && next.at(-1) !== "") {
      next.push("");
    }
    next.push("allowBuilds:", pnpmBuildApprovalLine);
    return `${next.join("\n")}\n`;
  }
  const blockEnd = topLevelBlockEnd(lines, allowBuildsIndex);
  const entryIndex = pnpmBuildApprovalEntryIndex(lines, allowBuildsIndex + 1, blockEnd);
  const next = [...lines];
  if (entryIndex === -1) {
    next.splice(blockEnd, 0, pnpmBuildApprovalLine);
  } else {
    next[entryIndex] = pnpmBuildApprovalLine;
  }
  return `${next.join("\n")}\n`;
}

function topLevelKeyIndex(lines, key) {
  return lines.indexOf(key);
}

function topLevelBlockEnd(lines, start) {
  for (let index = start + 1; index < lines.length; index += 1) {
    if (isTopLevelYamlKey(lines[index])) {
      return index;
    }
  }
  return lines.length;
}

function isTopLevelYamlKey(line) {
  return (
    line.length > 0 &&
    !line.startsWith(" ") &&
    !line.startsWith("\t") &&
    !line.startsWith("#") &&
    !line.startsWith("-") &&
    line.includes(":")
  );
}

function pnpmBuildApprovalEntryIndex(lines, start, end) {
  for (let index = start; index < end; index += 1) {
    const line = lines[index].trimStart();
    const separator = line.indexOf(":");
    const key = separator === -1 ? line : line.slice(0, separator).trim();
    if (key === "supaschema" || key === '"supaschema"' || key === "'supaschema'") {
      return index;
    }
  }
  return -1;
}

function ensurePackageScripts({ dryRun, repair, targetDir }) {
  const path = join(targetDir, "package.json");
  const manifest = readJson(path);
  if (!isRecord(manifest)) {
    return false;
  }
  const existingScripts = isRecord(manifest.scripts) ? manifest.scripts : {};
  const nextScripts = { ...existingScripts };
  let changed = !isRecord(manifest.scripts);
  for (const [name, command] of Object.entries(packageScripts)) {
    if (!(name in existingScripts) || (repair && existingScripts[name] !== command)) {
      nextScripts[name] = command;
      changed = true;
    }
  }
  if (!changed) {
    return false;
  }
  const next = { ...manifest, scripts: nextScripts };
  if (!dryRun) {
    writeFileAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
  }
  return true;
}

function installAgentBundle({ dryRun, packageManager, packageRoot, targetDir }) {
  const result = {
    changed: false,
    files: [],
    installed: true,
    instructions: agentBundleInstructions,
    preserved: [],
    skipped: [],
  };
  for (const [source, target] of agentBundleCopies) {
    installAgentBundleTextFile({ dryRun, packageRoot, result, source, target, targetDir });
  }
  installAgentBundleSkills({ dryRun, packageRoot, result, targetDir });
  const claudeSource = `claude/settings.${packageManager}.json`;
  const codexSource = `codex/hooks.${packageManager}.json`;
  const claudeConfig = mergeAgentBundleJsonFile({
    dryRun,
    packageRoot,
    result,
    source: claudeSource,
    target: ".claude/settings.json",
    targetDir,
  });
  const codexConfig = mergeAgentBundleJsonFile({
    dryRun,
    packageRoot,
    result,
    source: codexSource,
    target: ".codex/hooks.json",
    targetDir,
  });
  removeObsoleteAgentBundleHookFile({
    config: claudeConfig,
    dryRun,
    path: obsoleteAgentBundleHookFiles[0],
    result,
    targetDir,
  });
  removeObsoleteAgentBundleHookFile({
    config: codexConfig,
    dryRun,
    path: obsoleteAgentBundleHookFiles[1],
    result,
    targetDir,
  });
  result.installed = result.skipped.length === 0;
  return result;
}

function installAgentBundleSkills({ dryRun, packageRoot, result, targetDir }) {
  const manifestPath = "skills-manifest.json";
  const manifest = parseRequiredJson(
    readRequiredAgentBundleFile(packageRoot, manifestPath),
    manifestPath
  );
  if (!Array.isArray(manifest.skills)) {
    throw new Error("agent bundle skills manifest must contain a skills array");
  }

  const seen = new Set();
  for (const skillName of manifest.skills) {
    if (
      typeof skillName !== "string" ||
      !isAgentBundleSkillName(skillName) ||
      seen.has(skillName)
    ) {
      throw new Error(`invalid agent bundle skill name: ${String(skillName)}`);
    }
    seen.add(skillName);

    for (const [sourceSurface, targetSurface] of [
      ["agents", ".agents"],
      ["claude", ".claude"],
    ]) {
      const sourceRoot = `${sourceSurface}/skills/${skillName}`;
      const files = listAgentBundleFiles(packageRoot, sourceRoot);
      if (!files.includes("SKILL.md")) {
        throw new Error(`missing packaged agent bundle skill: agent-bundle/${sourceRoot}/SKILL.md`);
      }
      for (const file of files) {
        installAgentBundleTextFile({
          dryRun,
          packageRoot,
          result,
          source: `${sourceRoot}/${file}`,
          target: `${targetSurface}/skills/${skillName}/${file}`,
          targetDir,
        });
      }
    }
  }
}

function isAgentBundleSkillName(value) {
  return value
    .split("-")
    .every(
      (segment) =>
        segment.length > 0 &&
        [...segment].every(
          (character) =>
            (character >= "a" && character <= "z") || (character >= "0" && character <= "9")
        )
    );
}

function listAgentBundleFiles(packageRoot, relativeRoot) {
  const root = join(packageRoot, "agent-bundle", relativeRoot);
  if (!(existsSync(root) && statSync(root).isDirectory())) {
    throw new Error(`missing packaged agent bundle directory: agent-bundle/${relativeRoot}`);
  }

  const files = [];
  const visit = (dir) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name)
    );
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.isFile()) {
        files.push(relative(root, path).split(sep).join("/"));
      } else {
        throw new Error(`unsupported packaged agent bundle entry: ${relativeRoot}/${entry.name}`);
      }
    }
  };
  visit(root);
  return files;
}

function installAgentBundleTextFile({ dryRun, packageRoot, result, source, target, targetDir }) {
  const contents = readRequiredAgentBundleFile(packageRoot, source);
  const destination = join(targetDir, target);
  const existing = readText(destination);
  if (existing !== undefined) {
    if (existing !== contents) {
      result.preserved.push(target);
    }
    return;
  }
  if (!dryRun) {
    writeFileAtomic(destination, contents);
  }
  result.changed = true;
  result.files.push(target);
}

function mergeAgentBundleJsonFile({ dryRun, packageRoot, result, source, target, targetDir }) {
  const incoming = parseRequiredJson(readRequiredAgentBundleFile(packageRoot, source), source);
  const destination = join(targetDir, target);
  const existingContents = readText(destination);
  if (existingContents === undefined) {
    const serialized = `${JSON.stringify(incoming, null, 2)}\n`;
    if (!dryRun) {
      writeFileAtomic(destination, serialized);
    }
    result.changed = true;
    result.files.push(target);
    return incoming;
  }
  const existing = parseOptionalJson(existingContents);
  if (!isRecord(existing)) {
    result.skipped.push(`${target} (not a JSON object)`);
    return;
  }
  const cleaned = removeObsoleteAgentBundleHooks(existing);
  const merged = mergeHookConfig(cleaned.value, incoming);
  result.skipped.push(...merged.skipped.map((item) => `${target} ${item}`));
  if (!(cleaned.changed || merged.changed)) {
    return merged.value;
  }
  if (!dryRun) {
    writeFileAtomic(destination, `${JSON.stringify(merged.value, null, 2)}\n`);
  }
  result.changed = true;
  result.files.push(target);
  return merged.value;
}

function removeObsoleteAgentBundleHooks(config) {
  if (!isRecord(config.hooks)) {
    return { changed: false, value: config };
  }
  const hooks = {};
  let changed = false;
  for (const [event, entries] of Object.entries(config.hooks)) {
    if (!Array.isArray(entries)) {
      hooks[event] = entries;
      continue;
    }
    const retainedEntries = [];
    for (const entry of entries) {
      if (!(isRecord(entry) && Array.isArray(entry.hooks))) {
        retainedEntries.push(entry);
        continue;
      }
      const retainedHooks = entry.hooks.filter((hook) => !isRetiredAgentBundleHook(hook));
      if (retainedHooks.length === entry.hooks.length) {
        retainedEntries.push(entry);
        continue;
      }
      changed = true;
      if (retainedHooks.length > 0) {
        retainedEntries.push({ ...entry, hooks: retainedHooks });
      }
    }
    if (retainedEntries.length > 0 || entries.length === 0) {
      hooks[event] = retainedEntries;
    }
  }
  return { changed, value: changed ? { ...config, hooks } : config };
}

function isRetiredAgentBundleHook(hook) {
  const identity = hookCommandIdentity(hook);
  return (
    identity !== undefined &&
    (obsoleteAgentBundleHookCommands.has(identity) ||
      retiredAgentBundleHookCommandFragments.some((fragment) => identity.includes(fragment)))
  );
}

function removeObsoleteAgentBundleHookFile({ config, dryRun, path, result, targetDir }) {
  const destination = join(targetDir, path);
  if (!existsSync(destination)) {
    return;
  }
  if (
    config === undefined ||
    JSON.stringify(config).includes(obsoleteAgentBundleHookName) ||
    !isRegularFile(destination) ||
    fileSha256(destination) !== obsoleteAgentBundleHookSha256
  ) {
    if (!result.preserved.includes(path)) {
      result.preserved.push(path);
    }
    return;
  }
  if (!dryRun) {
    unlinkSync(destination);
  }
  result.changed = true;
  result.files.push(path);
}

function isRegularFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function mergeHookConfig(existing, incoming) {
  if (!(isRecord(incoming) && isRecord(incoming.hooks))) {
    throw new Error("agent bundle hook config must contain a hooks object");
  }
  const value = { ...existing };
  const existingHooks = isRecord(existing.hooks) ? existing.hooks : {};
  const hooks = { ...existingHooks };
  const skipped = [];
  let changed = !isRecord(existing.hooks);
  for (const [event, incomingEntries] of Object.entries(incoming.hooks)) {
    if (!Array.isArray(incomingEntries)) {
      throw new Error(`agent bundle hooks.${event} must be an array`);
    }
    const existingEntries = hooks[event];
    if (existingEntries !== undefined && !Array.isArray(existingEntries)) {
      skipped.push(`hooks.${event} is not an array`);
      continue;
    }
    const nextEntries = Array.isArray(existingEntries) ? [...existingEntries] : [];
    for (const incomingEntry of incomingEntries) {
      const mergeResult = mergeHookEntry(nextEntries, incomingEntry);
      if (mergeResult === "changed") {
        changed = true;
      }
    }
    hooks[event] = nextEntries;
  }
  value.hooks = hooks;
  return { changed, skipped, value };
}

function mergeHookEntry(entries, incomingEntry) {
  const incomingCommandIds = hookEntryCommandIdentities(incomingEntry);
  const existingIndex =
    incomingCommandIds.length > 0
      ? entries.findIndex((entry) =>
          hookEntryCommandIdentities(entry).some((id) => incomingCommandIds.includes(id))
        )
      : -1;
  if (existingIndex >= 0) {
    const before = JSON.stringify(entries);
    mergeMatchingHookEntry(entries, existingIndex, incomingEntry, incomingCommandIds);
    if (before === JSON.stringify(entries)) {
      return "unchanged";
    }
    return "changed";
  }
  if (entries.some((entry) => JSON.stringify(entry) === JSON.stringify(incomingEntry))) {
    return "unchanged";
  }
  entries.push(incomingEntry);
  return "changed";
}

function mergeMatchingHookEntry(entries, existingIndex, incomingEntry, incomingCommandIds) {
  const existingEntry = entries[existingIndex];
  if (!(isRecord(existingEntry) && isRecord(incomingEntry))) {
    entries[existingIndex] = incomingEntry;
    return;
  }
  const existingHooks = Array.isArray(existingEntry.hooks) ? existingEntry.hooks : [];
  const retainedHooks = existingHooks.filter((hook) => {
    const id = hookCommandIdentity(hook);
    return id === undefined || !incomingCommandIds.includes(id);
  });
  if (retainedHooks.length === 0) {
    entries[existingIndex] = incomingEntry;
    return;
  }
  entries[existingIndex] = { ...existingEntry, hooks: retainedHooks };
  if (!entries.some((entry, index) => index !== existingIndex && sameJson(entry, incomingEntry))) {
    entries.splice(existingIndex + 1, 0, incomingEntry);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hookEntryCommandIdentities(entry) {
  if (!(isRecord(entry) && Array.isArray(entry.hooks))) {
    return [];
  }
  return entry.hooks.flatMap((hook) => {
    const identity = hookCommandIdentity(hook);
    return identity === undefined ? [] : [identity];
  });
}

function hookCommandIdentity(hook) {
  if (!isRecord(hook) || typeof hook.command !== "string") {
    return;
  }
  const commandLine = [hook.command, ...(Array.isArray(hook.args) ? hook.args.map(String) : [])]
    .join(" ")
    .replaceAll('"', "");
  const supaschemaHook = supaschemaHookIdentity(commandLine);
  if (supaschemaHook !== undefined) {
    return supaschemaHook;
  }
  return commandLine;
}

function supaschemaHookIdentity(commandLine) {
  if (commandLine.includes("supaschema hook generated-migration-edit")) {
    return "supaschema hook generated-artifact-edit";
  }
  for (const name of ["generated-artifact-edit", "schema-write"]) {
    if (commandLine.includes(`supaschema hook ${name}`)) {
      return `supaschema hook ${name}`;
    }
  }
}

function readRequiredAgentBundleFile(packageRoot, relativePath) {
  const path = join(packageRoot, "agent-bundle", relativePath);
  const contents = readText(path);
  if (contents === undefined) {
    throw new Error(`missing packaged agent bundle file: agent-bundle/${relativePath}`);
  }
  return contents;
}

function parseRequiredJson(contents, path) {
  const parsed = parseOptionalJson(contents);
  if (!isRecord(parsed)) {
    throw new Error(`agent bundle JSON must be an object: agent-bundle/${path}`);
  }
  return parsed;
}

function parseOptionalJson(contents) {
  try {
    return JSON.parse(contents);
  } catch {
    // Optional JSON inputs are ignored when they are malformed.
  }
}

function readExistingConfig(projectDir) {
  const jsonPath = join(projectDir, "supaschema.config.json");
  if (existsSync(jsonPath)) {
    return effectiveExistingConfig(readJson(jsonPath), {
      exists: true,
      kind: "json",
      path: "supaschema.config.json",
    });
  }
  return { exists: false };
}

function effectiveExistingConfig(parsed, metadata) {
  const schemaPaths =
    Array.isArray(parsed?.schemaPaths) && parsed.schemaPaths.length > 0
      ? parsed.schemaPaths.map(String)
      : [genericSchemaPath];
  const migrationsDir =
    typeof parsed?.migrationsDir === "string" && parsed.migrationsDir.length > 0
      ? parsed.migrationsDir
      : genericMigrationsDir;
  return {
    adapter: parsed?.adapter === "auto" ? "auto" : undefined,
    configConfirmationNeeded: metadata.configConfirmationNeeded === true,
    exists: true,
    kind: metadata.kind,
    migrationsDir,
    parsed,
    path: metadata.path,
    provider: undefined,
    schemaPaths,
  };
}

async function resolvePathSelection(target, scan, existingConfig, interactive) {
  const defaults = projectDefaults(target);
  if (existingConfig.exists) {
    return {
      adapter: existingConfig.adapter,
      candidates: scan,
      databaseUrls: defaults.databaseUrls,
      migrationsDir: existingConfig.migrationsDir,
      pathConfirmationNeeded: false,
      provider: existingConfig.provider ?? defaults.provider,
      schemaPaths: existingConfig.schemaPaths,
      source: "existing-config",
    };
  }

  const schema = selectCandidate(scan.schemaPaths, defaults.schemaPath);
  const migrations = selectCandidate(scan.migrationsDirs, defaults.migrationsDir);
  const schemaConfirmationReasons = schemaPathConfirmationReasons(
    target,
    schema,
    defaults.provider?.id
  );
  const workflowProfile = schemaConfirmationReasons.length > 0 ? "supabase-inventory" : "default";
  let selection = {
    adapter: defaults.adapter,
    candidates: scan,
    databaseUrls: defaults.databaseUrls,
    migrationsDir: migrations.path,
    pathConfirmationNeeded: schema.needsConfirmation || migrations.needsConfirmation,
    pendingReasons: pendingPathReasons(schema, migrations),
    provider: defaults.provider,
    schemaPaths: [schema.path],
    source: selectionSource(schema, migrations, defaults),
    workflowOverrides:
      workflowProfile === "supabase-inventory" ? inventoryWorkflowOverrides : undefined,
    workflowProfile,
  };

  if (selection.pathConfirmationNeeded && interactive && canPrompt()) {
    selection = await promptForSelection(target, selection);
  }

  return selection;
}

function pendingPathReasons(schema, migrations) {
  const reasons = [];
  if (schema.needsConfirmation) {
    reasons.push("multiple schema path candidates matched");
  }
  if (migrations.needsConfirmation) {
    reasons.push("multiple migrations directory candidates matched");
  }
  return reasons;
}

function schemaPathConfirmationReasons(projectDir, schema, providerId) {
  if (providerId !== "supabase" || schema.needsConfirmation) {
    return [];
  }
  const reasons = [];
  if (supabaseOwnerMarksSchemaInventory(projectDir, schema.path)) {
    reasons.push("supabase owner marks schema tree as inventory");
  }
  if (existsSync(join(projectDir, schema.path, "_bootstrap"))) {
    reasons.push("supabase schema tree contains _bootstrap inventory");
  }
  return reasons;
}

function supabaseOwnerMarksSchemaInventory(projectDir, schemaPath) {
  const owner = readText(join(projectDir, "supabase", "AGENTS.md"));
  if (owner === undefined) {
    return false;
  }
  return owner.includes(schemaPath) && owner.includes("not the routine migration generator input");
}

function selectionSource(schema, migrations, defaults) {
  if (schema.source === "default" && migrations.source === "default") {
    return defaults.source;
  }
  return "scan";
}

async function promptForSelection(target, selection) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const schemaPaths = await promptPathChoice(
      rl,
      "schema path",
      selection.candidates.schemaPaths,
      selection.schemaPaths[0] ?? projectDefaults(target).schemaPath
    );
    const migrationsDir = await promptPathChoice(
      rl,
      "migrations directory",
      selection.candidates.migrationsDirs,
      selection.migrationsDir
    );
    return {
      ...selection,
      databaseUrls: projectDefaults(target).databaseUrls,
      migrationsDir,
      pathConfirmationNeeded: false,
      schemaPaths: [schemaPaths],
      source: "prompt",
    };
  } finally {
    rl.close();
  }
}

async function promptPathChoice(rl, label, candidates, fallback) {
  const choices = candidates.length > 0 ? candidates : [fallback];
  process.stdout.write(`supaschema detected ${label} candidates:\n`);
  choices.forEach((candidate, index) => {
    process.stdout.write(`  ${index + 1}. ${candidate}\n`);
  });
  const answer = await rl.question(`Choose ${label} [1-${choices.length}, default 1]: `);
  const index = Number.parseInt(answer.trim(), 10);
  return choices[Number.isInteger(index) && index >= 1 && index <= choices.length ? index - 1 : 0];
}

function canPrompt() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI);
}

function selectCandidate(candidates, fallback) {
  if (candidates.length === 0) {
    return { needsConfirmation: false, path: fallback, source: "default" };
  }
  if (candidates.length === 1) {
    return { needsConfirmation: false, path: candidates[0], source: "scan" };
  }
  if (candidates.includes(fallback)) {
    return { needsConfirmation: false, path: fallback, source: "standard" };
  }
  return { needsConfirmation: true, path: candidates[0], source: "ambiguous" };
}

function projectDefaults(projectDir) {
  const detected = detectProviderPreset(projectDir);
  const preset = detected?.preset ?? genericProviderPreset;
  return {
    adapter: preset.adapter,
    databaseUrls: discoverDatabaseUrlEnvs(projectDir),
    migrationsDir: preset.migrationsDir,
    provider: detected
      ? {
          id: preset.id,
          label: preset.label,
          markers: detected.markers,
        }
      : undefined,
    schemaPath: preset.schemaPath,
    source: detected?.preset.id ?? "default",
  };
}

function detectProviderPreset(projectDir) {
  const files = walkFiles(projectDir, 5);
  for (const preset of providerPresets) {
    const markers = [];
    for (const marker of preset.markers) {
      markers.push(...matchingProviderMarkers(projectDir, files, marker));
    }
    if (markers.length > 0) {
      return { markers, preset };
    }
  }
}

function discoverDatabaseUrlEnvs(projectDir) {
  const entries = walkFiles(projectDir, 5)
    .filter((file) => isEnvSourceFile(projectDir, file))
    .flatMap((file) => databaseUrlEnvEntries(projectDir, file));
  return {
    local: selectDatabaseUrlEnv(entries, ["local", "sample"]),
    remote: selectDatabaseUrlEnv(entries, ["remote"]),
  };
}

function isEnvSourceFile(projectDir, file) {
  const path = rel(projectDir, file);
  const name = path.split("/").at(-1) ?? "";
  if (name === ".env.enc") {
    return false;
  }
  return name === ".env" || name.startsWith(".env.") || name.endsWith(".env");
}

function databaseUrlEnvEntries(projectDir, file) {
  const content = readText(file);
  if (content === undefined) {
    return [];
  }
  const lane = databaseUrlEnvLane(projectDir, file);
  const entries = [];
  for (const line of content.split("\n")) {
    const assignment = envAssignment(line);
    if (assignment === undefined || !isDatabaseUrlEnvAssignment(assignment)) {
      continue;
    }
    entries.push({
      key: assignment.key,
      lane,
      priority: databaseUrlEnvNamePriority(assignment.key),
      valueHasUrl: isPostgresUrl(assignment.value),
    });
  }
  return entries;
}

function envAssignment(raw) {
  let line = raw.trim();
  if (line.length === 0 || line.startsWith("#")) {
    return;
  }
  if (line.startsWith("export ")) {
    line = line.slice("export ".length).trimStart();
  }
  const separator = line.indexOf("=");
  if (separator <= 0) {
    return;
  }
  const key = line.slice(0, separator).trim();
  if (!isEnvName(key)) {
    return;
  }
  return {
    key,
    value: line.slice(separator + 1).trim(),
  };
}

function isEnvName(value) {
  if (value.length === 0 || !isEnvFirstChar(value[0])) {
    return false;
  }
  for (const char of value.slice(1)) {
    if (!isEnvChar(char)) {
      return false;
    }
  }
  return true;
}

function isEnvFirstChar(char) {
  return char === "_" || isAsciiLetter(char);
}

function isEnvChar(char) {
  return char === "_" || isAsciiLetter(char) || isAsciiDigit(char);
}

function isAsciiLetter(char) {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(char) {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function isDatabaseUrlEnvAssignment(assignment) {
  const upper = assignment.key.toUpperCase();
  return (
    databaseUrlEnvPriority.includes(upper) ||
    upper.includes("DATABASE_URL") ||
    isPostgresUrl(assignment.value)
  );
}

function isPostgresUrl(value) {
  return value.startsWith("postgres://") || value.startsWith("postgresql://");
}

function databaseUrlEnvLane(projectDir, file) {
  const path = rel(projectDir, file).toLowerCase();
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  if (
    parts.includes(".github") ||
    parts.includes(".vercel") ||
    name.includes("production") ||
    name.includes("prod")
  ) {
    return "remote";
  }
  if (name.includes("example") || name.includes("sample")) {
    return "sample";
  }
  return "local";
}

function selectDatabaseUrlEnv(entries, lanes) {
  const candidates = entries.filter((entry) => lanes.includes(entry.lane));
  candidates.sort((left, right) => databaseUrlEnvRank(left) - databaseUrlEnvRank(right));
  return candidates[0]?.key;
}

function databaseUrlEnvRank(entry) {
  const laneRank = entry.lane === "local" || entry.lane === "remote" ? 0 : 100;
  const valueRank = entry.valueHasUrl ? 0 : 10;
  return laneRank + valueRank + entry.priority;
}

function databaseUrlEnvNamePriority(name) {
  const index = databaseUrlEnvPriority.indexOf(name.toUpperCase());
  return index === -1 ? databaseUrlEnvPriority.length : index;
}

function matchingProviderMarkers(projectDir, files, marker) {
  if (typeof marker.path === "string") {
    const absolute = join(projectDir, marker.path);
    if (!existsSync(absolute)) {
      return [];
    }
    if (!marker.contentTerms || fileContainsAny(absolute, marker.contentTerms)) {
      return [marker.path];
    }
    return [];
  }

  const matched = [];
  for (const file of files) {
    const name = file.split(sep).at(-1) ?? "";
    if (!marker.fileNames.some((pattern) => fileNameMatches(pattern, name))) {
      continue;
    }
    if (!marker.contentTerms || fileContainsAny(file, marker.contentTerms)) {
      matched.push(rel(projectDir, file));
    }
  }
  return matched;
}

function fileNameMatches(pattern, name) {
  if (!pattern.includes("*")) {
    return pattern === name;
  }
  const [prefix, suffix] = pattern.split("*");
  return name.startsWith(prefix) && name.endsWith(suffix);
}

function fileContainsAny(path, terms) {
  try {
    const content = readFileSync(path, "utf8");
    return terms.some((term) => content.includes(term));
  } catch {
    return false;
  }
}

function scanProject(projectDir) {
  const defaults = projectDefaults(projectDir);
  const dirs = walkDirectories(projectDir, 5);
  const schemaPreference = [
    defaults.schemaPath,
    ...providerSchemaPaths,
    genericSchemaPath,
    "schemas",
    "schema",
    "db/schemas",
    "db/schema",
  ];
  const migrationPreference = [
    defaults.migrationsDir,
    ...providerMigrationsDirs,
    genericMigrationsDir,
    "migrations",
    "db/migrations",
  ];
  const schemaCandidates = pruneNestedCandidates(
    rankCandidates(
      dirs.filter((dir) => isSchemaCandidate(projectDir, dir)).map((dir) => rel(projectDir, dir)),
      schemaPreference
    )
  );
  const migrationCandidates = pruneNestedCandidates(
    rankCandidates(
      dirs
        .filter((dir) => isMigrationsCandidate(projectDir, dir))
        .map((dir) => rel(projectDir, dir)),
      migrationPreference
    )
  );
  return {
    migrationsDirs: rankCandidates(migrationCandidates, migrationPreference),
    schemaPaths: rankCandidates(schemaCandidates, schemaPreference),
  };
}

function walkDirectories(projectDir, maxDepth) {
  const out = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || shouldSkipDir(entry.name) || entry.name.startsWith(".")) {
        continue;
      }
      const child = join(dir, entry.name);
      out.push(child);
      visit(child, depth + 1);
    }
  };
  visit(projectDir, 1);
  return out;
}

function walkFiles(projectDir, maxDepth) {
  const out = [];
  const visit = (dir, depth) => {
    if (depth > maxDepth) {
      return;
    }
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) {
          visit(join(dir, entry.name), depth + 1);
        }
        continue;
      }
      if (entry.isFile()) {
        out.push(join(dir, entry.name));
      }
    }
  };
  visit(projectDir, 1);
  return out;
}

function shouldSkipDir(name) {
  return skippedDirNames.has(name);
}

function isSchemaCandidate(projectDir, dir) {
  const name = dir.split(sep).at(-1);
  const path = rel(projectDir, dir);
  if (name === "migrations" || ignoredSqlCandidateDirNames.has(name)) {
    return false;
  }
  return (
    path === genericSchemaPath ||
    providerSchemaPaths.includes(path) ||
    name === "schemas" ||
    name === "schema" ||
    hasSqlFiles(dir)
  );
}

function isMigrationsCandidate(projectDir, dir) {
  const name = dir.split(sep).at(-1);
  const path = rel(projectDir, dir);
  return (
    path === genericMigrationsDir || providerMigrationsDirs.includes(path) || name === "migrations"
  );
}

function hasSqlFiles(dir) {
  try {
    return readdirSync(dir).some((entry) => {
      const path = join(dir, entry);
      return statSync(path).isFile() && entry.endsWith(".sql");
    });
  } catch {
    return false;
  }
}

function rankCandidates(candidates, preferredOrder) {
  const unique = Array.from(new Set(candidates)).sort(
    (left, right) => Number(left > right) - Number(left < right)
  );
  return unique.sort((left, right) => rank(left, preferredOrder) - rank(right, preferredOrder));
}

function pruneNestedCandidates(candidates) {
  const roots = [];
  for (const candidate of Array.from(new Set(candidates))) {
    if (
      !roots.some((root) => candidate.startsWith(`${root}/`) || root.startsWith(`${candidate}/`))
    ) {
      roots.push(candidate);
    }
  }
  return roots;
}

function rank(candidate, preferredOrder) {
  const index = preferredOrder.indexOf(candidate);
  return index === -1 ? preferredOrder.length + candidate.split("/").length : index;
}

function shouldWriteConfig(existingConfig, repair) {
  return !existingConfig.exists || repair;
}

function scaffoldConfig(selection, existing) {
  const config = mergeInstalledConfig(existing, {
    localDatabaseUrlEnv: selection.databaseUrls?.local,
    migrationsDir: selection.migrationsDir,
    providerId: selection.provider?.id,
    remoteDatabaseUrlEnv: selection.databaseUrls?.remote,
    schemaPaths: selection.schemaPaths,
  });
  if (selection.workflowOverrides !== undefined) {
    config.workflow = { ...config.workflow, ...selection.workflowOverrides };
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

function createConfiguredDirectories(target, selection, { dryRun = false } = {}) {
  let changed = false;
  for (const schemaPath of selection.schemaPaths) {
    const destination = join(target, schemaPath);
    changed = !existsSync(destination) || changed;
    if (!dryRun) {
      mkdirSync(destination, { recursive: true });
    }
  }
  const migrationsDestination = join(target, selection.migrationsDir);
  changed = !existsSync(migrationsDestination) || changed;
  if (!dryRun) {
    mkdirSync(migrationsDestination, { recursive: true });
  }
  return changed;
}

function writeInstallManifest(
  target,
  packageVersion,
  scan,
  selection,
  existingConfig = {},
  { dryRun = false } = {}
) {
  const manifest = {
    adapter: selection.adapter ?? "auto",
    agentInstructions: agentInstructionsForPendingInstall(selection),
    candidates: scan,
    configConfirmationNeeded: existingConfig.configConfirmationNeeded === true,
    databaseUrls: selection.databaseUrls,
    existingConfig:
      existingConfig.exists === true
        ? {
            kind: existingConfig.kind,
            path: existingConfig.path,
          }
        : undefined,
    installedAt: new Date().toISOString(),
    migrationsDir: selection.migrationsDir,
    packageVersion,
    pathConfirmationNeeded: selection.pathConfirmationNeeded,
    pendingReasons: selection.pendingReasons,
    provider: selection.provider,
    recommendedConfig: recommendedConfigForPendingInstall(selection),
    schemaPaths: selection.schemaPaths,
    source: selection.source,
  };
  const existing = readJson(join(target, manifestPath));
  if (existing && manifestSelectionUnchanged(existing, manifest)) {
    return false;
  }
  return writeProjectFile(target, manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    dryRun,
  });
}

function removeInstallManifest(target, { dryRun = false } = {}) {
  const path = join(target, manifestPath);
  if (!existsSync(path)) {
    return false;
  }
  if (dryRun) {
    return true;
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }

  const directory = dirname(path);
  try {
    if (readdirSync(directory).length === 0) {
      rmdirSync(directory);
    }
  } catch (error) {
    if (!isMissingFile(error)) {
      throw error;
    }
  }
  return true;
}

function manifestSelectionUnchanged(existing, next) {
  return (
    existing.adapter === next.adapter &&
    JSON.stringify(existing.candidates) === JSON.stringify(next.candidates) &&
    existing.configConfirmationNeeded === next.configConfirmationNeeded &&
    existing.migrationsDir === next.migrationsDir &&
    existing.packageVersion === next.packageVersion &&
    existing.pathConfirmationNeeded === next.pathConfirmationNeeded &&
    JSON.stringify(existing.agentInstructions) === JSON.stringify(next.agentInstructions) &&
    JSON.stringify(existing.pendingReasons) === JSON.stringify(next.pendingReasons) &&
    JSON.stringify(existing.recommendedConfig) === JSON.stringify(next.recommendedConfig) &&
    JSON.stringify(existing.schemaPaths) === JSON.stringify(next.schemaPaths)
  );
}

function agentInstructionsForPendingInstall(selection) {
  if (!selection.pathConfirmationNeeded) {
    return;
  }
  return {
    requiredActions: [
      "Inspect candidates.schemaPaths and candidates.migrationsDirs in this manifest.",
      "Choose the package-owned declarative schema tree and migration directory.",
      "Create or update supaschema.config.json with schemaPaths and migrationsDir.",
      "Run the local package-manager command for supaschema config validate --json.",
    ],
    summary:
      "supaschema found multiple plausible schema or migration paths and needs the owning project paths selected before migration commands run.",
  };
}

function recommendedConfigForPendingInstall(selection) {
  if (!selection.pathConfirmationNeeded) {
    return;
  }
  const schemaPath = selection.schemaPaths[0] ?? "<schema path>";
  return {
    migrationsDir: selection.migrationsDir ?? "<migrations dir>",
    schemaPaths: [schemaPath],
    sources: {
      from: "auto",
    },
  };
}

function writeProjectFile(target, relativePath, contents, { dryRun = false } = {}) {
  const destination = join(target, relativePath);
  return writeFileAtomicIfChanged(destination, contents, { dryRun });
}

function writeInstallState({ dryRun, existingConfig, packageVersion, scan, selection, targetDir }) {
  if (selection.pathConfirmationNeeded) {
    return writeInstallManifest(targetDir, packageVersion, scan, selection, existingConfig, {
      dryRun,
    });
  }
  return removeInstallManifest(targetDir, { dryRun });
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    // Optional template inputs may be absent.
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    // Optional template inputs may be absent or malformed.
  }
}

function isMissingFile(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function writeFileAtomic(destination, contents) {
  const directory = dirname(destination);
  mkdirSync(directory, { recursive: true });
  const temp = join(
    directory,
    `.supaschema-write-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`
  );
  try {
    writeFileSync(temp, contents, { flag: "wx" });
    renameSync(temp, destination);
  } catch (error) {
    removeIfPresent(temp);
    throw error;
  }
}

function writeFileAtomicIfChanged(destination, contents, { dryRun = false } = {}) {
  if (readText(destination) === contents) {
    return false;
  }
  if (!dryRun) {
    writeFileAtomic(destination, contents);
  }
  return true;
}

function removeIfPresent(filePath) {
  try {
    unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function rel(projectDir, path) {
  return relative(projectDir, path).split(sep).join("/");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
