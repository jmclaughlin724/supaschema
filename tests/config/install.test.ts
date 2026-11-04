import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  resolveDatabaseUrl,
  resolveExplicitDatabaseUrl,
  resolveSupabaseLocalDatabaseUrl,
  resolveVerificationDatabaseUrl,
} from "../../src/database/url.js";
import {
  activeAgentFiles,
  excludedMaintainerFiles,
  expectedInstalledConfig,
  expectedSupaschemaScripts,
} from "../package/install-expectations.js";

const run = promisify(execFile);
const claudeProjectDirExpression = ["$", "{CLAUDE_PROJECT_DIR}"].join("");
const codexProjectDirExpression = ["$", "{CODEX_PROJECT_DIR:-$PWD}"].join("");
const codexGitRootExpression = ["$(", "git rev-parse --show-toplevel", ")"].join("");
const legacyClaudeSyncCommand = `node "${claudeProjectDirExpression}/.claude/hooks/sync-llm-on-claude-surface-change.mjs"`;
const legacyCodexSyncCommand = `node "${codexProjectDirExpression}/.codex/hooks/sync-llm-on-claude-surface-change.mjs"`;
const retiredCodexGeneralGuardCommand = `node "${codexGitRootExpression}/.codex/hooks/general-guard.mjs"`;
const retiredSyncHookFixture = join(
  process.cwd(),
  "tests/fixtures/agent-hooks/retired-sync-llm-on-claude-surface-change.mjs"
);

async function runScaffold(
  targetDir: string,
  options: { packageRoot?: string; repair?: boolean } = {}
) {
  const { scaffoldProject } = await import(
    pathToFileURL(join(process.cwd(), "bin/scaffold.mjs")).href
  );
  return scaffoldProject({
    interactive: false,
    packageRoot: options.packageRoot ?? process.cwd(),
    packageVersion: "test",
    repair: options.repair === true,
    targetDir,
  });
}

describe("supabase database URL discovery", () => {
  it("reads [db] port from the nearest supabase/config.toml, walking upward", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-url-"));
    await mkdir(join(root, "supabase"), { recursive: true });
    await writeFile(
      join(root, "supabase", "config.toml"),
      "[api]\nport = 64321\n\n[db]\nport = 64322 # local db\nshadow_port = 64320\nmajor_version = 17\n\n[studio]\nport = 64323\n"
    );
    const nested = join(root, "apps", "web");
    await mkdir(nested, { recursive: true });

    expect(resolveSupabaseLocalDatabaseUrl(nested)).toBe(
      "postgresql://postgres:postgres@127.0.0.1:64322/postgres"
    );
  });

  it("returns undefined when no supabase config exists upward", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-url-none-"));

    expect(resolveSupabaseLocalDatabaseUrl(root)).toBeUndefined();
  });

  it("applies the Supabase default port when [db] omits it", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-url-default-"));
    await mkdir(join(root, "supabase"), { recursive: true });
    await writeFile(join(root, "supabase", "config.toml"), "[db]\nmajor_version = 17\n");

    expect(resolveSupabaseLocalDatabaseUrl(root)).toBe(
      "postgresql://postgres:postgres@127.0.0.1:54322/postgres"
    );
  });

  it("uses the Supabase admin role only for auto-discovered verification", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-url-verify-"));
    await mkdir(join(root, "supabase"), { recursive: true });
    await writeFile(join(root, "supabase", "config.toml"), "[db]\nport = 64322\n");
    const previous = process.env.SUPASCHEMA_DATABASE_URL;
    delete process.env.SUPASCHEMA_DATABASE_URL;
    try {
      expect(resolveVerificationDatabaseUrl(undefined, root)).toBe(
        "postgresql://supabase_admin:postgres@127.0.0.1:64322/postgres"
      );
      expect(resolveSupabaseLocalDatabaseUrl(root)).toBe(
        "postgresql://postgres:postgres@127.0.0.1:64322/postgres"
      );
    } finally {
      if (previous === undefined) {
        delete process.env.SUPASCHEMA_DATABASE_URL;
      } else {
        process.env.SUPASCHEMA_DATABASE_URL = previous;
      }
    }
  });

  it("prefers an explicit value and supports $ENV indirection", () => {
    expect(resolveDatabaseUrl("postgresql://x@y/z")).toBe("postgresql://x@y/z");
    process.env.SUPA_URL_TEST = "postgresql://from-env@host/db";
    try {
      expect(resolveDatabaseUrl("$SUPA_URL_TEST")).toBe("postgresql://from-env@host/db");
    } finally {
      delete process.env.SUPA_URL_TEST;
    }
  });

  it("does not fall back to ambient database discovery for explicit-only resolution", () => {
    const previous = process.env.SUPASCHEMA_DATABASE_URL;
    process.env.SUPASCHEMA_DATABASE_URL = "postgresql://ambient@host/db";
    process.env.SUPA_URL_TEST = "postgresql://explicit@host/db";
    try {
      expect(resolveExplicitDatabaseUrl()).toBeUndefined();
      expect(resolveExplicitDatabaseUrl("$SUPA_URL_TEST")).toBe("postgresql://explicit@host/db");
    } finally {
      delete process.env.SUPA_URL_TEST;
      if (previous === undefined) {
        delete process.env.SUPASCHEMA_DATABASE_URL;
      } else {
        process.env.SUPASCHEMA_DATABASE_URL = previous;
      }
    }
  });
});

describe("init project setup", () => {
  it("installs config, directories, and active agent enforcement by default", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-"));

    await runScaffold(consumer);

    const config = JSON.parse(await readFile(join(consumer, "supaschema.config.json"), "utf8"));
    expect(config).toEqual(expectedInstalledConfig("database/schemas", "database/migrations"));
    expect(existsSync(join(consumer, "database/schemas"))).toBe(true);
    expect(existsSync(join(consumer, "database/migrations"))).toBe(true);
    expect(existsSync(join(consumer, ".supaschema"))).toBe(false);
    expect(existsSync(join(consumer, ".env.supaschema.example"))).toBe(false);

    for (const file of activeAgentFiles) {
      expect(existsSync(join(consumer, file)), file).toBe(true);
    }
    expect(existsSync(join(consumer, ".codex/skills"))).toBe(false);
    expect(existsSync(join(consumer, ".claude/skills/gitnexus"))).toBe(false);
    for (const file of excludedMaintainerFiles) {
      expect(existsSync(join(consumer, file)), file).toBe(false);
    }

    const prompt = await readFile(
      join(process.cwd(), "agent-bundle/agents/prompts/supaschema-install.md"),
      "utf8"
    );
    expect(existsSync(join(consumer, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(consumer, "CLAUDE.md"))).toBe(false);
    expect(prompt).toContain("active AI-agent rules, hooks, skills, prompts, and settings");
  });

  it("sets pnpm build approval for supaschema when initializing a pnpm workspace member", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "supa-init-pnpm-workspace-"));
    const member = join(workspace, "packages", "db");
    await mkdir(member, { recursive: true });
    await writeFile(
      join(workspace, "package.json"),
      `${JSON.stringify({
        name: "supaschema-pnpm-workspace-root",
        packageManager: "pnpm@11.1.2",
        private: true,
        version: "0.0.0",
      })}\n`
    );
    await writeFile(
      join(workspace, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\nallowBuilds:\n  supaschema: set this to true or false\n"
    );
    await writeFile(
      join(member, "package.json"),
      `${JSON.stringify({ name: "db", private: true, version: "0.0.0" })}\n`
    );

    await runScaffold(member);

    const workspaceYaml = await readFile(join(workspace, "pnpm-workspace.yaml"), "utf8");
    expect(workspaceYaml).toContain("allowBuilds:\n  supaschema: true\n");
    expect(workspaceYaml).not.toContain("set this to true or false");
    expect(existsSync(join(workspace, "supaschema.config.json"))).toBe(false);
    expect(existsSync(join(member, "supaschema.config.json"))).toBe(true);
  });

  it("adds pnpm build approval when a pnpm workspace has no allowBuilds block", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-pnpm-allow-builds-"));
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({
        name: "supaschema-pnpm-workspace-root",
        packageManager: "pnpm@11.1.2",
        private: true,
        version: "0.0.0",
      })}\n`
    );
    await writeFile(join(consumer, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");

    await runScaffold(consumer);

    const workspaceYaml = await readFile(join(consumer, "pnpm-workspace.yaml"), "utf8");
    expect(workspaceYaml).toBe("packages:\n  - packages/*\n\nallowBuilds:\n  supaschema: true\n");
  });

  it("normalizes a quoted pnpm approval without crossing the allowBuilds block", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-pnpm-quoted-approval-"));
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({
        name: "supaschema-pnpm-workspace-root",
        packageManager: "pnpm@11.1.2",
        private: true,
        version: "0.0.0",
      })}\n`
    );
    await writeFile(
      join(consumer, "pnpm-workspace.yaml"),
      'packages:\n  - "packages/*"\n\nallowBuilds:\n  "@ast-grep/cli": true\n  "supaschema": false\n  "unrs-resolver": true\n\nautoInstallPeers: false\n\ncatalog:\n  supaschema: 0.5.0\n'
    );

    const first = await runScaffold(consumer);
    const second = await runScaffold(consumer);

    const workspaceYaml = await readFile(join(consumer, "pnpm-workspace.yaml"), "utf8");
    const parsed = parseYaml(workspaceYaml);
    expect(first.installed).toContain("pnpm build approval");
    expect(second.installed).not.toContain("pnpm build approval");
    expect(parsed.allowBuilds.supaschema).toBe(true);
    expect(parsed.autoInstallPeers).toBe(false);
    expect(workspaceYaml).toContain(
      '  "@ast-grep/cli": true\n  supaschema: true\n  "unrs-resolver": true\n'
    );
    expect(workspaceYaml).not.toContain("autoInstallPeers: false\n  supaschema: true");
  });

  it("adds canonical package scripts to the owning package manifest", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-package-scripts-"));
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({
        name: "db",
        private: true,
        scripts: {
          test: "vitest",
        },
        version: "0.0.0",
      })}\n`
    );

    await runScaffold(consumer);

    const manifest = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
    expect(manifest.scripts).toEqual({
      test: "vitest",
      ...expectedSupaschemaScripts,
    });
  });

  it("preserves existing supaschema package scripts unless repair is requested", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-package-scripts-repair-"));
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({
        name: "db",
        private: true,
        scripts: {
          "supaschema:stage": "custom stage",
        },
        version: "0.0.0",
      })}\n`
    );

    await runScaffold(consumer);
    let manifest = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
    expect(manifest.scripts["supaschema:stage"]).toBe("custom stage");
    expect(manifest.scripts["supaschema:types"]).toBe("supaschema types");

    await runScaffold(consumer, { repair: true });
    manifest = JSON.parse(await readFile(join(consumer, "package.json"), "utf8"));
    expect(manifest.scripts).toMatchObject(expectedSupaschemaScripts);
  });

  it("uses Supabase paths when the project has Supabase local config", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-supabase-"));
    await mkdir(join(consumer, "supabase"), { recursive: true });
    await writeFile(join(consumer, "supabase", "config.toml"), "[db]\nport = 54322\n");

    await runScaffold(consumer);

    const config = JSON.parse(await readFile(join(consumer, "supaschema.config.json"), "utf8"));
    expect(config).toEqual(expectedInstalledConfig("supabase/schemas", "supabase/migrations"));
    expect(existsSync(join(consumer, "supabase/schemas"))).toBe(true);
    expect(existsSync(join(consumer, "supabase/migrations"))).toBe(true);
    expect(existsSync(join(consumer, ".supaschema"))).toBe(false);
  });

  it("scaffolds manual workflow config for Supabase bootstrap inventory trees", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-supabase-bootstrap-"));
    await writeNestedFile(join(consumer, "supabase/config.toml"), "[db]\nport = 54322\n");
    await writeNestedFile(
      join(consumer, "supabase/schemas/_bootstrap/00_roles.sql"),
      "create role app_runtime;\n"
    );

    await runScaffold(consumer);

    const config = JSON.parse(await readFile(join(consumer, "supaschema.config.json"), "utf8"));
    expect(config).toEqual(
      expectedInstalledConfig("supabase/schemas", "supabase/migrations", {
        workflow: { migration_sync: "manual", schema_diff: "manual" },
      })
    );
    expect(existsSync(join(consumer, ".supaschema"))).toBe(false);
    expect(existsSync(join(consumer, "AGENTS.md"))).toBe(false);
  });

  it("scaffolds manual workflow config when a Supabase owner marks schemas as inventory", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-supabase-owner-inventory-"));
    await writeNestedFile(join(consumer, "supabase/config.toml"), "[db]\nport = 54322\n");
    await writeNestedFile(
      join(consumer, "supabase/schemas/app/schema.sql"),
      "create schema app;\n"
    );
    await writeNestedFile(
      join(consumer, "supabase/AGENTS.md"),
      [
        "# Supabase",
        "",
        "`supabase/schemas/**` is the existing schema-source and contract-inventory surface while it remains in the repo; it is not the routine migration generator input.",
        "",
      ].join("\n")
    );

    await runScaffold(consumer);

    const config = JSON.parse(await readFile(join(consumer, "supaschema.config.json"), "utf8"));
    expect(config.workflow.schema_diff).toBe("manual");
    expect(config.workflow.migration_sync).toBe("manual");
    expect(config.schemaPaths).toEqual(["supabase/schemas"]);
    expect(config.migrationsDir).toBe("supabase/migrations");
    expect(config.sources).toEqual({ from: "auto" });
    expect(existsSync(join(consumer, ".supaschema"))).toBe(false);
  });

  it("reuses existing database URL env names for generic PostgreSQL sync targets", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-env-"));
    await writeFile(
      join(consumer, ".env.local"),
      "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app\nDIRECT_URL=postgresql://postgres:postgres@127.0.0.1:5432/app\n"
    );
    await mkdir(join(consumer, ".vercel"), { recursive: true });
    await writeFile(
      join(consumer, ".vercel", ".env.production.local"),
      "DATABASE_URL=postgresql://postgres:postgres@example.com:5432/app\n"
    );

    await runScaffold(consumer);

    const config = JSON.parse(await readFile(join(consumer, "supaschema.config.json"), "utf8"));
    expect(config.environments).toEqual({});
    expect(config.sync.targets.local.databaseUrl).toBe("$DIRECT_URL");
    expect(config.sync.targets.remote.databaseUrl).toBe("$DATABASE_URL");
    expect(existsSync(join(consumer, ".env.supaschema.example"))).toBe(false);
  });

  it("keeps Supabase sync on the Supabase CLI runner even when database URL envs exist", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-supabase-env-"));
    await mkdir(join(consumer, "supabase"), { recursive: true });
    await writeFile(join(consumer, "supabase", "config.toml"), "[db]\nport = 54322\n");
    await writeFile(
      join(consumer, ".env.local"),
      "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/app\nDIRECT_URL=postgresql://postgres:postgres@127.0.0.1:5432/app\nSUPABASE_DB_PASSWORD=secret\n"
    );

    await runScaffold(consumer);

    const config = JSON.parse(await readFile(join(consumer, "supaschema.config.json"), "utf8"));
    expect(config.sync.targets.local.runner).toBe("supabase-cli");
    expect(config.sync.targets.remote.runner).toBe("supabase-cli");
    expect(config.sync.targets.local.databaseUrl).toBeUndefined();
    expect(config.sync.targets.remote.databaseUrl).toBeUndefined();
  });

  it.each([
    {
      id: "neon",
      marker: "neon.toml",
      markerContent: "project_id = 'quiet-waterfall-123456'\n",
      migrationsDir: "neon/migrations",
      schemaPath: "neon/schemas",
    },
    {
      id: "aws-postgresql",
      marker: "infra/main.tf",
      markerContent: 'resource "aws_rds_cluster" "postgres" { engine = "aurora-postgresql" }\n',
      migrationsDir: "aws-postgresql/migrations",
      schemaPath: "aws-postgresql/schemas",
    },
    {
      id: "cloud-sql",
      marker: "infra/main.tf",
      markerContent: 'resource "google_sql_database_instance" "postgres" {}\n',
      migrationsDir: "cloud-sql/migrations",
      schemaPath: "cloud-sql/schemas",
    },
    {
      id: "alloydb",
      marker: "infra/main.tf",
      markerContent: 'resource "google_alloydb_cluster" "postgres" {}\n',
      migrationsDir: "alloydb/migrations",
      schemaPath: "alloydb/schemas",
    },
    {
      id: "azure-postgresql",
      marker: "infra/main.tf",
      markerContent: 'resource "azurerm_postgresql_flexible_server" "postgres" {}\n',
      migrationsDir: "azure-postgresql/migrations",
      schemaPath: "azure-postgresql/schemas",
    },
  ])(
    "uses $id paths when provider config markers are present",
    async ({ marker, markerContent, migrationsDir, schemaPath }) => {
      const consumer = await mkdtemp(join(tmpdir(), "supa-init-provider-"));
      await mkdir(dirname(join(consumer, marker)), { recursive: true });
      await writeFile(join(consumer, marker), markerContent);

      await runScaffold(consumer);

      const config = JSON.parse(await readFile(join(consumer, "supaschema.config.json"), "utf8"));
      expect(config).toEqual(expectedInstalledConfig(schemaPath, migrationsDir));
      expect(existsSync(join(consumer, schemaPath))).toBe(true);
      expect(existsSync(join(consumer, migrationsDir))).toBe(true);
      expect(existsSync(join(consumer, ".supaschema"))).toBe(false);
    }
  );

  it("preserves existing config and consumer-owned agent surfaces", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-existing-"));
    await writeFile(join(consumer, "supaschema.config.json"), '{"adapter":"auto"}\n');
    await writeFile(join(consumer, "AGENTS.md"), "# Existing agents\n\nKeep this.\n");
    await writeFile(join(consumer, "CLAUDE.md"), "@AGENTS.md\n");
    await writeNestedFile(join(consumer, ".claude/settings.json"), '{"hooks":{"PreToolUse":[]}}\n');
    await writeNestedFile(join(consumer, ".codex/hooks.json"), '{"hooks":{"Stop":[]}}\n');
    await writeNestedFile(join(consumer, ".codex/skills/custom/SKILL.md"), "custom skill\n");
    await writeNestedFile(
      join(consumer, ".agents/skills/supaschema/references/migrate.md"),
      "consumer Agent commands\n"
    );
    await writeNestedFile(
      join(consumer, ".claude/skills/supaschema/SKILL.md"),
      "consumer Claude skill\n"
    );

    const result = await runScaffold(consumer);

    expect(await readFile(join(consumer, "supaschema.config.json"), "utf8")).toBe(
      '{"adapter":"auto"}\n'
    );
    expect(await readFile(join(consumer, "AGENTS.md"), "utf8")).toBe(
      "# Existing agents\n\nKeep this.\n"
    );
    expect(await readFile(join(consumer, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    const claudeSettings = JSON.parse(
      await readFile(join(consumer, ".claude/settings.json"), "utf8")
    );
    expect(claudeSettings.hooks.PreToolUse).toEqual([
      expect.objectContaining({ matcher: "Write|Edit|MultiEdit|apply_patch" }),
    ]);
    expect(JSON.stringify(claudeSettings)).not.toContain("bash-policy-checks.mjs");
    const codexHooks = JSON.parse(await readFile(join(consumer, ".codex/hooks.json"), "utf8"));
    const packagedCodexHooks = JSON.parse(
      await readFile(join(process.cwd(), "agent-bundle/codex/hooks.npm.json"), "utf8")
    );
    expect(codexHooks.hooks.PreToolUse).toEqual(
      expect.arrayContaining(packagedCodexHooks.hooks.PreToolUse)
    );
    expect(codexHooks.hooks.PostToolUse).toEqual(
      expect.arrayContaining(packagedCodexHooks.hooks.PostToolUse)
    );
    expect(await readFile(join(consumer, ".codex/skills/custom/SKILL.md"), "utf8")).toBe(
      "custom skill\n"
    );
    expect(
      await readFile(join(consumer, ".agents/skills/supaschema/references/migrate.md"), "utf8")
    ).toBe("consumer Agent commands\n");
    expect(await readFile(join(consumer, ".claude/skills/supaschema/SKILL.md"), "utf8")).toBe(
      "consumer Claude skill\n"
    );
    expect(result.preserved).toEqual(
      expect.arrayContaining([
        ".agents/skills/supaschema/references/migrate.md",
        ".claude/skills/supaschema/SKILL.md",
      ])
    );
    expect(result.skipped).toEqual([]);
    for (const file of activeAgentFiles) {
      expect(existsSync(join(consumer, file)), file).toBe(true);
    }
  });

  it("replaces package-owned hook entries by command identity instead of duplicating them", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-hook-dedupe-"));
    await writeNestedFile(
      join(consumer, ".codex/hooks.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    command:
                      "pnpm exec -- supaschema hook generated-migration-edit --runtime codex",
                    statusMessage: "old message",
                    timeout: 1,
                    type: "command",
                  },
                ],
                matcher: "Write",
              },
            ],
          },
        },
        null,
        2
      )}\n`
    );

    await runScaffold(consumer);

    const codexHooks = JSON.parse(await readFile(join(consumer, ".codex/hooks.json"), "utf8"));
    const generatedMigrationEntries = codexHooks.hooks.PreToolUse.flatMap(
      (entry: { hooks?: { command?: string; timeout?: number }[] }) =>
        Array.isArray(entry.hooks)
          ? entry.hooks.filter((hook) =>
              hook.command?.includes("supaschema hook generated-artifact-edit")
            )
          : []
    );
    expect(generatedMigrationEntries).toHaveLength(1);
    expect(generatedMigrationEntries[0]).toMatchObject({
      command: "npm exec -- supaschema hook generated-artifact-edit --runtime codex",
      timeout: 10,
    });
  });

  it("replaces legacy Claude exec-form hooks with canonical shell-form hooks", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-claude-hook-command-shape-"));
    await writeNestedFile(
      join(consumer, ".claude/settings.json"),
      `${JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              {
                hooks: [
                  {
                    args: ["exec", "--", "supaschema", "hook", "schema-write"],
                    command: "npm",
                    statusMessage: "old message",
                    timeout: 1,
                    type: "command",
                  },
                ],
                matcher: "Write|Edit|MultiEdit|apply_patch",
              },
            ],
          },
        },
        null,
        2
      )}\n`
    );

    await runScaffold(consumer);

    const claudeSettings = JSON.parse(
      await readFile(join(consumer, ".claude/settings.json"), "utf8")
    );
    const schemaWriteHooks = claudeSettings.hooks.PostToolUse.flatMap(
      (entry: { hooks?: { args?: string[]; command?: string }[] }) =>
        Array.isArray(entry.hooks)
          ? entry.hooks.filter((hook) =>
              [hook.command, ...(hook.args ?? [])]
                .join(" ")
                .includes("supaschema hook schema-write")
            )
          : []
    );
    expect(schemaWriteHooks).toEqual([
      {
        command: "npm exec -- supaschema hook schema-write",
        statusMessage: "Running supaschema auto-diff on schema change",
        timeout: 130,
        type: "command",
      },
    ]);
  });

  it("preserves consumer-owned Bash hooks without installing the repository guard", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-consumer-bash-hook-"));
    await writeNestedFile(join(consumer, ".codex/hooks/tool-gate.mjs"), "export {};\n");
    await writeNestedFile(
      join(consumer, ".codex/hooks.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                hooks: [{ command: "node .codex/hooks/tool-gate.mjs", type: "command" }],
                matcher: "Bash",
              },
            ],
          },
        },
        null,
        2
      )}\n`
    );

    const result = await runScaffold(consumer);

    const hooks = JSON.parse(await readFile(join(consumer, ".codex/hooks.json"), "utf8"));
    const commands = hooks.hooks.PreToolUse.flatMap(
      (entry: { hooks?: { command?: string }[] }) => entry.hooks?.map((hook) => hook.command) ?? []
    );
    expect(commands).toContain("node .codex/hooks/tool-gate.mjs");
    expect(commands).toContain(
      "npm exec -- supaschema hook generated-artifact-edit --runtime codex"
    );
    expect(commands).not.toContain(retiredCodexGeneralGuardCommand);
    expect(existsSync(join(consumer, ".codex/hooks/general-guard.mjs"))).toBe(false);
    expect(existsSync(join(consumer, ".codex/hooks/guards/bash-policy-checks.mjs"))).toBe(false);
    expect(existsSync(join(consumer, ".claude/hooks/guards/bash-policy-checks.mjs"))).toBe(false);
    expect(result.skipped).toEqual([]);
  });

  it("removes retired package-owned sync hooks and unchanged scripts during upgrades", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-retired-sync-hook-"));
    const legacyScript = await readFile(retiredSyncHookFixture, "utf8");
    await writeNestedFile(
      join(consumer, ".claude/hooks/sync-llm-on-claude-surface-change.mjs"),
      legacyScript
    );
    await writeNestedFile(
      join(consumer, ".codex/hooks/sync-llm-on-claude-surface-change.mjs"),
      legacyScript
    );
    await writeNestedFile(
      join(consumer, ".claude/settings.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    args: [
                      `${claudeProjectDirExpression}/.claude/hooks/guards/bash-policy-checks.mjs`,
                    ],
                    command: "node",
                    type: "command",
                  },
                ],
                matcher: "Bash",
              },
            ],
            PostToolUse: [
              {
                hooks: [
                  {
                    command: legacyClaudeSyncCommand,
                    type: "command",
                  },
                  { command: "node .claude/hooks/custom.mjs", type: "command" },
                ],
                matcher: "Write|Edit|MultiEdit|apply_patch",
              },
            ],
          },
        },
        null,
        2
      )}\n`
    );
    await writeNestedFile(
      join(consumer, ".codex/hooks.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    command: retiredCodexGeneralGuardCommand,
                    type: "command",
                  },
                ],
                matcher: "Bash",
              },
            ],
            PostToolUse: [
              {
                hooks: [
                  {
                    command: legacyCodexSyncCommand,
                    type: "command",
                  },
                  { command: "node .codex/hooks/custom.mjs", type: "command" },
                ],
                matcher: "apply_patch",
              },
            ],
            Stop: [
              {
                hooks: [
                  {
                    command: legacyCodexSyncCommand,
                    type: "command",
                  },
                ],
              },
            ],
          },
        },
        2
      )}\n`
    );

    const result = await runScaffold(consumer);

    const claudeSettings = JSON.parse(
      await readFile(join(consumer, ".claude/settings.json"), "utf8")
    );
    const codexHooks = JSON.parse(await readFile(join(consumer, ".codex/hooks.json"), "utf8"));
    expect(JSON.stringify(claudeSettings)).not.toContain("sync-llm-on-claude-surface-change");
    expect(JSON.stringify(codexHooks)).not.toContain("sync-llm-on-claude-surface-change");
    expect(JSON.stringify(claudeSettings)).not.toContain("bash-policy-checks.mjs");
    expect(JSON.stringify(codexHooks)).not.toContain("general-guard.mjs");
    expect(JSON.stringify(claudeSettings)).toContain("node .claude/hooks/custom.mjs");
    expect(JSON.stringify(codexHooks)).toContain("node .codex/hooks/custom.mjs");
    expect(codexHooks.hooks.Stop).toBeUndefined();
    expect(existsSync(join(consumer, ".claude/hooks/sync-llm-on-claude-surface-change.mjs"))).toBe(
      false
    );
    expect(existsSync(join(consumer, ".codex/hooks/sync-llm-on-claude-surface-change.mjs"))).toBe(
      false
    );
    expect(result.agentBundle.files).toEqual(
      expect.arrayContaining([
        ".claude/hooks/sync-llm-on-claude-surface-change.mjs",
        ".codex/hooks/sync-llm-on-claude-surface-change.mjs",
      ])
    );
  });

  it("preserves a modified retired sync script after removing its registration", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-modified-sync-hook-"));
    const legacyScript = await readFile(retiredSyncHookFixture, "utf8");
    const path = ".claude/hooks/sync-llm-on-claude-surface-change.mjs";
    await writeNestedFile(join(consumer, path), `${legacyScript}\n// consumer modification\n`);
    await writeNestedFile(
      join(consumer, ".claude/settings.json"),
      `${JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              {
                hooks: [
                  {
                    command: legacyClaudeSyncCommand,
                    type: "command",
                  },
                ],
                matcher: "Write|Edit|MultiEdit|apply_patch",
              },
            ],
          },
        },
        null,
        2
      )}\n`
    );

    const result = await runScaffold(consumer);

    expect(existsSync(join(consumer, path))).toBe(true);
    expect(result.preserved).toContain(path);
    expect(await readFile(join(consumer, ".claude/settings.json"), "utf8")).not.toContain(
      "sync-llm-on-claude-surface-change"
    );
  });

  it("keeps consumer hooks on their original matcher when replacing package hooks", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-hook-split-"));
    await writeNestedFile(
      join(consumer, ".codex/hooks.json"),
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  {
                    command:
                      "pnpm exec -- supaschema hook generated-migration-edit --runtime codex",
                    statusMessage: "old message",
                    timeout: 1,
                    type: "command",
                  },
                  {
                    command: "node ./custom-hook.mjs",
                    timeout: 2,
                    type: "command",
                  },
                ],
                matcher: "Write",
              },
            ],
          },
        },
        null,
        2
      )}\n`
    );

    await runScaffold(consumer);

    interface HookEntry {
      hooks?: { command?: string; timeout?: number; type?: string }[];
      matcher?: string;
    }
    const codexHooks = JSON.parse(await readFile(join(consumer, ".codex/hooks.json"), "utf8"));
    const preToolUse: HookEntry[] = Array.isArray(codexHooks.hooks.PreToolUse)
      ? codexHooks.hooks.PreToolUse
      : [];
    const customEntries = preToolUse.filter((entry) =>
      entry.hooks?.some((hook) => hook.command === "node ./custom-hook.mjs")
    );
    const packagedCodexHooks = JSON.parse(
      await readFile(join(process.cwd(), "agent-bundle/codex/hooks.npm.json"), "utf8")
    );
    const packagedGeneratedEntry = packagedCodexHooks.hooks.PreToolUse.find((entry: HookEntry) =>
      entry.hooks?.some((hook) => hook.command?.includes("supaschema hook generated-artifact-edit"))
    );

    expect(customEntries).toHaveLength(1);
    expect(customEntries[0]).toMatchObject({ matcher: "Write" });
    expect(customEntries[0]?.hooks).toEqual([
      expect.objectContaining({ command: "node ./custom-hook.mjs", timeout: 2 }),
    ]);
    expect(preToolUse).toContainEqual(packagedGeneratedEntry);
  });

  it("installs only package enforcement surfaces, not Anilize-style context or backups", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-anilize-context-"));
    await writeFile(
      join(consumer, "package.json"),
      `${JSON.stringify({ name: "anilize-like", packageManager: "pnpm@11.1.2", private: true })}\n`
    );
    await writeNestedFile(join(consumer, "CLAUDE.md"), "@AGENTS.md\n");
    await writeNestedFile(join(consumer, "AGENTS.md"), "# Consumer brief\n\nKeep this.\n");
    await writeNestedFile(join(consumer, "supabase/config.toml"), "[db]\nport = 54322\n");
    await writeNestedFile(
      join(consumer, "supabase/schemas/_bootstrap/00_roles.sql"),
      "create role app_runtime;\n"
    );

    await runScaffold(consumer);

    expect(await readFile(join(consumer, "AGENTS.md"), "utf8")).toBe(
      "# Consumer brief\n\nKeep this.\n"
    );
    expect(await readFile(join(consumer, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    const config = JSON.parse(await readFile(join(consumer, "supaschema.config.json"), "utf8"));
    expect(config.workflow.schema_diff).toBe("manual");
    expect(config.workflow.migration_sync).toBe("manual");
    expect(config.schemaPaths).toEqual(["supabase/schemas"]);
    expect(config.migrationsDir).toBe("supabase/migrations");
    expect(existsSync(join(consumer, ".supaschema"))).toBe(false);
    for (const file of activeAgentFiles) {
      expect(existsSync(join(consumer, file)), file).toBe(true);
    }
    for (const backupDir of [
      ".agents/skills.__backup_20260619T040853",
      ".claude/settings.__backup_20260619T040912",
      ".codex/rules.__backup_20260619T040927",
    ]) {
      expect(existsSync(join(consumer, backupDir)), backupDir).toBe(false);
    }
  });

  it("rejects removed migration_sync values during repair", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-legacy-sync-"));
    await writeFile(
      join(consumer, "supaschema.config.json"),
      `${JSON.stringify(
        {
          adapter: "auto",
          migrationsDir: "database/migrations",
          schemaPaths: ["database/schemas"],
          sources: { from: "auto" },
          workflow: { migration_sync: "explicit_request_only" },
        },
        null,
        2
      )}\n`
    );

    await expect(runScaffold(consumer, { repair: true })).rejects.toThrow(
      "workflow.migration_sync is not a supported policy"
    );
  });

  it("scans existing schema and migration folders for the generated config", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-scan-"));
    await mkdir(join(consumer, "database", "schema"), { recursive: true });
    await mkdir(join(consumer, "database", "migrations"), { recursive: true });
    await writeFile(join(consumer, "database", "schema", "schema.sql"), "create schema app;\n");
    await writeFile(
      join(consumer, "database", "migrations", "20260101000000_init.sql"),
      "select 1;\n"
    );

    await runScaffold(consumer);

    const config = JSON.parse(await readFile(join(consumer, "supaschema.config.json"), "utf8"));
    expect(config.schemaPaths).toEqual(["database/schema"]);
    expect(config.migrationsDir).toBe("database/migrations");
    expect(existsSync(join(consumer, ".supaschema"))).toBe(false);
  });

  it("prefers nested provider schema paths before pruning broad provider SQL directories", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-provider-schema-prune-"));
    await writeNestedFile(join(consumer, "supabase", "config.toml"), "[db]\nport = 54322\n");
    await writeNestedFile(join(consumer, "supabase", "seed.sql"), "select 1;\n");
    await writeNestedFile(
      join(consumer, "supabase", "schemas", "app", "schema.sql"),
      "create schema app;\n"
    );
    await writeNestedFile(
      join(consumer, "supabase", "migrations", "20260101000000_init.sql"),
      "select 1;\n"
    );

    await runScaffold(consumer);

    const config = JSON.parse(await readFile(join(consumer, "supaschema.config.json"), "utf8"));
    expect(config.schemaPaths).toEqual(["supabase/schemas"]);
    expect(config.sources).toEqual({ from: "auto" });
    expect(config.migrationsDir).toBe("supabase/migrations");
    expect(existsSync(join(consumer, ".supaschema"))).toBe(false);
  });

  it("records ambiguous scanned paths for agent confirmation", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-ambiguous-"));
    await mkdir(join(consumer, "apps", "api", "schemas"), { recursive: true });
    await mkdir(join(consumer, "packages", "db", "schemas"), { recursive: true });
    await mkdir(join(consumer, "apps", "api", "migrations"), { recursive: true });
    await mkdir(join(consumer, "packages", "db", "migrations"), { recursive: true });
    await writeFile(join(consumer, "apps", "api", "schemas", "schema.sql"), "create schema app;\n");
    await writeFile(
      join(consumer, "packages", "db", "schemas", "schema.sql"),
      "create schema app;\n"
    );
    await writeFile(
      join(consumer, "apps", "api", "migrations", "20260101000000_init.sql"),
      "select 1;\n"
    );
    await writeFile(
      join(consumer, "packages", "db", "migrations", "20260101000000_init.sql"),
      "select 1;\n"
    );

    await runScaffold(consumer);

    const manifest = JSON.parse(await readFile(join(consumer, ".supaschema/install.json"), "utf8"));
    expect(manifest.pathConfirmationNeeded).toBe(true);
    expect(manifest.candidates.schemaPaths).toEqual(["apps/api/schemas", "packages/db/schemas"]);
    expect(manifest.agentInstructions.requiredActions).toContain(
      "Create or update supaschema.config.json with schemaPaths and migrationsDir."
    );
    expect(manifest.recommendedConfig.sources).toEqual({ from: "auto" });
    for (const file of activeAgentFiles) {
      expect(existsSync(join(consumer, file)), file).toBe(true);
    }
    expect(existsSync(join(consumer, "AGENTS.md"))).toBe(false);
  });

  it("runs from the packed npm tarball with all required installer inputs", {
    timeout: 30_000,
  }, async () => {
    const packDir = await mkdtemp(join(tmpdir(), "supa-pack-"));
    const consumer = await mkdtemp(join(tmpdir(), "supa-packed-install-"));
    const extractDir = await mkdtemp(join(tmpdir(), "supa-pack-extract-"));
    const npm = npmExec(["pack", "--json", "--ignore-scripts", "--pack-destination", packDir]);
    const { stdout } = await run(npm.file, npm.args);
    const [packed] = JSON.parse(stdout);
    const tarball = join(packDir, packed.filename);

    await run("tar", ["-xzf", tarball, "-C", extractDir]);
    for (const file of [
      ".vscode/settings.json",
      ".mcp.json",
      ".claude/settings.json",
      "lsp-soleaux.json",
      "components.json",
      "postgres-language-server.jsonc",
      "pyproject.toml",
      "styles/globals.css",
    ]) {
      expect(existsSync(join(extractDir, "package", file)), file).toBe(false);
    }
    for (const file of [
      "agent-bundle/INSTALL.md",
      "agent-bundle/agents/prompts/supaschema-install.md",
      "agent-bundle/claude/settings.npm.json",
      "agent-bundle/codex/hooks.npm.json",
    ]) {
      expect(existsSync(join(extractDir, "package", file)), file).toBe(true);
    }
    await runScaffold(consumer, { packageRoot: join(extractDir, "package") });

    expect(existsSync(join(consumer, "supaschema.config.json"))).toBe(true);
    for (const file of activeAgentFiles) {
      expect(existsSync(join(consumer, file)), file).toBe(true);
    }
    for (const backupDir of [
      ".agents/skills.__backup_20260619T040853",
      ".claude/settings.__backup_20260619T040912",
      ".codex/rules.__backup_20260619T040927",
    ]) {
      expect(existsSync(join(consumer, backupDir)), backupDir).toBe(false);
    }
    expect(existsSync(join(consumer, ".vscode/settings.json"))).toBe(false);
    expect(existsSync(join(consumer, ".mcp.json"))).toBe(false);
    expect(existsSync(join(consumer, "lsp-soleaux.json"))).toBe(false);
    expect(existsSync(join(consumer, "postgres-language-server.jsonc"))).toBe(false);
    expect(existsSync(join(consumer, "pyproject.toml"))).toBe(false);
    expect(existsSync(join(consumer, "components.json"))).toBe(false);
    expect(existsSync(join(consumer, "AGENTS.md"))).toBe(false);
  });

  it("does not create install state on a no-op resolved re-install", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-idempotent-"));

    await runScaffold(consumer);
    expect(existsSync(join(consumer, ".supaschema"))).toBe(false);
    await mkdir(join(consumer, ".supaschema"), { recursive: true });
    await writeFile(
      join(consumer, ".supaschema", "install.json"),
      '{"pathConfirmationNeeded":false}\n'
    );
    await runScaffold(consumer);

    expect(existsSync(join(consumer, ".supaschema"))).toBe(false);
  });

  it("resolves a sparse existing config through the CLI defaults, not provider detection", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-sparse-"));
    await mkdir(join(consumer, "supabase"), { recursive: true });
    await writeFile(join(consumer, "supabase", "config.toml"), "[db]\nport = 54322\n");
    await writeFile(join(consumer, "supaschema.config.json"), "{}\n");

    await runScaffold(consumer);

    expect(await readFile(join(consumer, "supaschema.config.json"), "utf8")).toBe("{}\n");
    expect(existsSync(join(consumer, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(consumer, "database/schemas"))).toBe(true);
    expect(existsSync(join(consumer, ".supaschema"))).toBe(false);
  });

  it("ignores JavaScript config files and writes the canonical JSON config", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-module-"));
    await writeFile(
      join(consumer, "supaschema.config.mjs"),
      'export default { schemaPaths: ["db/sql"], migrationsDir: "db/changes" };\n'
    );

    await runScaffold(consumer);

    expect(existsSync(join(consumer, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(consumer, "db/sql"))).toBe(false);
    expect(existsSync(join(consumer, "db/changes"))).toBe(false);
    expect(existsSync(join(consumer, "database/schemas"))).toBe(true);
    expect(existsSync(join(consumer, "database/migrations"))).toBe(true);
    expect(JSON.parse(await readFile(join(consumer, "supaschema.config.json"), "utf8"))).toEqual(
      expectedInstalledConfig("database/schemas", "database/migrations")
    );
    expect(existsSync(join(consumer, ".supaschema"))).toBe(false);
  });

  it("does not scaffold a guessed config while path confirmation is pending", async () => {
    const consumer = await mkdtemp(join(tmpdir(), "supa-init-pending-"));
    await mkdir(join(consumer, "apps", "api", "schemas"), { recursive: true });
    await mkdir(join(consumer, "packages", "db", "schemas"), { recursive: true });
    await writeFile(join(consumer, "apps", "api", "schemas", "schema.sql"), "create schema app;\n");
    await writeFile(
      join(consumer, "packages", "db", "schemas", "schema.sql"),
      "create schema app;\n"
    );

    await runScaffold(consumer);

    expect(existsSync(join(consumer, "supaschema.config.json"))).toBe(false);
    const manifest = JSON.parse(await readFile(join(consumer, ".supaschema/install.json"), "utf8"));
    expect(manifest.pathConfirmationNeeded).toBe(true);
    expect(manifest.agentInstructions.summary).toContain(
      "supaschema found multiple plausible schema or migration paths"
    );
  });
});

function npmExec(args: string[]): { args: string[]; file: string } {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return { args: [npmExecPath, ...args], file: process.execPath };
  }
  return { args, file: process.platform === "win32" ? "npm.cmd" : "npm" };
}

async function writeNestedFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}
