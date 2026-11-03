import { describe, expect, it } from "vitest";
import { z } from "zod";
import { check } from "../../../scripts/guards/toolchain/check-tooling-stack.mts";
import { tempGuardRepo } from "../fixture.js";

const biomePresets = [
  "ultracite/biome/core",
  "ultracite/biome/type-aware",
  "ultracite/biome/vitest",
];
const biomeConfigSchema = z
  .object({
    extends: z.array(z.string()),
    files: z.object({ includes: z.array(z.string()) }).optional(),
    html: z.object({ experimentalFullSupportEnabled: z.boolean() }).optional(),
    javascript: z.object({ experimentalEmbeddedSnippetsEnabled: z.boolean() }).optional(),
    vcs: z.object({ useIgnoreFile: z.boolean() }).optional(),
  })
  .passthrough();
const packageConfigSchema = z
  .object({
    dependencies: z.record(z.string(), z.string()),
    devDependencies: z.record(z.string(), z.string()),
    overrides: z
      .object({
        "@typescript/old": z.string(),
      })
      .passthrough(),
    scripts: z.record(z.string(), z.string()),
  })
  .passthrough();
const lspSoleauxConfigSchema = z.object({
  servers: z.array(
    z
      .object({
        command: z.array(z.string()),
        extensions: z.array(z.string()).optional(),
        initializationOptions: z
          .object({
            pylsp: z.unknown().optional(),
            settings: z.unknown().optional(),
            tsserver: z.object({ path: z.string() }).optional(),
          })
          .passthrough()
          .optional(),
        restartInterval: z.number().optional(),
      })
      .passthrough()
  ),
});

function validPackage() {
  return {
    dependencies: {
      typescript: "npm:@typescript/typescript6@6.0.2",
    },
    devDependencies: {
      "@astrojs/language-server": "2.16.13",
      "@biomejs/biome": "2.5.5",
      "@typescript/native": "npm:typescript@7.0.2",
      "@vitest/coverage-v8": "4.1.10",
      prettier: "3.9.6",
      "prettier-plugin-astro": "0.14.1",
      ultracite: "7.9.4",
      vitest: "4.1.10",
    },
    files: ["agent-bundle", "bin/config-contract.mjs", "bin/scaffold.mjs"],
    overrides: {
      "@typescript/old": "npm:typescript@6.0.2",
    },
    scripts: {
      "bench:plot:headtohead":
        "node benchmarks/plot-head-to-head.js && npm run format -- docs/images/benchmarks",
      diagrams: "node benchmarks/plot-concepts.js && npm run format -- docs/images/concepts",
      format: "node scripts/format.mts",
      "format:json": "sort-package-json",
      "format:md": 'prettier --write "**/*.{astro,md,mdx,yml,yaml}"',
      "format:md:check": 'prettier --check "**/*.{astro,md,mdx,yml,yaml}"',
      "format:sh": "node scripts/format-sh.mts",
      "format:toml": "node scripts/format-toml.mts",
      lint: "node scripts/lint.mts",
      "lint:ci": "node scripts/lint.mts --ci",
      "lint:doctor": "ultracite doctor",
      "py:fix":
        "uv run --package supaschema-agent-mcp ruff check --fix services/agent-mcp && uv run --package supaschema-agent-mcp ruff format services/agent-mcp",
      test: "vitest run",
      "test:coverage": "vitest run --coverage",
      "test:examples": "vitest run tests/examples/project.test.ts --maxWorkers=1",
      "test:matrix": "vitest run --exclude tests/examples/project.test.ts",
      "test:matrix:coverage": "vitest run --coverage --exclude tests/examples/project.test.ts",
    },
    type: "module",
  };
}

function validFiles() {
  return {
    "biome.jsonc": JSON.stringify({
      $schema: "https://biomejs.dev/schemas/2.5.5/schema.json",
      extends: biomePresets,
      files: {
        includes: [
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
          "!agent-bundle",
          "!**/*.astro",
          "!.claude/worktrees",
          "!.claude/skills/code-review/references/workflow-backed-code-review.js",
          "!.claude/skills/deep-research/references/workflow-backed-deep-research.js",
          "!tests/fixtures/sample-project/supabase/functions",
          "!.agents",
          "!.codex",
        ],
      },
      formatter: { lineWidth: 100 },
      html: { experimentalFullSupportEnabled: true },
      javascript: { experimentalEmbeddedSnippetsEnabled: true },
      linter: {
        rules: {
          correctness: {
            useImportExtensions: {
              level: "error",
              options: { extensionMappings: { ts: "js", tsx: "js" } },
            },
          },
        },
      },
      overrides: [],
      vcs: { useIgnoreFile: true },
    }),
    "lsp-soleaux.json": JSON.stringify({
      servers: [
        {
          command: ["uv", "run", "pylsp"],
          extensions: ["py", "pyi"],
          initializationOptions: {
            pylsp: { plugins: { ruff: { enabled: true } } },
          },
          restartInterval: 5,
        },
        {
          command: [
            "node",
            "scripts/cclsp-language-id-proxy.mts",
            "--",
            "npx",
            "--no-install",
            "typescript-language-server",
            "--stdio",
          ],
          extensions: ["mjs", "cjs"],
        },
        {
          command: ["npx", "--no-install", "astro-ls", "--stdio"],
          extensions: ["astro"],
          initializationOptions: {
            typescript: { tsdk: "node_modules/typescript/lib" },
          },
        },
      ],
    }),
    ".claude/skills/supaschema/SKILL.md": `---
name: supaschema
description: Consumer skill published to the public skills tree.
metadata:
  public: true
---
`,
    ".gitignore": "",
    "package-lock.json": "{}\n",
    "package.json": `${JSON.stringify(validPackage())}\n`,
    "prettier.config.mjs": `export default {
  embeddedLanguageFormatting: "auto",
  endOfLine: "lf",
  plugins: ["prettier-plugin-astro"],
  printWidth: 80,
  proseWrap: "never",
  tabWidth: 2,
  trailingComma: "es5",
  useTabs: false,
};
`,
    "scripts/cclsp-language-id-proxy.mts": "export {};\n",
    "scripts/format.mts": "export {};\n",
    "scripts/lint.mts": "export {};\n",
    "lefthook.yml": `pre-commit:
  piped: true
  jobs:
    - name: Ultracite
      run: npm run format -- --staged
      stage_fixed: true
    - name: prettier
      run: npx --no-install prettier --write {staged_files}
      stage_fixed: true
`,
    "vitest.config.ts": `
environment: "node"
pool: "forks"
maxWorkers: 4
minWorkers: 1
provider: "v8"
reporter: ["text", "lcov"]
`,
  };
}

function fixture(mutator?: (files: Record<string, string>) => void): string {
  const files = validFiles();
  mutator?.(files);
  return tempGuardRepo(files);
}

describe("tooling stack guard", () => {
  it("accepts the canonical toolchain", () => {
    expect(() => check(fixture())).not.toThrow();
  });

  it("rejects additional framework presets", () => {
    const root = fixture((files) => {
      const biome = biomeConfigSchema.parse(JSON.parse(files["biome.jsonc"] ?? "{}"));
      biome.extends.push("ultracite/biome/react");
      files["biome.jsonc"] = JSON.stringify(biome);
    });
    expect(() => check(root)).toThrow("biome.jsonc must extend exactly");
  });

  it("rejects transitive-only Prettier", () => {
    const root = fixture((files) => {
      const packageJson = packageConfigSchema.parse(JSON.parse(files["package.json"] ?? "{}"));
      Reflect.deleteProperty(packageJson.devDependencies, "prettier");
      files["package.json"] = JSON.stringify(packageJson);
    });
    expect(() => check(root)).toThrow("package.json must pin prettier to an exact version");
  });

  it("rejects a ranged tool spec where an exact pin is required", () => {
    const root = fixture((files) => {
      const packageJson = packageConfigSchema.parse(JSON.parse(files["package.json"] ?? "{}"));
      packageJson.devDependencies.prettier = "^3.9.6";
      files["package.json"] = JSON.stringify(packageJson);
    });
    expect(() => check(root)).toThrow("package.json must pin prettier to an exact version");
  });

  it("rejects vitest and its coverage provider drifting apart", () => {
    const root = fixture((files) => {
      const packageJson = packageConfigSchema.parse(JSON.parse(files["package.json"] ?? "{}"));
      packageJson.devDependencies["@vitest/coverage-v8"] = "4.1.9";
      files["package.json"] = JSON.stringify(packageJson);
    });
    expect(() => check(root)).toThrow(
      "package.json must keep vitest and @vitest/coverage-v8 on the same version"
    );
  });

  it.each([
    ["Biome", "biome ci ."],
    ["Biome through npx", "npx --no-install biome ci ."],
    ["Ultracite check", "ultracite check ."],
    ["Ultracite fix", "ultracite fix ."],
    ["Ultracite through npm exec", "npm exec -- ultracite fix ."],
  ])("rejects direct %s package entrypoints", (_label, command) => {
    const root = fixture((files) => {
      const packageJson = packageConfigSchema.parse(JSON.parse(files["package.json"] ?? "{}"));
      packageJson.scripts.repair = command;
      files["package.json"] = JSON.stringify(packageJson);
    });
    expect(() => check(root)).toThrow(
      "package script repair must route Biome and Ultracite check/fix through the npm-owned lint/format wrappers"
    );
  });

  it("requires the exact CI lint wrapper entrypoint", () => {
    const root = fixture((files) => {
      const packageJson = packageConfigSchema.parse(JSON.parse(files["package.json"] ?? "{}"));
      packageJson.scripts["lint:ci"] = "biome ci .";
      files["package.json"] = JSON.stringify(packageJson);
    });
    expect(() => check(root)).toThrow(
      "lint:ci must route the CI reporter through the npm-owned lint wrapper"
    );
  });

  it("requires both npm-owned Ultracite wrappers", () => {
    const root = fixture((files) => {
      Reflect.deleteProperty(files, "scripts/lint.mts");
    });
    expect(() => check(root)).toThrow("npm-owned Ultracite lint wrapper must exist");
  });

  it.each([
    ["direct engine route", "biome check --staged", true],
    ["disabled re-staging", "npm run format -- --staged", false],
  ])("rejects Lefthook %s", (_label, run, stageFixed) => {
    const root = fixture((files) => {
      files["lefthook.yml"] = `pre-commit:
  jobs:
    - name: Ultracite
      run: ${run}
      stage_fixed: ${String(stageFixed)}
`;
    });
    expect(() => check(root)).toThrow(
      "lefthook Ultracite pre-commit job must run npm run format -- --staged with stage_fixed: true"
    );
  });

  it.each([
    ["VCS ignore handling", "vcs"],
    ["full HTML support", "html"],
    ["embedded snippet support", "javascript"],
  ])("requires Biome %s", (_label, field) => {
    const root = fixture((files) => {
      const biome = biomeConfigSchema.parse(JSON.parse(files["biome.jsonc"] ?? "{}"));
      Reflect.deleteProperty(biome, field);
      files["biome.jsonc"] = JSON.stringify(biome);
    });
    expect(() => check(root)).toThrow("biome.jsonc must");
  });

  it("rejects a lefthook pre-commit job that runs the agent-surface sync", () => {
    const root = fixture((files) => {
      files["lefthook.yml"] = `${files["lefthook.yml"]}    - name: sync-agent-surfaces
      run: npm run sync:llm
      stage_fixed: true
`;
    });
    expect(() => check(root)).toThrow("must not run sync:llm");
  });

  it("rejects a broad .claude/skills Biome exclusion", () => {
    const root = fixture((files) => {
      const biome = biomeConfigSchema.parse(JSON.parse(files["biome.jsonc"] ?? "{}"));
      if (biome.files) {
        biome.files.includes = ["!agent-bundle", "!.claude/worktrees", "!.claude/skills"];
      }
      files["biome.jsonc"] = JSON.stringify(biome);
    });
    expect(() => check(root)).toThrow(
      "biome.jsonc may exclude only the two exact binary-extracted workflow JavaScript files under .claude/skills"
    );
  });

  it("requires the exact .claude/worktrees Biome exclusion", () => {
    const root = fixture((files) => {
      const biome = biomeConfigSchema.parse(JSON.parse(files["biome.jsonc"] ?? "{}"));
      if (biome.files) {
        biome.files.includes = biome.files.includes.filter(
          (include) => include !== "!.claude/worktrees"
        );
      }
      files["biome.jsonc"] = JSON.stringify(biome);
    });
    expect(() => check(root)).toThrow(
      "biome.jsonc must exclude .claude/worktrees so the host lint lane does not traverse nested checkout configs"
    );
  });

  it("requires every reviewed generated and state exclusion", () => {
    const root = fixture((files) => {
      const biome = biomeConfigSchema.parse(JSON.parse(files["biome.jsonc"] ?? "{}"));
      if (biome.files) {
        biome.files.includes = biome.files.includes.filter((include) => include !== "!**/.tmp");
      }
      files["biome.jsonc"] = JSON.stringify(biome);
    });
    expect(() => check(root)).toThrow("biome.jsonc exclusions must match the exact reviewed");
  });

  it("requires fail-closed staged Prettier resolution", () => {
    const root = fixture((files) => {
      files["lefthook.yml"] = `pre-commit:
  jobs:
    - name: Ultracite
      run: npm run format -- --staged
      stage_fixed: true
    - name: prettier
      run: npx prettier --write {staged_files}
      stage_fixed: true
`;
    });
    expect(() => check(root)).toThrow("lefthook Prettier job must use the pinned local binary");
  });

  it.each([
    ["benchmark", "bench:plot:headtohead"],
    ["concept", "diagrams"],
  ])("requires scoped formatting for generated %s SVGs", (_label, scriptName) => {
    const root = fixture((files) => {
      const packageJson = packageConfigSchema.parse(JSON.parse(files["package.json"] ?? "{}"));
      packageJson.scripts[scriptName] = "node benchmarks/generate.js";
      files["package.json"] = JSON.stringify(packageJson);
    });
    expect(() => check(root)).toThrow("must format generated");
  });

  it("rejects the legacy TypeScript package layout", () => {
    const root = fixture((files) => {
      const packageJson = packageConfigSchema.parse(JSON.parse(files["package.json"] ?? "{}"));
      Reflect.deleteProperty(packageJson.dependencies, "typescript");
      packageJson.dependencies["typescript-compiler-api"] = "npm:typescript@6.0.3";
      files["package.json"] = JSON.stringify(packageJson);
    });
    expect(() => check(root)).toThrow("TypeScript 6 compatibility package");
  });

  it("pins the compatibility compiler implementation", () => {
    const root = fixture((files) => {
      const packageJson = packageConfigSchema.parse(JSON.parse(files["package.json"] ?? "{}"));
      packageJson.overrides["@typescript/old"] = "npm:typescript@^6";
      files["package.json"] = JSON.stringify(packageJson);
    });
    expect(() => check(root)).toThrow("nested TypeScript compiler to 6.0.2");
  });

  it("runs pylsp from the locked uv workspace", () => {
    const root = fixture((files) => {
      const config = lspSoleauxConfigSchema.parse(JSON.parse(files["lsp-soleaux.json"] ?? "{}"));
      const pythonServer = config.servers.find((server) => server.extensions?.includes("py"));
      if (pythonServer) {
        pythonServer.command = ["pylsp"];
      }
      files["lsp-soleaux.json"] = JSON.stringify(config);
    });
    expect(() => check(root)).toThrow("run pylsp from the locked uv workspace");
  });

  it("requires the upstream pylsp restart interval", () => {
    const root = fixture((files) => {
      const config = lspSoleauxConfigSchema.parse(JSON.parse(files["lsp-soleaux.json"] ?? "{}"));
      const pythonServer = config.servers.find((server) => server.extensions?.includes("py"));
      if (pythonServer) {
        pythonServer.restartInterval = 0;
      }
      files["lsp-soleaux.json"] = JSON.stringify(config);
    });
    expect(() => check(root)).toThrow("auto-restart pylsp every 5 minutes");
  });

  it("rejects incompatible pylsp settings wrapper", () => {
    const root = fixture((files) => {
      const config = lspSoleauxConfigSchema.parse(JSON.parse(files["lsp-soleaux.json"] ?? "{}"));
      const pythonServer = config.servers.find((server) => server.extensions?.includes("py"));
      if (pythonServer) {
        pythonServer.initializationOptions = { settings: { pylsp: {} } };
      }
      files["lsp-soleaux.json"] = JSON.stringify(config);
    });
    expect(() => check(root)).toThrow("directly through initializationOptions.pylsp");
  });

  it.each([
    ["boolean", true],
    ["array", []],
    ["string", "enabled"],
  ])("rejects %s direct pylsp options", (_kind, pylspOptions) => {
    const root = fixture((files) => {
      const config = lspSoleauxConfigSchema.parse(JSON.parse(files["lsp-soleaux.json"] ?? "{}"));
      const pythonServer = config.servers.find((server) => server.extensions?.includes("py"));
      if (pythonServer) {
        pythonServer.initializationOptions = { pylsp: pylspOptions };
      }
      files["lsp-soleaux.json"] = JSON.stringify(config);
    });
    expect(() => check(root)).toThrow("as an object directly through initializationOptions.pylsp");
  });

  it("rejects inline CCLSP package versions", () => {
    const root = fixture((files) => {
      const config = lspSoleauxConfigSchema.parse(JSON.parse(files["lsp-soleaux.json"] ?? "{}"));
      config.servers.push({ command: ["npx", "--no-install", "yaml-language-server@1.24.0"] });
      files["lsp-soleaux.json"] = JSON.stringify(config);
    });
    expect(() => check(root)).toThrow("must not duplicate package versions");
  });

  it("rejects static tsserver configuration", () => {
    const root = fixture((files) => {
      const config = lspSoleauxConfigSchema.parse(JSON.parse(files["lsp-soleaux.json"] ?? "{}"));
      const javascriptServer = config.servers.find((server) => server.extensions?.includes("mjs"));
      if (javascriptServer) {
        javascriptServer.initializationOptions = { tsserver: { path: "legacy/tsserver.js" } };
      }
      files["lsp-soleaux.json"] = JSON.stringify(config);
    });
    expect(() => check(root)).toThrow("let the TypeScript proxy inject the tsserver path");
  });
});
