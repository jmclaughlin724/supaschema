import { execFileSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { Client } from "pg";
import { describe, expect, it, test } from "vitest";
import { registerReportCommands } from "../../src/cli/reports.js";
import { resolveConfig } from "../../src/config/schema.js";
import { resolveDatabaseUrl } from "../../src/database/url.js";
import { diagnosticCatalog } from "../../src/diagnostics/catalog.js";
import { MODEL_FORMAT_VERSION } from "../../src/hash.js";
import { parseLineage } from "../../src/migrations/lineage.js";
import { stageGeneratedMigrations } from "../../src/migrations/stage.js";
import { resolveGenerationSourceDefaults } from "../../src/planner/context.js";
import type { Diagnostic } from "../../src/types.js";
import { syncMigrations } from "../../src/workflow/sync.js";
import { resolveSyncTargets } from "../../src/workflow/targets.js";

const databaseUrl = process.env.SUPASCHEMA_TEST_DATABASE_URL ?? resolveDatabaseUrl();
const gitFixtureTimeoutMs = 15_000;

async function captureStdout(action: () => Promise<void>): Promise<string> {
  let output = "";
  const write = process.stdout.write;
  const capture: typeof process.stdout.write = (chunk: string | Uint8Array) => {
    output += typeof chunk === "string" ? chunk : chunk.toString();
    return true;
  };
  process.stdout.write = capture;
  try {
    await action();
  } finally {
    process.stdout.write = write;
  }
  return output;
}

function reportProgram(context: Parameters<typeof registerReportCommands>[1]): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerReportCommands(program, context);
  return program;
}

describe("sync (no target)", () => {
  it("dry-runs disk history without replay-checking hand-authored files", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-"));
    await writeFile(
      join(root, "20260101000000_safe.sql"),
      "CREATE TABLE IF NOT EXISTS app.t (id bigint PRIMARY KEY);\n"
    );

    const result = await syncMigrations({ directory: root });

    expect(result.applied).toBe(false);
    expect(result.pending).toEqual(["20260101000000_safe.sql"]);
    expect(result.report).toContain("dry run");
    expect(result.report).not.toContain("replay-safe");
  });

  it("does not block no-target sync on hand-authored historical failures", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-bad-"));
    await writeFile(join(root, "20260101000000_unsafe.sql"), "DROP TABLE app.t;\n");

    const result = await syncMigrations({ directory: root });

    expect(result.applied).toBe(false);
    expect(result.report).toContain("dry run");
    expect(result.report).not.toContain("fails the replay-safety check");
    expect(result.diagnostics.some((item) => item.severity === "error")).toBe(false);
  });

  it("refuses when a generated pending migration fails the replay-safety check", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-generated-bad-"));
    await writeFile(
      join(root, "20260101000000_unsafe.sql"),
      "-- supaschema: lineage from=before to=after\nDROP TABLE app.t;\n"
    );

    const result = await syncMigrations({ directory: root });

    expect(result.applied).toBe(false);
    expect(result.report).toContain("refusing to sync");
    expect(result.diagnostics.some((item) => item.severity === "error")).toBe(true);
  });

  it("refuses apply handoff when workflow.migration_sync is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-disabled-"));

    const result = await syncMigrations({
      config: { workflow: { migration_sync: "disabled" } },
      directory: root,
      target: "local",
    });

    expect(result.applied).toBe(false);
    expect(result.report).toContain('workflow.migration_sync is "disabled"');
    expect(result.diagnostics.map((item) => item.code)).toContain("SUPA_SYNC_DISABLED");
  });

  it("runs the non-mutating bare sync lane when workflow.migration_sync is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-disabled-bare-"));

    const result = await syncMigrations({
      config: {
        sources: { from: "empty:" },
        workflow: { migration_sync: "disabled" },
      },
      directory: root,
      pipeline: true,
      skipDiff: true,
      to: "empty:",
    });

    expect(result.applied).toBe(false);
    expect(result.report).toContain("nothing to sync");
    expect(result.diagnostics.map((item) => item.code)).not.toContain("SUPA_SYNC_DISABLED");
  });

  it("refuses explicit target override when workflow.migration_sync is disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-disabled-target-"));

    const result = await syncMigrations({
      config: { workflow: { migration_sync: "disabled" } },
      directory: root,
      pipeline: true,
      skipDiff: true,
      target: "local",
    });

    expect(result.applied).toBe(false);
    expect(result.report).toContain('workflow.migration_sync is "disabled"');
    expect(result.diagnostics.map((item) => item.code)).toContain("SUPA_SYNC_DISABLED");
  });

  it("refuses an explicit named target that is not configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-unknown-target-"));

    const result = await syncMigrations({
      config: {
        sources: { from: "empty:" },
        workflow: { rls_safety: "disabled", type_safety: "disabled" },
      },
      directory: root,
      pipeline: true,
      skipDiff: true,
      target: "staging",
      to: "empty:",
    });

    expect(result.applied).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("SUPA_SYNC_TARGET_UNKNOWN");
    expect(result.report).toContain("target resolution failed");
  });

  it.skipIf(process.platform === "win32")(
    "reports an unavailable runner when the Supabase CLI cannot be launched",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "supa-sync-no-cli-"));
      await writeFile(
        join(root, "20260101000000_safe.sql"),
        "CREATE TABLE IF NOT EXISTS app.t (id bigint PRIMARY KEY);\n"
      );
      const oldPath = process.env.PATH;
      const oldDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
      process.env.PATH = await mkdtemp(join(tmpdir(), "supa-empty-path-"));
      delete process.env.SUPASCHEMA_DATABASE_URL;
      try {
        const result = await syncMigrations({
          config: {
            sources: { from: "empty:" },
            sync: {
              targets: {
                local: {
                  historyTable: "supabase_migrations.schema_migrations",
                  mode: "manual",
                  runner: "supabase-cli",
                },
              },
            },
            workflow: { rls_safety: "disabled", type_safety: "disabled" },
          },
          directory: root,
          operation: "apply",
          pipeline: true,
          skipDiff: true,
          target: "local",
          to: "empty:",
        });

        expect(result.applied).toBe(false);
        expect(result.diagnostics.map((item) => item.code)).toContain(
          "SUPA_SYNC_RUNNER_UNAVAILABLE"
        );
        expect(result.diagnostics.map((item) => item.code)).not.toContain(
          "SUPA_SYNC_RUNNER_FAILED"
        );
      } finally {
        process.env.PATH = oldPath;
        if (oldDatabaseUrl === undefined) {
          delete process.env.SUPASCHEMA_DATABASE_URL;
        } else {
          process.env.SUPASCHEMA_DATABASE_URL = oldDatabaseUrl;
        }
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "does not require a verify database URL before URL-less Supabase CLI sync targets",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "supa-sync-cli-url-less-"));
      await writeFile(
        join(root, "20260101000000_safe.sql"),
        "CREATE TABLE IF NOT EXISTS app.t (id bigint PRIMARY KEY);\n"
      );
      const oldPath = process.env.PATH;
      const oldDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
      const previousCwd = process.cwd();
      const isolatedPath = await mkdtemp(join(tmpdir(), "supa-isolated-path-"));
      const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
      await symlink(gitPath, join(isolatedPath, "git"));
      process.env.PATH = isolatedPath;
      delete process.env.SUPASCHEMA_DATABASE_URL;
      process.chdir(root);
      try {
        const result = await syncMigrations({
          config: {
            sources: { from: "empty:" },
            sync: {
              targets: {
                local: {
                  historyTable: "supabase_migrations.schema_migrations",
                  mode: "manual",
                  runner: "supabase-cli",
                },
              },
            },
            workflow: { rls_safety: "disabled", type_safety: "disabled" },
          },
          directory: root,
          pipeline: true,
          skipDiff: true,
          target: "local",
          to: "empty:",
        });

        expect(result.applied).toBe(false);
        const codes = result.diagnostics.map((item) => item.code);
        expect(codes, JSON.stringify(codes)).toContain("SUPA_SYNC_RUNNER_UNAVAILABLE");
        expect(result.report).not.toContain("verify:");
      } finally {
        process.chdir(previousCwd);
        process.env.PATH = oldPath;
        if (oldDatabaseUrl === undefined) {
          delete process.env.SUPASCHEMA_DATABASE_URL;
        } else {
          process.env.SUPASCHEMA_DATABASE_URL = oldDatabaseUrl;
        }
      }
    },
    15_000
  );

  it.skipIf(process.platform === "win32")(
    "does not replay-check hand-authored history before URL-less Supabase CLI targets",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "supa-sync-cli-history-"));
      const binDir = await mkdtemp(join(tmpdir(), "supa-sync-cli-history-bin-"));
      await writeFile(join(binDir, "supabase"), "#!/bin/sh\nexit 0\n");
      await chmod(join(binDir, "supabase"), 0o755);
      await writeFile(join(root, "20260101000000_unsafe.sql"), "DROP TABLE app.t;\n");
      const oldPath = process.env.PATH;
      const oldDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
      const previousCwd = process.cwd();
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      delete process.env.SUPASCHEMA_DATABASE_URL;
      process.chdir(root);
      try {
        const result = await syncMigrations({
          config: {
            sources: { from: "empty:" },
            sync: {
              targets: {
                local: {
                  historyTable: "supabase_migrations.schema_migrations",
                  mode: "manual",
                  runner: "supabase-cli",
                },
              },
            },
            workflow: { rls_safety: "disabled", type_safety: "disabled" },
          },
          directory: root,
          pipeline: true,
          skipDiff: true,
          target: "local",
          to: "empty:",
        });

        expect(result.applied).toBe(true);
        expect(result.report).toContain("running: supabase migration up");
        expect(result.report).not.toContain("fails the replay-safety check");
        expect(result.diagnostics.some((item) => item.severity === "error")).toBe(false);
      } finally {
        process.chdir(previousCwd);
        process.env.PATH = oldPath;
        if (oldDatabaseUrl === undefined) {
          delete process.env.SUPASCHEMA_DATABASE_URL;
        } else {
          process.env.SUPASCHEMA_DATABASE_URL = oldDatabaseUrl;
        }
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "retries a failed Supabase CLI sync without generating a duplicate migration",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "supa-sync-cli-retry-"));
      const binDir = await mkdtemp(join(tmpdir(), "supa-sync-cli-retry-bin-"));
      const schemaDir = join(root, "database", "schemas");
      const migrationsDir = join(root, "database", "migrations");
      const marker = join(root, "runner-failed-once");
      const log = join(root, "supabase.log");
      await mkdir(schemaDir, { recursive: true });
      await mkdir(migrationsDir, { recursive: true });
      await writeFile(
        join(schemaDir, "app.sql"),
        "CREATE TABLE public.retry_account (id bigint PRIMARY KEY);\n"
      );
      await writeFile(
        join(binDir, "supabase"),
        `#!/usr/bin/env node
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
if (!existsSync(${JSON.stringify(marker)})) {
  writeFileSync(${JSON.stringify(marker)}, "failed once\\n");
  process.exit(42);
}
`
      );
      await chmod(join(binDir, "supabase"), 0o755);
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      const config = resolveConfig({
        migrationsDir: "database/migrations",
        schemaPaths: ["database/schemas"],
        sources: { from: "auto" },
        sync: {
          targets: {
            local: {
              historyTable: "supabase_migrations.schema_migrations",
              mode: "manual",
              runner: "supabase-cli",
            },
          },
        },
        workflow: {
          migration_sync: "auto",
          rls_safety: "disabled",
          type_generation: "disabled",
          type_safety: "disabled",
          zod_generation: "disabled",
        },
      });
      const previousCwd = process.cwd();
      const previousDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
      const previousPath = process.env.PATH;
      process.env.PATH = `${binDir}:${previousPath ?? ""}`;
      delete process.env.SUPASCHEMA_DATABASE_URL;
      process.chdir(root);
      try {
        const first = await syncMigrations({
          config,
          directory: migrationsDir,
          pipeline: true,
          target: "local",
        });
        const firstFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql"));

        expect(first.applied).toBe(false);
        expect(first.diagnostics.map((item) => item.code)).toContain("SUPA_SYNC_RUNNER_FAILED");
        expect(firstFiles).toHaveLength(1);

        const retry = await syncMigrations({
          config,
          directory: migrationsDir,
          pipeline: true,
          target: "local",
        });
        const retryFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql"));

        expect(retry.applied).toBe(true);
        expect(retry.report).toContain("diff: no schema changes");
        expect(retry.report).toContain("running: supabase migration up");
        expect(retryFiles).toEqual(firstFiles);
        expect(await readFile(log, "utf8")).toBe("migration up\nmigration up\n");
      } finally {
        process.chdir(previousCwd);
        process.env.PATH = previousPath;
        if (previousDatabaseUrl === undefined) {
          delete process.env.SUPASCHEMA_DATABASE_URL;
        } else {
          process.env.SUPASCHEMA_DATABASE_URL = previousDatabaseUrl;
        }
      }
    },
    15_000
  );

  it("replay-checks generated lineage before URL-less Supabase CLI targets", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-cli-generated-"));
    const oldDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
    const previousCwd = process.cwd();
    await writeFile(
      join(root, "20260101000000_unsafe.sql"),
      "-- supaschema: lineage from=before to=after\nDROP TABLE app.t;\n"
    );
    delete process.env.SUPASCHEMA_DATABASE_URL;
    process.chdir(root);
    try {
      const result = await syncMigrations({
        config: {
          sources: { from: "empty:" },
          sync: {
            targets: {
              local: {
                historyTable: "supabase_migrations.schema_migrations",
                mode: "manual",
                runner: "supabase-cli",
              },
            },
          },
          workflow: { rls_safety: "disabled", type_safety: "disabled" },
        },
        directory: root,
        pipeline: true,
        skipDiff: true,
        target: "local",
        to: "empty:",
      });

      expect(result.applied).toBe(false);
      expect(result.report).toContain("fails the replay-safety check");
      expect(result.report).not.toContain("running: supabase migration up");
      expect(result.diagnostics.some((item) => item.severity === "error")).toBe(true);
    } finally {
      process.chdir(previousCwd);
      if (oldDatabaseUrl === undefined) {
        delete process.env.SUPASCHEMA_DATABASE_URL;
      } else {
        process.env.SUPASCHEMA_DATABASE_URL = oldDatabaseUrl;
      }
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not run disk-only final reconcile after URL-less Supabase CLI sync succeeds",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "supa-sync-cli-reconcile-"));
      const bin = await mkdtemp(join(tmpdir(), "supa-sync-cli-bin-"));
      const log = join(root, "supabase.log");
      const supabase = join(bin, "supabase");
      await writeFile(
        supabase,
        `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(" ") + "\\n");
`
      );
      await chmod(supabase, 0o755);
      await writeFile(
        join(root, "20260101000000_safe.sql"),
        "CREATE TABLE IF NOT EXISTS app.t (id bigint PRIMARY KEY);\n"
      );
      const oldPath = process.env.PATH;
      const oldDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
      const previousCwd = process.cwd();
      process.env.PATH = `${bin}:${oldPath ?? ""}`;
      delete process.env.SUPASCHEMA_DATABASE_URL;
      process.chdir(root);
      try {
        const result = await syncMigrations({
          config: {
            sources: { from: "empty:" },
            sync: {
              targets: {
                local: {
                  historyTable: "supabase_migrations.schema_migrations",
                  mode: "manual",
                  runner: "supabase-cli",
                },
              },
            },
            workflow: { rls_safety: "disabled", type_safety: "disabled" },
          },
          directory: root,
          pipeline: true,
          skipDiff: true,
          target: "local",
          to: "empty:",
        });

        expect(result.applied).toBe(true);
        expect(result.report).toContain("running: supabase migration up");
        expect(result.report).toContain("final reconcile: skipped for local");
        expect(result.diagnostics.map((item) => item.code)).not.toContain(
          "SUPA_SYNC_FINAL_RECONCILE_FAILED"
        );
        expect(await readFile(log, "utf8")).toBe("migration up\n");
      } finally {
        process.chdir(previousCwd);
        process.env.PATH = oldPath;
        if (oldDatabaseUrl === undefined) {
          delete process.env.SUPASCHEMA_DATABASE_URL;
        } else {
          process.env.SUPASCHEMA_DATABASE_URL = oldDatabaseUrl;
        }
      }
    }
  );

  it.skipIf(process.platform === "win32")(
    "preserves the generic runner-failed diagnostic for a real nonzero exit",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "supa-sync-exit-"));
      await writeFile(
        join(root, "20260101000000_safe.sql"),
        "CREATE TABLE IF NOT EXISTS app.t (id bigint PRIMARY KEY);\n"
      );
      const binDir = await mkdtemp(join(tmpdir(), "supa-sync-bin-"));
      await writeFile(join(binDir, "supabase"), "#!/bin/sh\nexit 42\n", { mode: 0o755 });
      const oldPath = process.env.PATH;
      const oldDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
      process.env.PATH = binDir;
      delete process.env.SUPASCHEMA_DATABASE_URL;
      try {
        const result = await syncMigrations({
          config: {
            sources: { from: "empty:" },
            sync: {
              targets: {
                local: {
                  historyTable: "supabase_migrations.schema_migrations",
                  mode: "manual",
                  runner: "supabase-cli",
                },
              },
            },
            workflow: { rls_safety: "disabled", type_safety: "disabled" },
          },
          directory: root,
          operation: "apply",
          pipeline: true,
          skipDiff: true,
          target: "local",
          to: "empty:",
        });

        expect(result.applied).toBe(false);
        expect(result.diagnostics.map((item) => item.code)).toContain("SUPA_SYNC_RUNNER_FAILED");
        expect(result.diagnostics.map((item) => item.code)).not.toContain(
          "SUPA_SYNC_RUNNER_UNAVAILABLE"
        );
        expect(
          result.diagnostics.find((item) => item.code === "SUPA_SYNC_RUNNER_FAILED")?.message
        ).toContain("exited with code 42");
      } finally {
        process.env.PATH = oldPath;
        if (oldDatabaseUrl === undefined) {
          delete process.env.SUPASCHEMA_DATABASE_URL;
        } else {
          process.env.SUPASCHEMA_DATABASE_URL = oldDatabaseUrl;
        }
      }
    }
  );
});

describe("sync diagnostics", () => {
  it("keeps sync diagnostic codes explainable", () => {
    expect(diagnosticCatalog.SUPA_SYNC_DISABLED).toBeDefined();
    expect(diagnosticCatalog.SUPA_SYNC_ENV_UNKNOWN).toBeDefined();
    expect(diagnosticCatalog.SUPA_SYNC_FINAL_RECONCILE_FAILED).toBeDefined();
    expect(diagnosticCatalog.SUPA_SYNC_MULTI_TARGET_APPLY_UNSUPPORTED).toBeDefined();
    expect(diagnosticCatalog.SUPA_SYNC_REMOTE_APPROVAL_REQUIRED).toBeDefined();
    expect(diagnosticCatalog.SUPA_SYNC_RUNNER_FAILED).toBeDefined();
    expect(diagnosticCatalog.SUPA_SYNC_RUNNER_UNAVAILABLE).toBeDefined();
    expect(diagnosticCatalog.SUPA_SYNC_SUPABASE_CLI_CONCURRENT_COMPANION).toBeDefined();
    expect(diagnosticCatalog.SUPA_SYNC_TARGET_OVERRIDE_MULTI).toBeDefined();
    expect(diagnosticCatalog.SUPA_SYNC_TARGET_UNKNOWN).toBeDefined();
    expect(diagnosticCatalog.SUPA_SYNC_TARGET_URL_UNRESOLVED).toBeDefined();
    expect(diagnosticCatalog.SUPA_SYNC_VERIFY_URL_UNRESOLVED).toBeDefined();
    expect(diagnosticCatalog.SUPA_DIFF_LINEAGE_GAP).toBeDefined();
  });
});

describe("sync pipeline orchestration", () => {
  it("resolves local URL fallback for configured Supabase CLI targets", async () => {
    const previous = process.env.SUPASCHEMA_DATABASE_URL;
    process.env.SUPASCHEMA_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
    try {
      const resolved = resolveSyncTargets(
        {
          directory: await mkdtemp(join(tmpdir(), "supa-sync-local-cli-url-")),
          operation: "apply",
          pipeline: true,
          skipDiff: true,
          target: "local",
        },
        resolveConfig({
          sync: {
            targets: {
              local: {
                historyTable: "supabase_migrations.schema_migrations",
                mode: "manual",
                runner: "supabase-cli",
              },
            },
          },
        })
      );

      expect(resolved.diagnostics).toEqual([]);
      expect(resolved.targets[0]?.databaseUrl).toBe(process.env.SUPASCHEMA_DATABASE_URL);
    } finally {
      if (previous === undefined) {
        delete process.env.SUPASCHEMA_DATABASE_URL;
      } else {
        process.env.SUPASCHEMA_DATABASE_URL = previous;
      }
    }
  });

  it("requires runtime approval before automatic remote deploy", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-remote-approval-"));
    const result = await syncMigrations({
      config: {
        sync: {
          targets: {
            remote: {
              databaseUrl: "postgresql://postgres:postgres@example.test/postgres",
              historyTable: "supabase_migrations.schema_migrations",
              mode: "auto",
              remote: true,
              requireApprovalEnv: "SUPASCHEMA_REMOTE_SYNC_APPROVED",
              runner: "direct",
            },
          },
        },
        workflow: {
          rls_safety: "disabled",
          type_safety: "disabled",
        },
      },
      directory: root,
      pipeline: true,
      skipDiff: true,
    });

    expect(result.applied).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "SUPA_SYNC_REMOTE_APPROVAL_REQUIRED"
    );
    expect(result.report).toContain("target resolution failed");
  });

  it("selects automatic targets from target mode rather than target name", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-target-mode-"));
    const result = await syncMigrations({
      config: {
        sources: { from: "empty:" },
        sync: {
          targets: {
            local: {
              databaseUrl: "$SUPASCHEMA_MISSING_LOCAL_URL",
              historyTable: "supabase_migrations.schema_migrations",
              mode: "manual",
              runner: "direct",
            },
            preview: {
              databaseUrl: "$SUPASCHEMA_MISSING_PREVIEW_URL",
              historyTable: "supabase_migrations.schema_migrations",
              mode: "auto",
              runner: "direct",
            },
          },
        },
        workflow: {
          rls_safety: "disabled",
          type_safety: "disabled",
        },
      },
      directory: root,
      pipeline: true,
      skipDiff: true,
      to: "empty:",
    });

    const messages = result.diagnostics.map((item) => item.message).join("\n");
    expect(result.applied).toBe(false);
    expect(messages).toContain("SUPASCHEMA_MISSING_PREVIEW_URL");
    expect(messages).not.toContain("SUPASCHEMA_MISSING_LOCAL_URL");
  });

  it("fails an explicit Supabase CLI target when its URL cannot be resolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-cli-url-"));
    const result = await syncMigrations({
      config: {
        sync: {
          targets: {
            remote: {
              databaseUrl: "$SUPASCHEMA_MISSING_CLI_TARGET_URL",
              historyTable: "supabase_migrations.schema_migrations",
              mode: "manual",
              remote: true,
              runner: "supabase-cli",
            },
          },
        },
        workflow: {
          rls_safety: "disabled",
          type_safety: "disabled",
        },
      },
      directory: root,
      pipeline: true,
      skipDiff: true,
      target: "remote",
    });

    expect(result.applied).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "SUPA_SYNC_TARGET_URL_UNRESOLVED"
    );
    expect(result.report).toContain("target resolution failed");
  });

  it("refuses --env override when multiple targets are selected", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-env-multi-"));
    const result = await syncMigrations({
      config: {
        environments: {
          primary: { databaseUrl: "$DATABASE_URL" },
        },
        sync: {
          targets: {
            local: {
              environment: "primary",
              historyTable: "supabase_migrations.schema_migrations",
              mode: "auto",
              runner: "direct",
            },
            remote: {
              environment: "primary",
              historyTable: "supabase_migrations.schema_migrations",
              mode: "auto",
              runner: "direct",
            },
          },
        },
        workflow: {
          rls_safety: "disabled",
          type_safety: "disabled",
        },
      },
      directory: root,
      envName: "primary",
      pipeline: true,
      skipDiff: true,
    });

    expect(result.applied).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "SUPA_SYNC_TARGET_OVERRIDE_MULTI"
    );
  });

  it("refuses multiple selected targets before any target runner can mutate", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-target-multi-"));
    const result = await syncMigrations({
      config: {
        sources: { from: "empty:" },
        sync: {
          targets: {
            local: {
              historyTable: "supabase_migrations.schema_migrations",
              mode: "auto",
              runner: "supabase-cli",
            },
            preview: {
              historyTable: "supabase_migrations.schema_migrations",
              mode: "auto",
              runner: "supabase-cli",
            },
          },
        },
        workflow: {
          rls_safety: "disabled",
          type_safety: "disabled",
        },
      },
      directory: root,
      pipeline: true,
      skipDiff: true,
      to: "empty:",
    });

    expect(result.applied).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "SUPA_SYNC_MULTI_TARGET_APPLY_UNSUPPORTED"
    );
    expect(result.report).toContain("target resolution failed");
    expect(result.report).not.toContain("running:");
  });

  it("blocks before runner selection when type safety fails", async () => {
    const before = await sqlSource("CREATE TABLE public.users (id bigint, email text);\n");
    const after = await sqlSource("CREATE TABLE public.users (id bigint);\n");
    const root = await mkdtemp(join(tmpdir(), "supa-sync-type-gate-"));
    await writeFile(
      join(root, "20260101000000_safe.sql"),
      "CREATE TABLE IF NOT EXISTS public.users (id bigint PRIMARY KEY);\n"
    );

    const result = await syncMigrations({
      config: {
        sources: { from: before },
        workflow: {
          migration_sync: "manual",
          rls_safety: "disabled",
          type_safety: "deploy_blocking",
        },
      },
      directory: root,
      pipeline: true,
      skipDiff: true,
      to: after,
    });

    expect(result.applied).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("SUPA_TYPE_COLUMN_REMOVED");
    expect(result.report).toContain("deploy safety gates failed");
  });

  it("blocks before runner selection when RLS safety fails", async () => {
    const source = await sqlSource(`
CREATE TABLE public.users (id bigint PRIMARY KEY);
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
`);
    const root = await mkdtemp(join(tmpdir(), "supa-sync-rls-gate-"));
    await writeFile(
      join(root, "20260101000000_safe.sql"),
      "CREATE TABLE IF NOT EXISTS public.users (id bigint PRIMARY KEY);\n"
    );

    const result = await syncMigrations({
      config: {
        workflow: {
          migration_sync: "manual",
          rls_safety: "deploy_blocking",
          type_safety: "disabled",
        },
      },
      directory: root,
      pipeline: true,
      skipDiff: true,
      to: source,
    });

    expect(result.applied).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain("SUPA_RULE_RLS_NO_POLICY");
    expect(result.report).toContain("deploy safety gates failed");
  });

  it("generates migration SQL and refreshes TypeScript and Zod outputs during sync", async () => {
    const source = await sqlSource("CREATE TABLE public.accounts (id bigint PRIMARY KEY);\n");
    const root = await mkdtemp(join(tmpdir(), "supa-sync-diff-"));
    const typesFile = join(root, "database.types.ts");
    const zodFile = join(root, "database.zod.ts");
    const migrationsDir = join(root, "migrations");

    const result = await syncMigrations({
      config: {
        sources: { from: "empty:" },
        typesFile,
        workflow: {
          migration_sync: "manual",
          rls_safety: "disabled",
          type_safety: "disabled",
        },
        zodFile,
      },
      directory: migrationsDir,
      pipeline: true,
      to: source,
    });

    expect(result.applied).toBe(false);
    expect(result.report).toContain("diff: wrote");
    expect(result.report).toContain("checked:");
    expect(result.report).toContain("types: wrote");
    expect(result.report).toContain(
      "stage: skipped (no schema closure paths are inside the git worktree)"
    );
    expect(result.report).toContain("dry run: no sync target was selected by config");
    expect(result.report).not.toContain("verify:");
    expect(await pathExists(typesFile)).toBe(true);
    expect(await pathExists(zodFile)).toBe(true);
    expect(result.pending.some((file) => file.endsWith(".sql"))).toBe(true);
  });

  it("stages the sync closure in a git worktree", { timeout: gitFixtureTimeoutMs }, async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-stage-"));
    const schemaDir = join(root, "database", "schemas");
    const migrationsDir = join(root, "database", "migrations");
    const typesFile = join(root, "database.types.ts");
    const zodFile = join(root, "database.zod.ts");
    await mkdir(schemaDir, { recursive: true });
    await mkdir(migrationsDir, { recursive: true });
    await writeFile(
      join(schemaDir, "app.sql"),
      "CREATE TABLE public.manual_stage (id bigint PRIMARY KEY);\nCREATE TABLE public.sync_stage (id bigint PRIMARY KEY);\n"
    );
    await writeFile(join(root, "README.md"), "unrelated\n");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const result = await syncMigrations({
        config: {
          schemaPaths: ["database/schemas"],
          sources: { from: "empty:" },
          typesFile,
          workflow: {
            migration_sync: "manual",
            rls_safety: "disabled",
            type_safety: "disabled",
          },
          zodFile,
        },
        directory: migrationsDir,
        pipeline: true,
        to: "dir:database/schemas",
      });

      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: root,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(result.applied).toBe(false);
      expect(result.diagnostics.filter((item) => item.severity === "error")).toEqual([]);
      expect(result.report).toContain("stage: staged");
      expect(result.report).toContain("dry run: no sync target was selected by config");
      expect(result.report).not.toContain("verify:");
      expect(staged).toContain("database/schemas/app.sql");
      expect(staged).toContain("database.types.ts");
      expect(staged).toContain("database.zod.ts");
      expect(staged.filter((file) => file.startsWith("database/migrations/"))).toHaveLength(1);
      expect(staged.some((file) => file.endsWith(".sql"))).toBe(true);
      expect(staged).not.toContain("README.md");
    } finally {
      process.chdir(previousCwd);
    }
  });

  it(
    "continues from a staged schema closure without requiring a commit",
    { timeout: gitFixtureTimeoutMs },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "supa-sync-staged-baseline-"));
      const schemaDir = join(root, "database", "schemas");
      const migrationsDir = join(root, "database", "migrations");
      const schemaFile = join(schemaDir, "app.sql");
      await mkdir(schemaDir, { recursive: true });
      await mkdir(migrationsDir, { recursive: true });
      await writeFile(schemaFile, "CREATE TABLE public.accounts (id bigint PRIMARY KEY);\n");
      execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
      execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Supaschema Test",
          "-c",
          "user.email=test@supaschema.local",
          "commit",
          "-m",
          "initial schema",
        ],
        { cwd: root, stdio: "ignore" }
      );
      const config = resolveConfig({
        migrationsDir: "database/migrations",
        schemaPaths: ["database/schemas"],
        sources: { from: "auto" },
        sync: { targets: {} },
        workflow: {
          migration_sync: "manual",
          rls_safety: "disabled",
          type_generation: "disabled",
          type_safety: "disabled",
          zod_generation: "disabled",
        },
      });
      const previousCwd = process.cwd();
      process.chdir(root);
      try {
        await writeFile(
          schemaFile,
          "CREATE TABLE public.accounts (id bigint PRIMARY KEY, name text);\n"
        );
        const first = await syncMigrations({ config, directory: migrationsDir, pipeline: true });
        expect(first.diagnostics.some((item) => item.severity === "error")).toBe(false);
        const firstFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql"));
        expect(firstFiles).toHaveLength(1);
        const indexedAfterFirst = execFileSync("git", ["show", ":database/schemas/app.sql"], {
          cwd: root,
          encoding: "utf8",
        });
        expect(indexedAfterFirst).toContain("name text");

        await writeFile(
          schemaFile,
          "CREATE TABLE public.accounts (id bigint PRIMARY KEY, name text, email text);\n"
        );
        const resolved = await resolveGenerationSourceDefaults(
          { cwd: root, migrationsDir },
          resolveConfig(config)
        );
        expect(resolved.from).toBe("git:INDEX");
        const driftResolved = await resolveGenerationSourceDefaults(
          { cwd: root, migrationsDir, mode: "drift" },
          resolveConfig(config)
        );
        expect(driftResolved.from).toBe("git:HEAD");
        const second = await syncMigrations({ config, directory: migrationsDir, pipeline: true });
        expect(second.diagnostics.map((item) => item.code)).not.toContain(
          "SUPA_MIGRATION_BASELINE_MISMATCH"
        );
        expect(second.diagnostics.some((item) => item.severity === "error")).toBe(false);
        const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();
        expect(files).toHaveLength(2);
        const firstLineage = parseLineage(
          await readFile(join(migrationsDir, files[0] ?? ""), "utf8")
        );
        const secondLineage = parseLineage(
          await readFile(join(migrationsDir, files[1] ?? ""), "utf8")
        );
        expect(secondLineage?.from).toBe(firstLineage?.to);
        expect(
          execFileSync("git", ["show", ":database/schemas/app.sql"], {
            cwd: root,
            encoding: "utf8",
          })
        ).toContain("email text");
      } finally {
        process.chdir(previousCwd);
      }
    },
    15_000
  );

  it("resolves configured targets before generating artifacts", async () => {
    const source = await sqlSource(
      "CREATE TABLE public.target_resolution_report (id bigint PRIMARY KEY);\n"
    );
    const root = await mkdtemp(join(tmpdir(), "supa-sync-target-report-"));
    const typesFile = join(root, "database.types.ts");
    const zodFile = join(root, "database.zod.ts");

    const result = await syncMigrations({
      config: {
        sources: { from: "empty:" },
        sync: {
          targets: {
            local: {
              databaseUrl: "$SUPASCHEMA_MISSING_TARGET_REPORT_URL",
              historyTable: "supabase_migrations.schema_migrations",
              mode: "auto",
              runner: "direct",
            },
          },
        },
        typesFile,
        workflow: {
          migration_sync: "auto",
          rls_safety: "disabled",
          type_safety: "disabled",
        },
        zodFile,
      },
      directory: join(root, "migrations"),
      pipeline: true,
      to: source,
    });

    expect(result.applied).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "SUPA_SYNC_TARGET_URL_UNRESOLVED"
    );
    expect(result.report).toContain("refusing to sync: target resolution failed");
    expect(result.report).not.toContain("diff: wrote");
    expect(result.report).not.toContain("dry run:");
  });

  it("resolves auto sources before sync reports the generated dry-run", async () => {
    const source = await sqlSource(
      "CREATE TABLE public.auto_sync_source (id bigint PRIMARY KEY);\n"
    );
    const cwd = await mkdtemp(join(tmpdir(), "supa-sync-auto-source-cwd-"));
    const migrationsDir = join(cwd, "migrations");
    const typesFile = join(cwd, "database.types.ts");
    const zodFile = join(cwd, "database.zod.ts");
    const previousCwd = process.cwd();
    const previousDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
    delete process.env.SUPASCHEMA_DATABASE_URL;
    process.chdir(cwd);
    try {
      const result = await syncMigrations({
        config: {
          sources: { from: "auto" },
          typesFile,
          workflow: {
            migration_sync: "manual",
            rls_safety: "disabled",
            type_safety: "disabled",
          },
          zodFile,
        },
        directory: migrationsDir,
        pipeline: true,
        to: source,
      });

      expect(result.applied).toBe(false);
      expect(result.report).toContain("diff: wrote");
      expect(result.report).toContain("dry run: no sync target was selected by config");
      expect(result.report).not.toContain("verify:");
    } finally {
      process.chdir(previousCwd);
      if (previousDatabaseUrl === undefined) {
        delete process.env.SUPASCHEMA_DATABASE_URL;
      } else {
        process.env.SUPASCHEMA_DATABASE_URL = previousDatabaseUrl;
      }
    }
  });

  it("runs the migration baseline gate before writing outputs", async () => {
    const source = await sqlSource("CREATE TABLE public.accounts (id bigint PRIMARY KEY);\n");
    const root = await mkdtemp(join(tmpdir(), "supa-sync-lineage-before-outputs-"));
    const typesFile = join(root, "database.types.ts");
    const zodFile = join(root, "database.zod.ts");
    const migrationsDir = join(root, "migrations");
    await mkdir(migrationsDir);
    await writeFile(
      join(migrationsDir, "20260101000000_existing.sql"),
      `-- supaschema: lineage format=${MODEL_FORMAT_VERSION} from=unrelated_from to=unrelated_to\nSELECT 1;\n`
    );

    const result = await syncMigrations({
      config: {
        sources: { from: "empty:" },
        typesFile,
        workflow: {
          migration_sync: "manual",
          rls_safety: "disabled",
          type_safety: "disabled",
        },
        zodFile,
      },
      directory: migrationsDir,
      pipeline: true,
      to: source,
    });

    expect(result.applied).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).toContain(
      "SUPA_MIGRATION_BASELINE_MISMATCH"
    );
    expect(await pathExists(typesFile)).toBe(false);
    expect(await pathExists(zodFile)).toBe(false);
  });

  it("reports no-op configured targets without marking migrations applied", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-noop-target-"));
    const previousDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
    delete process.env.SUPASCHEMA_DATABASE_URL;

    try {
      const result = await syncMigrations({
        config: {
          sources: { from: "empty:" },
          sync: {
            targets: {
              local: {
                historyTable: "supabase_migrations.schema_migrations",
                mode: "manual",
                runner: "supabase-cli",
              },
            },
          },
          workflow: {
            rls_safety: "disabled",
            type_safety: "disabled",
          },
        },
        directory: root,
        pipeline: true,
        skipDiff: true,
        target: "local",
        to: "empty:",
      });

      expect(result.applied).toBe(false);
      expect(result.report).toContain("nothing to sync on local");
    } finally {
      if (previousDatabaseUrl === undefined) {
        delete process.env.SUPASCHEMA_DATABASE_URL;
      } else {
        process.env.SUPASCHEMA_DATABASE_URL = previousDatabaseUrl;
      }
    }
  });

  it("refreshes generated contracts even when no migration is pending", {
    timeout: gitFixtureTimeoutMs,
  }, async () => {
    const source = await sqlSource("CREATE TABLE public.noop_contracts (id bigint PRIMARY KEY);\n");
    const root = await mkdtemp(join(tmpdir(), "supa-sync-noop-contracts-"));
    const migrationsDir = "migrations";
    const typesFile = "database.types.ts";
    const zodFile = "database.zod.ts";
    await mkdir(join(root, migrationsDir));
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const result = await syncMigrations({
        config: {
          sources: { from: "empty:" },
          typesFile,
          workflow: {
            migration_sync: "manual",
            rls_safety: "disabled",
            type_safety: "disabled",
          },
          zodFile,
        },
        directory: migrationsDir,
        pipeline: true,
        skipDiff: true,
        to: source,
      });
      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: root,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);

      expect(result.applied).toBe(false);
      expect(result.report).toContain("types: wrote");
      expect(result.report).toContain("stage: staged database.types.ts");
      expect(result.report).toContain("stage: staged database.zod.ts");
      expect(result.report).toContain("nothing to sync");
      expect(staged).toEqual(["database.types.ts", "database.zod.ts"]);
      expect(await pathExists(join(root, typesFile))).toBe(true);
      expect(await pathExists(join(root, zodFile))).toBe(true);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("does not pass an ambient database URL override to bare configured-target sync", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-cli-target-url-"));
    let fallbackResolved = false;
    const program = reportProgram({
      cliVersion: "test",
      configPath: () => undefined,
      globalEnvName: () => undefined,
      loadCliConfig: () =>
        Promise.resolve(
          resolveConfig({
            sources: { from: "empty:" },
            sync: {
              targets: {
                local: {
                  historyTable: "supabase_migrations.schema_migrations",
                  mode: "auto",
                  runner: "supabase-cli",
                },
              },
            },
            workflow: {
              migration_sync: "auto",
              rls_safety: "disabled",
              type_safety: "disabled",
            },
          })
        ),
      printDiagnostics: (_diagnostics: Diagnostic[]) => undefined,
      resolveCliDatabaseUrl: () => {
        fallbackResolved = true;
        return Promise.resolve("postgresql://ambient.example/postgres");
      },
    });

    const previousExitCode = process.exitCode;
    const write = process.stdout.write;
    const silenceStdout: typeof process.stdout.write = () => true;
    process.stdout.write = silenceStdout;
    try {
      await program.parseAsync([
        "node",
        "supaschema",
        "sync",
        "--to",
        "empty:",
        "--no-diff",
        "--migrations-dir",
        root,
      ]);
    } finally {
      process.stdout.write = write;
      process.exitCode = previousExitCode;
    }

    expect(fallbackResolved).toBe(false);
  });

  it("runs apply as a no-diff pending migration lane", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-apply-cli-"));
    await writeFile(
      join(root, "20260101000000_safe.sql"),
      "CREATE TABLE IF NOT EXISTS app.apply_cli (id bigint PRIMARY KEY);\n"
    );
    let fallbackResolved = false;
    const program = reportProgram({
      cliVersion: "test",
      configPath: () => undefined,
      globalEnvName: () => undefined,
      loadCliConfig: () =>
        Promise.resolve(
          resolveConfig({
            workflow: {
              migration_sync: "manual",
              rls_safety: "disabled",
              type_safety: "disabled",
            },
          })
        ),
      printDiagnostics: (_diagnostics: Diagnostic[]) => undefined,
      resolveCliDatabaseUrl: () => {
        fallbackResolved = true;
        return Promise.resolve(undefined);
      },
    });

    const previousExitCode = process.exitCode;
    const output = await captureStdout(async () => {
      try {
        await program.parseAsync(["node", "supaschema", "apply", "--migrations-dir", root]);
      } finally {
        process.exitCode = previousExitCode;
      }
    });

    expect(fallbackResolved).toBe(false);
    expect(output).toContain("dry run: no apply target was selected by config");
    expect(output).toContain("20260101000000_safe.sql");
    expect(output).not.toContain("diff: wrote");
  });

  it("stages only changed generated migration files", {
    timeout: gitFixtureTimeoutMs,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-stage-cli-"));
    const migrationsDir = join(root, "database", "migrations");
    await mkdir(migrationsDir, { recursive: true });
    await writeFile(
      join(migrationsDir, "20260101000000_generated.sql"),
      "-- supaschema: lineage from=before to=after\nCREATE TABLE IF NOT EXISTS app.generated (id bigint PRIMARY KEY);\n"
    );
    await writeFile(
      join(migrationsDir, "20260101000001_manual.sql"),
      "CREATE TABLE IF NOT EXISTS app.manual (id bigint PRIMARY KEY);\n"
    );
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const previousCwd = process.cwd();
    const previousExitCode = process.exitCode;
    process.chdir(root);
    try {
      const dryRunProgram = reportProgram({
        cliVersion: "test",
        configPath: () => undefined,
        globalEnvName: () => undefined,
        loadCliConfig: () =>
          Promise.resolve(resolveConfig({ migrationsDir: "database/migrations" })),
        printDiagnostics: (_diagnostics: Diagnostic[]) => undefined,
        resolveCliDatabaseUrl: () => Promise.resolve(undefined),
      });
      const dryRunOutput = await captureStdout(async () => {
        await dryRunProgram.parseAsync(["node", "supaschema", "stage", "--dry-run"]);
      });
      expect(dryRunOutput).toContain(
        "would ensure staged: database/migrations/20260101000000_generated.sql"
      );
      expect(dryRunOutput).not.toContain("20260101000001_manual.sql");

      const stageProgram = reportProgram({
        cliVersion: "test",
        configPath: () => undefined,
        globalEnvName: () => undefined,
        loadCliConfig: () =>
          Promise.resolve(resolveConfig({ migrationsDir: "database/migrations" })),
        printDiagnostics: (_diagnostics: Diagnostic[]) => undefined,
        resolveCliDatabaseUrl: () => Promise.resolve(undefined),
      });
      await captureStdout(async () => {
        await stageProgram.parseAsync(["node", "supaschema", "stage"]);
      });
      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: root,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);
      expect(staged).toEqual(["database/migrations/20260101000000_generated.sql"]);
    } finally {
      process.chdir(previousCwd);
      process.exitCode = previousExitCode;
    }
  });

  it("stages generated migration companions from a subdirectory", {
    timeout: gitFixtureTimeoutMs,
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-stage-subdir-"));
    const migrationsDir = join(root, "database", "migrations");
    await mkdir(migrationsDir, { recursive: true });
    await writeFile(
      join(migrationsDir, "20260101000000_generated.sql"),
      "-- supaschema: lineage from=before to=after\nCREATE TABLE IF NOT EXISTS app.generated (id bigint PRIMARY KEY);\n"
    );
    await writeFile(
      join(migrationsDir, "20260101000000_generated.concurrent.sql"),
      "CREATE INDEX CONCURRENTLY IF NOT EXISTS generated_id_idx ON app.generated (id);\n"
    );
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const previousCwd = process.cwd();
    process.chdir(join(root, "database"));
    try {
      const result = await stageGeneratedMigrations({ directory: "migrations" });
      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], {
        cwd: root,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);

      expect(result.staged).toEqual([
        "database/migrations/20260101000000_generated.sql",
        "database/migrations/20260101000000_generated.concurrent.sql",
      ]);
      expect(
        [...staged].sort((left, right) => Number(left > right) - Number(left < right))
      ).toEqual(
        [...result.staged].sort((left, right) => Number(left > right) - Number(left < right))
      );
    } finally {
      process.chdir(previousCwd);
    }
  });

  it.skipIf(process.platform === "win32")(
    "does not block hand-authored concurrent history before URL-less Supabase CLI targets",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "supa-sync-cli-history-concurrent-"));
      const binDir = await mkdtemp(join(tmpdir(), "supa-sync-cli-history-concurrent-bin-"));
      await writeFile(join(binDir, "supabase"), "#!/bin/sh\nexit 0\n");
      await chmod(join(binDir, "supabase"), 0o755);
      await writeFile(
        join(root, "20260101000000_history.concurrent.sql"),
        "CREATE INDEX CONCURRENTLY IF NOT EXISTS items_id_idx ON app.items (id);\n"
      );
      const oldPath = process.env.PATH;
      const oldDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
      const previousCwd = process.cwd();
      process.env.PATH = `${binDir}:${oldPath ?? ""}`;
      delete process.env.SUPASCHEMA_DATABASE_URL;
      process.chdir(root);
      try {
        const result = await syncMigrations({
          config: {
            sources: { from: "empty:" },
            sync: {
              targets: {
                local: {
                  historyTable: "supabase_migrations.schema_migrations",
                  mode: "manual",
                  runner: "supabase-cli",
                },
              },
            },
            transactionMode: "per-statement",
            workflow: {
              rls_safety: "disabled",
              type_safety: "disabled",
            },
          },
          directory: root,
          pipeline: true,
          skipDiff: true,
          target: "local",
          to: "empty:",
        });

        expect(result.applied).toBe(true);
        expect(result.diagnostics.map((item) => item.code)).not.toContain(
          "SUPA_SYNC_SUPABASE_CLI_CONCURRENT_COMPANION"
        );
      } finally {
        process.chdir(previousCwd);
        process.env.PATH = oldPath;
        if (oldDatabaseUrl === undefined) {
          delete process.env.SUPASCHEMA_DATABASE_URL;
        } else {
          process.env.SUPASCHEMA_DATABASE_URL = oldDatabaseUrl;
        }
      }
    }
  );

  it("refuses Supabase CLI targets with generated concurrent companion migrations", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-sync-cli-concurrent-"));
    await writeFile(
      join(root, "20260101000000_concurrent.sql"),
      "-- supaschema: lineage from=before to=after\nCREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE IF NOT EXISTS app.items (id bigint PRIMARY KEY);\n"
    );
    await writeFile(
      join(root, "20260101000000_concurrent.concurrent.sql"),
      "-- supaschema: lineage from=before to=after\nCREATE INDEX CONCURRENTLY IF NOT EXISTS items_id_idx ON app.items (id);\n"
    );
    const oldDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
    delete process.env.SUPASCHEMA_DATABASE_URL;

    try {
      const result = await syncMigrations({
        config: {
          sources: { from: "empty:" },
          sync: {
            targets: {
              local: {
                historyTable: "supabase_migrations.schema_migrations",
                mode: "manual",
                runner: "supabase-cli",
              },
            },
          },
          transactionMode: "per-statement",
          workflow: {
            rls_safety: "disabled",
            type_safety: "disabled",
          },
        },
        directory: root,
        pipeline: true,
        skipDiff: true,
        target: "local",
        to: "empty:",
      });

      expect(result.applied).toBe(false);
      expect(result.diagnostics.map((item) => item.code)).toContain(
        "SUPA_SYNC_SUPABASE_CLI_CONCURRENT_COMPANION"
      );
      expect(result.report).toContain("Supabase CLI cannot safely apply");
    } finally {
      if (oldDatabaseUrl === undefined) {
        delete process.env.SUPASCHEMA_DATABASE_URL;
      } else {
        process.env.SUPASCHEMA_DATABASE_URL = oldDatabaseUrl;
      }
    }
  });

  it("checks pending migrations before dry-run deploy safety gates", async () => {
    const before = await sqlSource("CREATE TABLE public.users (id bigint, email text);\n");
    const after = await sqlSource("CREATE TABLE public.users (id bigint);\n");
    const root = await mkdtemp(join(tmpdir(), "supa-sync-check-before-type-gate-"));
    await writeFile(
      join(root, "20260101000000_unsafe.sql"),
      "-- supaschema: lineage from=before to=after\nDROP TABLE public.users;\n"
    );

    const result = await syncMigrations({
      config: {
        sources: { from: before },
        workflow: {
          migration_sync: "manual",
          rls_safety: "disabled",
          type_safety: "deploy_blocking",
        },
      },
      directory: root,
      pipeline: true,
      skipDiff: true,
      to: after,
    });

    expect(result.applied).toBe(false);
    expect(result.diagnostics.map((item) => item.code)).not.toContain("SUPA_TYPE_COLUMN_REMOVED");
    expect(result.report).toContain("fails the replay-safety check");
  });
});

async function sqlSource(sql: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "supa-sync-source-"));
  await writeFile(join(root, "001.sql"), sql);
  return `dir:${root}`;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function requiredDatabaseUrl(): string {
  if (databaseUrl === undefined) {
    throw new Error("SUPASCHEMA_TEST_DATABASE_URL is required for this test");
  }
  return databaseUrl;
}

describe.skipIf(!databaseUrl)("sync (against a target)", () => {
  test("auto-applies the configured local direct target with the default workflow", async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const db = `supa_sync_auto_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(requiredDatabaseUrl());
    url.pathname = `/${db}`;
    try {
      const root = await mkdtemp(join(tmpdir(), "supa-sync-auto-"));
      await writeFile(
        join(root, "20260101000000_one.sql"),
        "CREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE IF NOT EXISTS app.auto_sync (id bigint PRIMARY KEY);\n"
      );
      const targetSource = await sqlSource(
        "CREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE app.auto_sync (id bigint PRIMARY KEY);\n"
      );

      const result = await syncMigrations({
        config: {
          sources: { from: "empty:" },
          sync: {
            targets: {
              local: {
                databaseUrl: url.toString(),
                historyTable: "supabase_migrations.schema_migrations",
                mode: "auto",
                runner: "direct",
              },
            },
          },
          workflow: {
            rls_safety: "disabled",
            type_safety: "disabled",
          },
        },
        directory: root,
        pipeline: true,
        skipDiff: true,
        to: targetSource,
      });

      expect(result.applied).toBe(true);
      expect(result.report).toContain("migrations [local / direct]");
      expect(result.report).toContain("running: direct");
      const target = new Client({ connectionString: url.toString() });
      await target.connect();
      const table = await target.query<{ name: string | null }>(
        "select to_regclass('app.auto_sync')::text as name"
      );
      await target.end();
      expect(table.rows[0]?.name).toBe("app.auto_sync");
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test("generates and applies a second edit after an applied predecessor", {
    timeout: 30_000,
  }, async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const db = `supa_sync_applied_predecessor_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(requiredDatabaseUrl());
    url.pathname = `/${db}`;
    const root = await mkdtemp(join(tmpdir(), "supa-sync-applied-predecessor-"));
    const schemaDir = join(root, "database", "schemas");
    const migrationsDir = join(root, "database", "migrations");
    const schemaFile = join(schemaDir, "app.sql");
    await mkdir(schemaDir, { recursive: true });
    await mkdir(migrationsDir, { recursive: true });
    await writeFile(schemaFile, "CREATE TABLE public.accounts (id bigint PRIMARY KEY);\n");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    const config = resolveConfig({
      migrationsDir: "database/migrations",
      schemaPaths: ["database/schemas"],
      sources: { from: "auto" },
      sync: {
        targets: {
          local: {
            databaseUrl: url.toString(),
            historyTable: "supabase_migrations.schema_migrations",
            mode: "auto",
            runner: "direct",
          },
        },
      },
      workflow: {
        migration_sync: "auto",
        rls_safety: "disabled",
        type_generation: "disabled",
        type_safety: "disabled",
        zod_generation: "disabled",
      },
    });
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const first = await syncMigrations({ config, directory: migrationsDir, pipeline: true });
      const firstFiles = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql"));

      expect(first.applied).toBe(true);
      expect(first.diagnostics.some((item) => item.severity === "error")).toBe(false);
      expect(firstFiles).toHaveLength(1);

      await writeFile(
        schemaFile,
        "CREATE TABLE public.accounts (id bigint PRIMARY KEY, email text);\n"
      );
      const second = await syncMigrations({ config, directory: migrationsDir, pipeline: true });
      const files = (await readdir(migrationsDir)).filter((file) => file.endsWith(".sql")).sort();

      expect(second.applied).toBe(true);
      expect(second.diagnostics.some((item) => item.severity === "error")).toBe(false);
      expect(files).toHaveLength(2);
      const firstLineage = parseLineage(
        await readFile(join(migrationsDir, files[0] ?? ""), "utf8")
      );
      const secondLineage = parseLineage(
        await readFile(join(migrationsDir, files[1] ?? ""), "utf8")
      );
      expect(secondLineage?.from).toBe(firstLineage?.to);

      const target = new Client({ connectionString: url.toString() });
      await target.connect();
      const columns = await target.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name = 'accounts' order by ordinal_position"
      );
      const history = await target.query<{ version: string }>(
        "select version from supabase_migrations.schema_migrations order by version"
      );
      await target.end();
      expect(columns.rows.map((row) => row.column_name)).toEqual(["id", "email"]);
      expect(history.rows.map((row) => row.version)).toHaveLength(2);
    } finally {
      process.chdir(previousCwd);
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test("auto-deploys an approved remote direct target", async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const db = `supa_sync_remote_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(requiredDatabaseUrl());
    url.pathname = `/${db}`;
    const previousApproval = process.env.SUPASCHEMA_REMOTE_SYNC_APPROVED;
    const previousDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
    process.env.SUPASCHEMA_REMOTE_SYNC_APPROVED = "1";
    process.env.SUPASCHEMA_DATABASE_URL = requiredDatabaseUrl();
    try {
      const root = await mkdtemp(join(tmpdir(), "supa-sync-remote-"));
      await writeFile(
        join(root, "20260101000000_one.sql"),
        "CREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE IF NOT EXISTS app.remote_sync (id bigint PRIMARY KEY);\n"
      );
      const targetSource = await sqlSource(
        "CREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE app.remote_sync (id bigint PRIMARY KEY);\n"
      );

      const result = await syncMigrations({
        config: {
          sources: { from: "empty:" },
          sync: {
            targets: {
              remote: {
                databaseUrl: url.toString(),
                historyTable: "supabase_migrations.schema_migrations",
                mode: "auto",
                remote: true,
                requireApprovalEnv: "SUPASCHEMA_REMOTE_SYNC_APPROVED",
                runner: "direct",
              },
            },
          },
          workflow: {
            migration_sync: "auto",
            rls_safety: "disabled",
            type_safety: "disabled",
          },
        },
        directory: root,
        pipeline: true,
        skipDiff: true,
        to: targetSource,
      });

      expect(result.applied).toBe(true);
      expect(result.report).toContain("migrations [remote / direct]");
      expect(result.report).toContain("running: direct");
      const target = new Client({ connectionString: url.toString() });
      await target.connect();
      const table = await target.query<{ name: string | null }>(
        "select to_regclass('app.remote_sync')::text as name"
      );
      const history = await target.query<{ version: string }>(
        "select version from supabase_migrations.schema_migrations"
      );
      await target.end();
      expect(table.rows[0]?.name).toBe("app.remote_sync");
      expect(history.rows.map((row) => row.version)).toEqual(["20260101000000"]);
    } finally {
      if (previousApproval === undefined) {
        delete process.env.SUPASCHEMA_REMOTE_SYNC_APPROVED;
      } else {
        process.env.SUPASCHEMA_REMOTE_SYNC_APPROVED = previousApproval;
      }
      if (previousDatabaseUrl === undefined) {
        delete process.env.SUPASCHEMA_DATABASE_URL;
      } else {
        process.env.SUPASCHEMA_DATABASE_URL = previousDatabaseUrl;
      }
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test("refuses an approved remote target without a separate verify database", async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const db = `supa_sync_remote_verify_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(requiredDatabaseUrl());
    url.pathname = `/${db}`;
    const previousApproval = process.env.SUPASCHEMA_REMOTE_SYNC_APPROVED;
    const previousDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
    const previousCwd = process.cwd();
    process.env.SUPASCHEMA_REMOTE_SYNC_APPROVED = "1";
    delete process.env.SUPASCHEMA_DATABASE_URL;
    try {
      const root = await mkdtemp(join(tmpdir(), "supa-sync-remote-verify-"));
      process.chdir(root);
      await writeFile(
        join(root, "20260101000000_one.sql"),
        "CREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE IF NOT EXISTS app.remote_verify (id bigint PRIMARY KEY);\n"
      );
      const targetSource = await sqlSource(
        "CREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE app.remote_verify (id bigint PRIMARY KEY);\n"
      );

      const result = await syncMigrations({
        config: {
          sources: { from: "empty:" },
          sync: {
            targets: {
              remote: {
                databaseUrl: url.toString(),
                historyTable: "supabase_migrations.schema_migrations",
                mode: "auto",
                remote: true,
                requireApprovalEnv: "SUPASCHEMA_REMOTE_SYNC_APPROVED",
                runner: "direct",
              },
            },
          },
          workflow: {
            migration_sync: "auto",
            rls_safety: "disabled",
            type_safety: "disabled",
          },
        },
        directory: root,
        pipeline: true,
        skipDiff: true,
        to: targetSource,
      });

      expect(result.applied).toBe(false);
      expect(result.diagnostics.map((item) => item.code)).toContain(
        "SUPA_SYNC_VERIFY_URL_UNRESOLVED"
      );
      expect(result.report).toContain("refusing to sync: verify has no database URL");
      expect(result.report).not.toContain("running: direct");
    } finally {
      process.chdir(previousCwd);
      if (previousApproval === undefined) {
        delete process.env.SUPASCHEMA_REMOTE_SYNC_APPROVED;
      } else {
        process.env.SUPASCHEMA_REMOTE_SYNC_APPROVED = previousApproval;
      }
      if (previousDatabaseUrl === undefined) {
        delete process.env.SUPASCHEMA_DATABASE_URL;
      } else {
        process.env.SUPASCHEMA_DATABASE_URL = previousDatabaseUrl;
      }
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test("runs verify before applying an approved remote target", async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const db = `supa_apply_remote_verify_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(requiredDatabaseUrl());
    url.pathname = `/${db}`;
    const previousApproval = process.env.SUPASCHEMA_REMOTE_SYNC_APPROVED;
    const previousDatabaseUrl = process.env.SUPASCHEMA_DATABASE_URL;
    const previousCwd = process.cwd();
    process.env.SUPASCHEMA_REMOTE_SYNC_APPROVED = "1";
    delete process.env.SUPASCHEMA_DATABASE_URL;
    try {
      const root = await mkdtemp(join(tmpdir(), "supa-apply-remote-verify-"));
      process.chdir(root);
      await writeFile(
        join(root, "20260101000000_one.sql"),
        "CREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE IF NOT EXISTS app.remote_apply_verify (id bigint PRIMARY KEY);\n"
      );
      const targetSource = await sqlSource(
        "CREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE app.remote_apply_verify (id bigint PRIMARY KEY);\n"
      );

      const result = await syncMigrations({
        config: {
          sources: { from: "empty:" },
          sync: {
            targets: {
              remote: {
                databaseUrl: url.toString(),
                historyTable: "supabase_migrations.schema_migrations",
                mode: "manual",
                remote: true,
                requireApprovalEnv: "SUPASCHEMA_REMOTE_SYNC_APPROVED",
                runner: "direct",
              },
            },
          },
          workflow: {
            migration_sync: "auto",
            rls_safety: "disabled",
            type_safety: "disabled",
          },
        },
        directory: root,
        operation: "apply",
        pipeline: true,
        skipDiff: true,
        target: "remote",
        to: targetSource,
      });

      expect(result.applied).toBe(false);
      expect(result.diagnostics.map((item) => item.code)).toContain(
        "SUPA_SYNC_VERIFY_URL_UNRESOLVED"
      );
      expect(result.report).toContain("refusing to apply: verify has no database URL");
      expect(result.report).not.toContain("running: direct");
    } finally {
      process.chdir(previousCwd);
      if (previousApproval === undefined) {
        delete process.env.SUPASCHEMA_REMOTE_SYNC_APPROVED;
      } else {
        process.env.SUPASCHEMA_REMOTE_SYNC_APPROVED = previousApproval;
      }
      if (previousDatabaseUrl === undefined) {
        delete process.env.SUPASCHEMA_DATABASE_URL;
      } else {
        process.env.SUPASCHEMA_DATABASE_URL = previousDatabaseUrl;
      }
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test("applies pending files with the direct PostgreSQL runner", async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const db = `supa_sync_direct_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(requiredDatabaseUrl());
    url.pathname = `/${db}`;
    try {
      const root = await mkdtemp(join(tmpdir(), "supa-sync-direct-"));
      await writeFile(
        join(root, "20260101000000_one.sql"),
        "CREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE IF NOT EXISTS app.direct_sync (id bigint PRIMARY KEY);\n"
      );
      const targetSource = await sqlSource(
        "CREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE app.direct_sync (id bigint PRIMARY KEY);\n"
      );

      const result = await syncMigrations({
        config: {
          sources: { from: "empty:" },
          sync: {
            targets: {
              local: {
                databaseUrl: url.toString(),
                historyTable: "supabase_migrations.schema_migrations",
                mode: "manual",
                runner: "direct",
              },
            },
          },
          workflow: { rls_safety: "disabled", type_safety: "disabled" },
        },
        directory: root,
        pipeline: true,
        skipDiff: true,
        target: "local",
        to: targetSource,
      });

      expect(result.applied).toBe(true);
      expect(result.diagnostics.some((item) => item.severity === "error")).toBe(false);
      expect(result.report).toContain("verify: 1 pending migration file(s) passed");
      expect(result.report).toContain("running: direct");
      const target = new Client({ connectionString: url.toString() });
      await target.connect();
      const table = await target.query<{ name: string | null }>(
        "select to_regclass('app.direct_sync')::text as name"
      );
      const history = await target.query<{ version: string }>(
        "select version from supabase_migrations.schema_migrations"
      );
      await target.end();
      expect(table.rows[0]?.name).toBe("app.direct_sync");
      expect(history.rows.map((row) => row.version)).toEqual(["20260101000000"]);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test("applies target pending files from the selected target history", async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const db = `supa_sync_target_verify_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(requiredDatabaseUrl());
    url.pathname = `/${db}`;
    try {
      const target = new Client({ connectionString: url.toString() });
      await target.connect();
      await target.query("CREATE SCHEMA app");
      await target.query("CREATE TABLE app.account (id bigint PRIMARY KEY)");
      await target.query("CREATE SCHEMA supabase_migrations");
      await target.query(
        "CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY)"
      );
      await target.query(
        "INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20260101000000')"
      );
      await target.end();
      const root = await mkdtemp(join(tmpdir(), "supa-sync-target-verify-"));
      await writeFile(
        join(root, "20260101000000_initial.sql"),
        "CREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE IF NOT EXISTS app.account (id bigint PRIMARY KEY);\n"
      );
      await writeFile(
        join(root, "20260102000000_add_email.sql"),
        "ALTER TABLE app.account ADD COLUMN IF NOT EXISTS email text;\n"
      );
      const targetSource = await sqlSource(
        "CREATE SCHEMA IF NOT EXISTS app;\nCREATE TABLE app.account (id bigint PRIMARY KEY, email text);\n"
      );

      const result = await syncMigrations({
        config: {
          sources: { from: "empty:" },
          sync: {
            targets: {
              local: {
                databaseUrl: url.toString(),
                historyTable: "supabase_migrations.schema_migrations",
                mode: "manual",
                runner: "direct",
              },
            },
          },
          workflow: { rls_safety: "disabled", type_safety: "disabled" },
        },
        directory: root,
        pipeline: true,
        skipDiff: true,
        target: "local",
        to: targetSource,
      });

      expect(result.applied).toBe(true);
      expect(result.diagnostics.some((item) => item.severity === "error")).toBe(false);
      expect(result.report).toContain("verify: 1 pending migration file(s) passed");
      expect(result.report).toContain("running: direct");
      const verified = new Client({ connectionString: url.toString() });
      await verified.connect();
      const column = await verified.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'app' and table_name = 'account' and column_name = 'email'"
      );
      await verified.end();
      expect(column.rows.map((row) => row.column_name)).toEqual(["email"]);
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test("applies pending chains without collapsing per-file transaction boundaries", async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const db = `supa_sync_verify_chain_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(requiredDatabaseUrl());
    url.pathname = `/${db}`;
    try {
      const root = await mkdtemp(join(tmpdir(), "supa-sync-verify-chain-"));
      await writeFile(
        join(root, "20260101000000_type.sql"),
        [
          "CREATE SCHEMA IF NOT EXISTS app;",
          "DO $$",
          "BEGIN",
          "  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'app' AND t.typname = 'sync_status') THEN",
          "    CREATE TYPE app.sync_status AS ENUM ('new');",
          "  END IF;",
          "END $$;",
          "",
        ].join("\n")
      );
      await writeFile(
        join(root, "20260102000000_enum_value.sql"),
        "ALTER TYPE app.sync_status ADD VALUE IF NOT EXISTS 'done';\n"
      );
      await writeFile(
        join(root, "20260103000000_table.sql"),
        "CREATE TABLE IF NOT EXISTS app.enum_use (id bigint PRIMARY KEY, status app.sync_status NOT NULL DEFAULT 'done'::app.sync_status);\n"
      );
      const targetSource = await sqlSource(
        "CREATE SCHEMA IF NOT EXISTS app;\nCREATE TYPE app.sync_status AS ENUM ('new', 'done');\nCREATE TABLE app.enum_use (id bigint PRIMARY KEY, status app.sync_status NOT NULL DEFAULT 'done'::app.sync_status);\n"
      );

      const result = await syncMigrations({
        config: {
          sources: { from: "empty:" },
          sync: {
            targets: {
              local: {
                databaseUrl: url.toString(),
                historyTable: "supabase_migrations.schema_migrations",
                mode: "manual",
                runner: "direct",
              },
            },
          },
          workflow: { rls_safety: "disabled", type_safety: "disabled" },
        },
        directory: root,
        pipeline: true,
        skipDiff: true,
        target: "local",
        to: targetSource,
      });

      expect(result.applied).toBe(true);
      expect(result.diagnostics.some((item) => item.severity === "error")).toBe(false);
      expect(result.report).toContain("running: direct");
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test("refuses on ghost history", async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const db = `supa_sync_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(requiredDatabaseUrl());
    url.pathname = `/${db}`;
    try {
      const target = new Client({ connectionString: url.toString() });
      await target.connect();
      await target.query("CREATE SCHEMA supabase_migrations");
      await target.query(
        "CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY)"
      );
      await target.query(
        "INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20250101000000')"
      );
      await target.end();
      const root = await mkdtemp(join(tmpdir(), "supa-sync-ghost-"));
      await writeFile(
        join(root, "20260101000000_one.sql"),
        "CREATE TABLE IF NOT EXISTS app.t (id bigint PRIMARY KEY);\n"
      );

      const result = await syncMigrations({
        config: {
          sources: { from: "empty:" },
          sync: {
            targets: {
              local: {
                databaseUrl: url.toString(),
                historyTable: "supabase_migrations.schema_migrations",
                mode: "manual",
                runner: "direct",
              },
            },
          },
          workflow: { rls_safety: "disabled", type_safety: "disabled" },
        },
        directory: root,
        pipeline: true,
        skipDiff: true,
        target: "local",
        to: "empty:",
      });

      expect(result.applied).toBe(false);
      expect(result.report).toContain("ghost or out-of-order");
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test("runs deploy type safety from the selected target catalog", async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const db = `supa_sync_type_catalog_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(requiredDatabaseUrl());
    url.pathname = `/${db}`;
    try {
      const target = new Client({ connectionString: url.toString() });
      await target.connect();
      await target.query("CREATE TABLE public.users (id bigint, email text)");
      await target.end();
      const root = await mkdtemp(join(tmpdir(), "supa-sync-type-catalog-"));
      await writeFile(join(root, "20260101000000_noop.sql"), "SELECT 1;\n");
      const after = await sqlSource("CREATE TABLE public.users (id bigint);\n");

      const result = await syncMigrations({
        config: {
          sources: { from: "empty:" },
          sync: {
            targets: {
              local: {
                databaseUrl: url.toString(),
                historyTable: "supabase_migrations.schema_migrations",
                mode: "manual",
                runner: "direct",
              },
            },
          },
          workflow: {
            rls_safety: "disabled",
            type_safety: "deploy_blocking",
          },
        },
        directory: root,
        pipeline: true,
        skipDiff: true,
        target: "local",
        to: after,
      });

      expect(result.applied).toBe(false);
      expect(result.diagnostics.map((item) => item.code)).toContain("SUPA_TYPE_COLUMN_REMOVED");
      expect(result.report).toContain("checked: 20260101000000_noop.sql (replay-safe)");
      expect(result.report).toContain("refusing to sync local: deploy safety gates failed");
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });
});
