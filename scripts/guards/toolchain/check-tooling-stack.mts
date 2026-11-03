#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import type TypeScript from "typescript";
import { parse as parseYaml } from "yaml";
import {
  parseShellCommand,
  type ShellInvocation,
  staticWordValue,
} from "../../agent-hooks/shell-command.mts";
import { arrayOf, at, type JsonRecord, recordOf, stringAt, stringsOf } from "../../lib/json.mts";
import { assert, fail, ok } from "../lib/assertions.mts";
import { exists, gitFiles, ROOT, readJson, readText } from "../lib/repository.mts";
import { forEachNode, parseScript, ts } from "../lib/typescript-ast.mts";

const exactlyPinnedTools = [
  "@astrojs/language-server",
  "@biomejs/biome",
  "@vitest/coverage-v8",
  "prettier",
  "prettier-plugin-astro",
  "ultracite",
  "vitest",
];
const aliasPins = {
  "@typescript/native": "npm:typescript@7.0.2",
};
const allowedRootDisabledBiomeRules = new Set([
  "linter.rules.performance.noAwaitInLoops",
  "linter.rules.style.useDestructuring",
  "linter.rules.suspicious.noMisplacedAssertion",
  "linter.rules.suspicious.noShadow",
  "linter.rules.suspicious.noUnnecessaryConditions",
]);
const extractedWorkflowBiomeExclusions = [
  "!.claude/skills/code-review/references/workflow-backed-code-review.js",
  "!.claude/skills/deep-research/references/workflow-backed-deep-research.js",
];
const expectedBiomeExclusions = [
  "!dist",
  "!node_modules",
  "!.venv",
  "!coverage",
  "!.tmp",
  "!**/.tmp",
  "!.wrangler",
  "!*.tgz",
  "!supaschema-config.schema.json",
  "!database.types.ts",
  "!database.zod.ts",
  "!api-docs",
  "!benchmarks/results",
  "!.gitnexus",
  "!.claude/worktrees",
  ...extractedWorkflowBiomeExclusions,
  "!agent-bundle",
  "!**/*.astro",
  "!tests/fixtures/sample-project/supabase/functions",
  "!tests/fixtures/agent-hooks/retired-sync-llm-on-claude-surface-change.mjs",
  "!.agents",
  "!.codex",
];
const ultraciteWriteCommands = new Set(["check", "fix"]);
const importExtensionMappings = [
  "linter",
  "rules",
  "correctness",
  "useImportExtensions",
  "options",
  "extensionMappings",
];

function staticModuleSpecifier(node: TypeScript.Node): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier !== undefined &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
}

function isRelativeTsModuleSpecifier(value: string | undefined): boolean {
  return typeof value === "string" && value.startsWith(".") && value.endsWith(".ts");
}

function moduleSpecifierFlags(
  file: string,
  root: string
): { generatedDist: boolean; relativeTs: boolean } {
  const source = parseScript(readText(file, root), file);
  const flags = { generatedDist: false, relativeTs: false };
  const visitSpecifier = (value: string | undefined): void => {
    if (isRelativeTsModuleSpecifier(value)) {
      flags.relativeTs = true;
    }
    if (isGeneratedDistModuleSpecifier(value)) {
      flags.generatedDist = true;
    }
  };
  forEachNode(source, (node) => {
    visitSpecifier(staticModuleSpecifier(node));
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (ts.isStringLiteral(argument)) {
        visitSpecifier(argument.text);
      }
    }
  });
  return flags;
}

function assertAgentPackageSurface(files: readonly string[]): void {
  assert(files.includes("agent-bundle"), "package.json must publish raw agent-bundle files");

  for (const file of files) {
    const isAgentSurface =
      file === "AGENTS.md" ||
      file.startsWith(".agents/") ||
      file.startsWith(".claude/") ||
      file.startsWith(".codex/");
    assert(!isAgentSurface, `package.json must not publish active agent surface ${file}`);
  }
}

function assertRuntimePackageSurface(files: readonly string[]): void {
  assert(!files.includes("bin"), "package.json must list bin helper files, not the whole bin/");
  assert(
    files.includes("bin/config-contract.mjs") && files.includes("bin/scaffold.mjs"),
    "package.json must publish only the required bin helper files"
  );

  const forbiddenPackagePrefixes = [
    "benchmarks",
    "corpus",
    "docs",
    "examples",
    "scripts",
    "services",
    "src",
    "tests",
  ];

  for (const file of files) {
    for (const prefix of forbiddenPackagePrefixes) {
      assert(
        file !== prefix && !file.startsWith(`${prefix}/`),
        `package.json must not publish ${prefix}/ through ${file}; keep it in the public repo/docs surface, not node_modules`
      );
    }
  }
}

function isJavascriptSourceFile(file: string): boolean {
  return [".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"].includes(
    path.extname(file)
  );
}

function isExactVersion(spec: string): boolean {
  const segments = spec.split(".");
  if (segments.length < 3) {
    return false;
  }
  const [major, minor] = segments;
  const [patch] = segments.slice(2).join(".").split("-");
  return [major, minor, patch].every(isNumericSegment);
}

function isNumericSegment(value: string): boolean {
  return value.length > 0 && [...value].every((char) => char >= "0" && char <= "9");
}

function isGeneratedDistModuleSpecifier(value: string | undefined): boolean {
  return (
    typeof value === "string" &&
    value.startsWith(".") &&
    value.split("/").some((segment) => segment === "dist")
  );
}

function unwrappedPackageRunnerWords(invocation: ShellInvocation): string[] {
  const words = [
    invocation.executable ?? "",
    ...invocation.arguments.map((word) => staticWordValue(word) ?? ""),
  ];
  if (words[0] === "npx") {
    return words[1] === "--no-install" ? words.slice(2) : words.slice(1);
  }
  if (words[0] === "npm" && words[1] === "exec") {
    return words[2] === "--" ? words.slice(3) : words.slice(2);
  }
  return words;
}

function invokesDirectBiomeOrUltracite(command: string): boolean {
  return parseShellCommand(command).invocations.some((invocation) => {
    const words = unwrappedPackageRunnerWords(invocation);
    return (
      words[0] === "biome" || (words[0] === "ultracite" && ultraciteWriteCommands.has(words[1]))
    );
  });
}

function assertUltraciteEntryPoints(scripts: JsonRecord, lefthook: unknown, root: string): void {
  assert(exists("scripts/lint.mts", root), "npm-owned Ultracite lint wrapper must exist");
  assert(exists("scripts/format.mts", root), "npm-owned Ultracite format wrapper must exist");
  assert(
    scripts.format === "node scripts/format.mts",
    "format must route every writer through the npm-owned format wrapper"
  );
  assert(
    scripts.lint === "node scripts/lint.mts",
    "lint must route Ultracite through the npm-owned lint wrapper"
  );
  assert(
    scripts["lint:ci"] === "node scripts/lint.mts --ci",
    "lint:ci must route the CI reporter through the npm-owned lint wrapper"
  );
  for (const [name, command] of Object.entries(scripts)) {
    assert(
      !invokesDirectBiomeOrUltracite(String(command)),
      `package script ${name} must route Biome and Ultracite check/fix through the npm-owned lint/format wrappers`
    );
  }
  assert(scripts["lint:doctor"] === "ultracite doctor", "lint:doctor must run Ultracite doctor");
  assert(
    stringAt(scripts, "bench:plot:headtohead")?.endsWith(
      " && npm run format -- docs/public/images/benchmarks"
    ),
    "bench:plot:headtohead must format generated benchmark SVGs through the scoped npm wrapper"
  );
  assert(
    stringAt(scripts, "diagrams")?.endsWith(" && npm run format -- docs/public/images/concepts"),
    "diagrams must format generated concept SVGs through the scoped npm wrapper"
  );

  const preCommitJobs = arrayOf(at(lefthook, "pre-commit", "jobs"));
  const ultraciteHook = preCommitJobs.find((job) => at(job, "name") === "Ultracite");
  assert(
    at(ultraciteHook, "run") === "npm run format -- --staged" &&
      at(ultraciteHook, "stage_fixed") === true,
    "lefthook Ultracite pre-commit job must run npm run format -- --staged with stage_fixed: true"
  );
  const prettierHook = preCommitJobs.find((job) => at(job, "name") === "prettier");
  assert(
    at(prettierHook, "run") === "npx --no-install prettier --write {staged_files}" &&
      at(prettierHook, "stage_fixed") === true,
    "lefthook Prettier job must use the pinned local binary with --no-install and stage_fixed: true"
  );
  for (const job of preCommitJobs) {
    assert(
      !invokesDirectBiomeOrUltracite(stringAt(job, "run") ?? ""),
      `lefthook pre-commit job ${jobName(job)} must route Biome and Ultracite through npm scripts`
    );
  }
  assertNoSurfaceSyncJob(lefthook, preCommitJobs);
}

function jobName(job: unknown): string {
  return stringAt(job, "name") ?? "(unnamed)";
}

function assertNoSurfaceSyncJob(lefthook: unknown, preCommitJobs: readonly unknown[]): void {
  assert(
    at(lefthook, "pre-commit", "piped") === true,
    "lefthook pre-commit must run piped so a failing formatter skips the remaining jobs"
  );
  for (const job of preCommitJobs) {
    assert(
      at(job, "stage_fixed") === true,
      `lefthook pre-commit job ${jobName(job)} must use stage_fixed so formatter output reaches the commit`
    );
    assert(
      !(stringAt(job, "run") ?? "").includes("sync:llm"),
      `lefthook pre-commit job ${jobName(job)} must not run sync:llm; npm run sync:llm is an explicit command owned by guard:agent`
    );
  }
}

function assertBiomeLanguageSurface(biome: unknown): void {
  const includes = stringsOf(at(biome, "files", "includes"));
  assert(
    includes.includes("!.claude/worktrees"),
    "biome.jsonc must exclude .claude/worktrees so the host lint lane does not traverse nested checkout configs"
  );
  const claudeSkillExclusions = includes
    .filter((include) => include.startsWith("!.claude/skills"))
    .sort((left, right) => Number(left > right) - Number(left < right));
  assert(
    JSON.stringify(claudeSkillExclusions) === JSON.stringify(extractedWorkflowBiomeExclusions),
    "biome.jsonc may exclude only the two exact binary-extracted workflow JavaScript files under .claude/skills"
  );
  const exclusions = includes.filter((include) => include.startsWith("!"));
  assert(
    JSON.stringify(
      [...exclusions].sort((left, right) => Number(left > right) - Number(left < right))
    ) ===
      JSON.stringify(
        [...expectedBiomeExclusions].sort(
          (left, right) => Number(left > right) - Number(left < right)
        )
      ),
    "biome.jsonc exclusions must match the exact reviewed generated, state, nested-worktree, and extracted-workflow boundary"
  );
  assert(
    at(biome, "vcs", "useIgnoreFile") === true,
    "biome.jsonc must keep VCS ignore handling enabled for the Git-visible lint lane"
  );
  assert(
    at(biome, "html", "experimentalFullSupportEnabled") === true,
    "biome.jsonc must enable full HTML formatting and lint support"
  );
  assert(
    at(biome, "javascript", "experimentalEmbeddedSnippetsEnabled") === true,
    "biome.jsonc must enable embedded CSS and GraphQL snippet support"
  );
}

function assertNoDisabledBiomeRules(
  value: unknown,
  rulePath = "linter.rules",
  allowedDisabled: ReadonlySet<string> = new Set()
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    const nextPath = `${rulePath}.${key}`;
    if (child === "off") {
      if (allowedDisabled.has(nextPath)) {
        continue;
      }
      fail(`biome.jsonc must not disable ${nextPath}`);
    }
    if (child && typeof child === "object") {
      assertNoDisabledBiomeRules(child, nextPath, allowedDisabled);
    }
  }
}

function assertBiomeOverrides(overrides: readonly unknown[]): void {
  const allowedDisabled = new Map([
    [
      "services/license-worker/src/cloudflare-workers.d.ts",
      new Set(["linter.rules.correctness.noUnresolvedImports"]),
    ],
    [
      "services/license-worker/src/worker.ts",
      new Set(["linter.rules.correctness.noUnresolvedImports"]),
    ],
    ["src/index.ts", new Set(["linter.rules.performance.noBarrelFile"])],
    ["docs/blume.config.ts", new Set(["linter.rules.correctness.noUnresolvedImports"])],
  ]);
  const allowedScopes = new Set([
    JSON.stringify([
      "services/license-worker/src/cloudflare-workers.d.ts",
      "services/license-worker/src/worker.ts",
    ]),
    JSON.stringify(["src/index.ts"]),
    JSON.stringify(["docs/blume.config.ts"]),
  ]);
  for (const override of overrides) {
    const includes = stringsOf(at(override, "includes"));
    const disabledPaths = disabledBiomeRulePaths(at(override, "linter", "rules") ?? {});
    for (const disabledPath of disabledPaths) {
      for (const include of includes) {
        if (allowedDisabled.get(include)?.has(disabledPath)) {
          continue;
        }
        assert(false, `biome.jsonc override for ${include} must not disable ${disabledPath}`);
      }
    }

    const complexityRule = at(
      override,
      "linter",
      "rules",
      "complexity",
      "noExcessiveCognitiveComplexity"
    );
    assert(
      complexityRule === undefined,
      "biome.jsonc must inherit Ultracite noExcessiveCognitiveComplexity without a migration cap"
    );

    assert(
      allowedScopes.has(JSON.stringify(includes)),
      `biome.jsonc override is not allowed for ${includes.join(", ") || "(none)"}`
    );
  }
}

function serverForExtension(servers: readonly unknown[], extension: string): unknown {
  return servers.find((server) => stringsOf(at(server, "extensions")).includes(extension));
}

function assertLspSoleauxWiring(config: unknown): void {
  const servers = arrayOf(at(config, "servers"));
  const pythonServer = serverForExtension(servers, "py");
  assert(pythonServer, "lsp-soleaux.json must map .py files");
  assert(
    JSON.stringify(at(pythonServer, "command")) === JSON.stringify(["uv", "run", "pylsp"]),
    "lsp-soleaux.json must run pylsp from the locked uv workspace"
  );
  assert(
    at(pythonServer, "restartInterval") === 5,
    "lsp-soleaux.json must auto-restart pylsp every 5 minutes"
  );
  const pylspInitializationOptions = at(pythonServer, "initializationOptions", "pylsp");
  assert(
    typeof pylspInitializationOptions === "object" &&
      pylspInitializationOptions !== null &&
      !Array.isArray(pylspInitializationOptions) &&
      at(pythonServer, "initializationOptions", "settings") === undefined,
    "lsp-soleaux.json must pass pylsp settings as an object directly through initializationOptions.pylsp"
  );

  const javascriptServer = serverForExtension(servers, "mjs");
  assert(javascriptServer, "lsp-soleaux.json must map .mjs files");
  assert(
    JSON.stringify(at(javascriptServer, "command")) ===
      JSON.stringify([
        "node",
        "scripts/cclsp-language-id-proxy.mts",
        "--",
        "npx",
        "--no-install",
        "typescript-language-server",
        "--stdio",
      ]),
    "lsp-soleaux.json must route JS-family LSP through the local TypeScript proxy and server"
  );
  assert(
    at(javascriptServer, "initializationOptions", "tsserver", "path") === undefined,
    "lsp-soleaux.json must let the TypeScript proxy inject the tsserver path"
  );
  const astroServer = serverForExtension(servers, "astro");
  assert(astroServer, "lsp-soleaux.json must map .astro files");
  assert(
    JSON.stringify(at(astroServer, "command")) ===
      JSON.stringify(["npx", "--no-install", "astro-ls", "--stdio"]),
    "lsp-soleaux.json must run the repository-installed Astro language server"
  );
  assert(
    at(astroServer, "initializationOptions", "typescript", "tsdk") ===
      "node_modules/typescript/lib",
    "lsp-soleaux.json must give astro-ls the repository TypeScript SDK"
  );
  for (const server of servers) {
    assert(
      !stringsOf(at(server, "extensions")).some(
        (extension) => extension === "ql" || extension === "qll"
      ),
      "lsp-soleaux.json must not expose an unowned CodeQL language server"
    );
    const command = stringsOf(at(server, "command"));
    if (command[0] === "uv" || command.includes("scripts/cclsp-language-id-proxy.mts")) {
      continue;
    }
    assert(
      command[0] === "npx" && command[1] === "--no-install",
      "lsp-soleaux.json Node language servers must use repository-installed npx --no-install binaries"
    );
    assert(
      !(command.includes("--package") || command.includes("--yes") || command.includes("-y")) &&
        command.slice(2).every((part) => !part.includes("@")),
      "lsp-soleaux.json must not duplicate package versions or request runtime installation"
    );
  }
}

function disabledBiomeRulePaths(value: unknown, rulePath = "linter.rules"): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const out: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const nextPath = `${rulePath}.${key}`;
    if (child === "off") {
      out.push(nextPath);
      continue;
    }
    if (child && typeof child === "object") {
      out.push(...disabledBiomeRulePaths(child, nextPath));
    }
  }
  return out;
}

export function check(root = ROOT): void {
  const packageJson = readJson("package.json", root);
  const scripts = recordOf(at(packageJson, "scripts"));
  const dependencies = recordOf(at(packageJson, "dependencies"));
  const devDependencies = recordOf(at(packageJson, "devDependencies"));
  const biome = readJson("biome.jsonc", root);
  const gitignore = readText(".gitignore", root);
  const lefthook: unknown = parseYaml(readText("lefthook.yml", root));
  const vitestConfig = readText("vitest.config.ts", root);

  assert(exists("package-lock.json", root), "npm package-lock.json must exist");
  assert(!exists("pnpm-lock.yaml", root), "pnpm lockfile must not be introduced");
  assert(!exists("yarn.lock", root), "Yarn lockfile must not be introduced");
  assert(!exists("bun.lockb", root), "Bun lockfile must not be introduced");
  assert(
    !exists(".npmignore", root),
    "package boundary must use package.json files allowlist, not root .npmignore"
  );
  assert(!exists("biome.json", root), "Biome config must be biome.jsonc");
  assert(exists("biome.jsonc", root), "missing biome.jsonc");
  assert(exists("prettier.config.mjs", root), "missing prettier.config.mjs");
  assert(exists("lsp-soleaux.json", root), "tracked source-repository lsp-soleaux.json must exist");
  assert(
    !gitignore.split("\n").some((line) => line.trim() === "lsp-soleaux.json"),
    "tracked source-repository lsp-soleaux.json must not be ignored"
  );
  const prettierConfig = readText("prettier.config.mjs", root);
  assert(Array.isArray(at(packageJson, "files")), "package.json must define a files allowlist");
  assert(
    exists("scripts/cclsp-language-id-proxy.mts", root),
    "TypeScript language-id proxy must exist for .mjs/.cjs LSP support"
  );
  for (const name of exactlyPinnedTools) {
    const spec = devDependencies[name];
    assert(
      typeof spec === "string" && isExactVersion(spec),
      `package.json must pin ${name} to an exact version, found ${spec ?? "no entry"}`
    );
  }
  for (const [name, spec] of Object.entries(aliasPins)) {
    assert(devDependencies[name] === spec, `package.json must pin ${name}@${spec}`);
  }
  assert(
    devDependencies.vitest === devDependencies["@vitest/coverage-v8"],
    "package.json must keep vitest and @vitest/coverage-v8 on the same version"
  );
  assert(
    dependencies.typescript === "npm:@typescript/typescript6@6.0.2",
    "package.json must keep the TypeScript 6 compatibility package under the runtime typescript identity"
  );
  assert(
    !("typescript-compiler-api" in dependencies || "typescript-compiler-api" in devDependencies),
    "package.json must not expose the retired typescript-compiler-api alias"
  );
  assert(
    !("typescript" in devDependencies),
    "package.json must keep TypeScript 7 under the @typescript/native development identity"
  );
  assert(
    at(packageJson, "overrides", "@typescript/old") === "npm:typescript@6.0.2",
    "package.json must pin the compatibility package's nested TypeScript compiler to 6.0.2"
  );
  assert(
    !("pg-formatter" in devDependencies),
    "pg-formatter must not be reintroduced; SQL is governed by supaschema parser/deparser semantics"
  );

  assertUltraciteEntryPoints(scripts, lefthook, root);
  assert(scripts.test === "vitest run", "test must run the full Vitest suite");
  assert(
    scripts["test:coverage"] === "vitest run --coverage",
    "test:coverage must run the full Vitest suite with coverage"
  );
  assert(
    scripts["test:examples"] === "vitest run tests/examples/project.test.ts --maxWorkers=1",
    "test:examples must own the examples regression lane"
  );
  assert(
    scripts["test:matrix"] === "vitest run --exclude tests/examples/project.test.ts",
    "test:matrix must exclude the examples lane from DB and OS matrices"
  );
  assert(
    scripts["test:matrix:coverage"] ===
      "vitest run --coverage --exclude tests/examples/project.test.ts",
    "test:matrix:coverage must be the coverage equivalent of test:matrix"
  );
  assert(
    scripts["format:md"] === 'prettier --write "**/*.{astro,md,mdx,yml,yaml}"',
    "format:md must run Prettier write over Astro/MDX/Markdown/YAML"
  );
  assert(
    scripts["format:md:check"] === 'prettier --check "**/*.{astro,md,mdx,yml,yaml}"',
    "format:md:check must run the read-only Prettier check over the format:md glob"
  );
  assert(!("format:sql" in scripts), "SQL formatter lane must not be reintroduced");
  assert(
    scripts["format:toml"] === "node scripts/format-toml.mts",
    "format:toml must run the taplo TOML lane"
  );
  assert(
    scripts["format:sh"] === "node scripts/format-sh.mts",
    "format:sh must run the shfmt (sh-syntax) shell lane"
  );
  assert(
    scripts["format:json"] === "sort-package-json",
    "format:json must run sort-package-json for canonical package.json key order"
  );
  assert(
    scripts["py:fix"] ===
      "uv run --package supaschema-agent-mcp ruff check --fix services/agent-mcp && uv run --package supaschema-agent-mcp ruff format services/agent-mcp",
    "py:fix must run ruff --fix then ruff format"
  );
  assert(!("lint:fix" in scripts), "format must be the only repo-wide write/fix script");
  assert(!("fix" in scripts), "package.json must not expose a second fix writer");
  assert(
    !("prepare" in scripts),
    "package.json must not install maintainer hooks through a lifecycle script"
  );
  const biomeSchemaVersion = stringAt(devDependencies, "@biomejs/biome");
  assert(
    at(biome, "$schema") === `https://biomejs.dev/schemas/${biomeSchemaVersion}/schema.json`,
    `biome.jsonc must use the Biome ${biomeSchemaVersion} schema`
  );
  const expectedBiomePresets = [
    "ultracite/biome/core",
    "ultracite/biome/type-aware",
    "ultracite/biome/vitest",
  ];
  assert(
    JSON.stringify(at(biome, "extends")) === JSON.stringify(expectedBiomePresets),
    `biome.jsonc must extend exactly ${expectedBiomePresets.join(", ")}`
  );
  for (const token of [
    'embeddedLanguageFormatting: "auto"',
    'endOfLine: "lf"',
    'plugins: ["prettier-plugin-astro"]',
    "printWidth: 80",
    'proseWrap: "never"',
    "tabWidth: 2",
    'trailingComma: "es5"',
    "useTabs: false",
  ]) {
    assert(prettierConfig.includes(token), `prettier.config.mjs missing ${token}`);
  }
  assert(
    at(biome, "formatter", "lineWidth") === 100,
    "biome.jsonc must preserve the 100-column formatter line width"
  );
  assertBiomeLanguageSurface(biome);
  const biomeIncludes = stringsOf(at(biome, "files", "includes"));
  assert(
    !biomeIncludes.includes("**"),
    'biome.jsonc must not duplicate Ultracite core\'s "**" include'
  );
  assert(
    biomeIncludes.includes("!agent-bundle"),
    "biome.jsonc must exclude generated agent-bundle files; npm run sync:llm owns that mirror"
  );
  assert(
    at(biome, "linter", "rules", "correctness", "useImportExtensions", "level") === "error",
    "Biome must enforce runtime import extensions"
  );
  assert(
    at(biome, ...importExtensionMappings, "ts") === "js" &&
      at(biome, ...importExtensionMappings, "tsx") === "js",
    "Biome must preserve emitted .js specifiers for NodeNext TypeScript"
  );
  assertNoDisabledBiomeRules(
    at(biome, "linter", "rules") ?? {},
    "linter.rules",
    allowedRootDisabledBiomeRules
  );
  assertBiomeOverrides(arrayOf(at(biome, "overrides")));
  const packageFiles = stringsOf(at(packageJson, "files"));
  assertAgentPackageSurface(packageFiles);
  assertRuntimePackageSurface(packageFiles);
  assertLspSoleauxWiring(readJson("lsp-soleaux.json", root));

  for (const file of gitFiles(root).filter(
    (candidate) => isJavascriptSourceFile(candidate) && exists(candidate, root)
  )) {
    const flags = moduleSpecifierFlags(file, root);
    assert(
      !(file.endsWith(".ts") && flags.relativeTs),
      `${file} must use emitted-runtime .js specifiers for relative imports`
    );
    assert(
      !flags.generatedDist,
      `${file} must not import generated dist output from active source`
    );
  }

  for (const token of [
    'environment: "node"',
    'pool: "forks"',
    "maxWorkers: 4",
    "minWorkers: 1",
    'provider: "v8"',
    'reporter: ["text", "lcov"]',
  ]) {
    assert(vitestConfig.includes(token), `vitest.config.ts missing ${token}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  check();
  ok("TOOLING_STACK_OK");
}
