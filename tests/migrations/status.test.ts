import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it, test } from "vitest";
import { resolveDatabaseUrl } from "../../src/database/url.js";
import { lineageLine } from "../../src/migrations/lineage.js";
import {
  compareMigrationHistory,
  migrationFileVersions,
  migrationsStatus,
  renderMigrationsStatus,
} from "../../src/migrations/status.js";

const databaseUrl = process.env.SUPASCHEMA_TEST_DATABASE_URL ?? resolveDatabaseUrl();

async function migrationDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "supa-migrations-"));
  await writeFile(join(root, "20260101000000_one.sql"), "SELECT 1;\n");
  await writeFile(join(root, "20260102000000_two.sql"), "SELECT 2;\n");
  const lineage = lineageLine({
    fromFingerprint: "abc",
    toFingerprint: "def",
  });
  await writeFile(join(root, "20260104000000_generated.sql"), `${lineage}\nSELECT 4;\n`);
  await writeFile(join(root, "notes.txt"), "ignored\n");
  return root;
}

describe("migrations status (disk only)", () => {
  it("reports every file as pending with a no-target warning", async () => {
    const { diagnostics, report } = await migrationsStatus({ directory: await migrationDir() });

    expect(diagnostics.map((item) => item.code)).toContain("SUPA_MIGRATIONS_NO_TARGET");
    expect(report.files).toHaveLength(3);
    expect(report.pending).toHaveLength(3);
    expect(report.pendingLineage.map((item) => item.file)).toEqual([
      "20260104000000_generated.sql",
    ]);
  });

  it("carries target labels and expected versions for callers", async () => {
    const { report } = await migrationsStatus({
      directory: await migrationDir(),
      runnerLabel: "direct",
      targetLabel: "local",
    });

    expect(report.targetLabel).toBe("local");
    expect(report.runnerLabel).toBe("direct");
    expect(report.expectedAppliedVersions).toEqual([
      "20260101000000",
      "20260102000000",
      "20260104000000",
    ]);
    expect(report.missingExpectedVersions).toEqual(report.expectedAppliedVersions);
    expect(renderMigrationsStatus(report)).toContain("migrations [local / direct]:");
  });

  it("marks stale generated-lineage descendants as stale too", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-migrations-stale-chain-"));
    await writeFile(
      join(root, "20260101000000_first.sql"),
      `${lineageLine({ fromFingerprint: "head", toFingerprint: "stale" })}\nSELECT 1;\n`
    );
    await writeFile(
      join(root, "20260102000000_second.sql"),
      `${lineageLine({ fromFingerprint: "stale", toFingerprint: "tree" })}\nSELECT 2;\n`
    );

    const { diagnostics, report } = await migrationsStatus({
      currentFingerprints: { head: "head", tree: "tree" },
      directory: root,
    });

    expect(diagnostics.map((item) => item.code)).toContain("SUPA_MIGRATIONS_STALE_BASELINE");
    expect(report.staleBaseline).toEqual(["20260101000000_first.sql", "20260102000000_second.sql"]);
  });

  it("compares applied history against an expected final version set", () => {
    expect(
      compareMigrationHistory(
        ["20260101000000", "20260103000000"],
        ["20260101000000", "20260102000000"]
      )
    ).toEqual({
      expectedAppliedVersions: ["20260101000000", "20260102000000"],
      missingExpectedVersions: ["20260102000000"],
      unexpectedAppliedVersions: ["20260103000000"],
    });
    expect(
      migrationFileVersions(["20260102000000_two.sql", "notes.txt", "20260101000000_one.sql"])
    ).toEqual(["20260101000000", "20260102000000"]);
  });
});

describe.skipIf(!databaseUrl)("migrations status (against a target)", () => {
  test("classifies applied, pending, ghost, and out-of-order versions", {
    timeout: 30_000,
  }, async () => {
    const admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const db = `supa_migrations_${process.pid}_${Math.random().toString(16).slice(2, 8)}`;
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${db}`);
    const url = new URL(databaseUrl);
    url.pathname = `/${db}`;
    try {
      const target = new Client({ connectionString: url.toString() });
      await target.connect();
      await target.query("CREATE SCHEMA supabase_migrations");
      await target.query(
        "CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY)"
      );
      await target.query(
        "INSERT INTO supabase_migrations.schema_migrations (version) VALUES ('20260101000000'), ('20260103000000')"
      );
      await target.end();

      const directory = await migrationDir();
      await writeFile(
        join(directory, "20260101000000_one.sql"),
        `${lineageLine({ fromFingerprint: "before", toFingerprint: "applied" })}\nSELECT 1;\n`
      );
      const { diagnostics, report } = await migrationsStatus({
        databaseUrl: url.toString(),
        directory,
      });

      expect(report.applied).toEqual(["20260101000000_one.sql"]);
      expect(report.appliedLineage.map((item) => item.file)).toEqual(["20260101000000_one.sql"]);
      expect(report.pending).toEqual(["20260102000000_two.sql", "20260104000000_generated.sql"]);
      expect(report.pendingLineage.map((item) => item.file)).toEqual([
        "20260104000000_generated.sql",
      ]);
      expect(report.ghosts).toEqual(["20260103000000"]);
      expect(report.outOfOrder).toEqual(["20260102000000_two.sql"]);
      expect(report.missingExpectedVersions).toEqual(["20260102000000", "20260104000000"]);
      expect(report.unexpectedAppliedVersions).toEqual(["20260103000000"]);
      const codes = diagnostics.map((item) => item.code);
      expect(codes).toContain("SUPA_MIGRATIONS_GHOST_VERSIONS");
      expect(codes).toContain("SUPA_MIGRATIONS_OUT_OF_ORDER");
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
      await admin.end();
    }
  });

  test("reports a missing history table as an error", async () => {
    const { diagnostics } = await migrationsStatus({
      databaseUrl,
      directory: await migrationDir(),
      historyTable: "supabase_migrations.no_such_table",
    });

    expect(diagnostics.map((item) => item.code)).toContain("SUPA_MIGRATIONS_HISTORY_TABLE");
  });
});
