import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ endCalls: 0 }));

vi.mock("pg", () => {
  function FakeClient() {
    return {
      connect: (): Promise<void> => Promise.resolve(),
      end: (): Promise<void> => {
        state.endCalls += 1;
        return Promise.resolve();
      },
      query: (text: unknown): Promise<{ rows: { can_create: boolean }[] }> => {
        if (typeof text === "string" && text.includes("can_create")) {
          return Promise.resolve({ rows: [{ can_create: false }] });
        }
        return Promise.resolve({ rows: [] });
      },
    };
  }
  return { Client: FakeClient, default: { Client: FakeClient } };
});

const { verifyMigration } = await import("../../src/verify/migration.js");

describe("verify admin client lifecycle (plan 004)", () => {
  beforeEach(() => {
    state.endCalls = 0;
  });

  it("ends the admin client exactly once on the capability-preflight failure path", async () => {
    const dir = await mkdtemp(join(tmpdir(), "supa-verify-end-"));
    const migrationPath = join(dir, "m.sql");
    await writeFile(migrationPath, "CREATE TABLE IF NOT EXISTS app.t (id bigint PRIMARY KEY);\n");
    const emptyFrom = await mkdtemp(join(tmpdir(), "supa-verify-from-"));
    const emptyTo = await mkdtemp(join(tmpdir(), "supa-verify-to-"));

    const diagnostics = await verifyMigration({
      config: { managedSchemas: [], validators: ["internal-parser"] },
      databaseUrl: "postgresql://localhost:5432/postgres",
      from: `dir:${emptyFrom}`,
      migrationPath,
      to: `dir:${emptyTo}`,
    });

    expect(diagnostics.map((item) => item.code)).toContain("SUPA_VERIFY_ROLE_CAPABILITY");

    expect(state.endCalls).toBe(1);
  });
});
