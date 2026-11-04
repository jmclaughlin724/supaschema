import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { check } from "../../../scripts/guards/repo-surface/check-repo-layout.mts";
import { tempGuardRepo } from "../fixture.js";

function trackedRepo(files: Record<string, string>): string {
  const root = tempGuardRepo(files);
  execFileSync("git", ["add", ...Object.keys(files)], { cwd: root, stdio: "ignore" });
  return root;
}

function guardMessage(root: string): string {
  try {
    check(root);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "";
}

describe("repo layout guard", () => {
  it("flags dump and private directories", () => {
    const message = guardMessage(
      trackedRepo({
        "src/_private/f.ts": "export const f = 1;\n",
        "src/common/d.ts": "export const d = 1;\n",
        "src/helpers/c.ts": "export const c = 1;\n",
        "src/misc/e.ts": "export const e = 1;\n",
        "src/shared/a.ts": "export const a = 1;\n",
        "src/utils/b.ts": "export const b = 1;\n",
      })
    );
    expect(message).toContain("src/shared");
    expect(message).toContain("src/utils");
    expect(message).toContain("src/helpers");
    expect(message).toContain("src/common");
    expect(message).toContain("src/misc");
    expect(message).toContain("src/_private");
  });

  it("allows only the Supabase shared function directory exception", () => {
    const root = trackedRepo({
      "supabase/functions/_shared/index.ts": "export const shared = true;\n",
    });
    expect(() => check(root)).not.toThrow();
  });

  it("flags dump, payload, query, and repeated-context filenames", () => {
    const message = guardMessage(
      trackedRepo({
        "scripts/shared.mjs": "export const s = 1;\n",
        "src/dashboard/nested/dashboard-widget.ts": "export const d = 1;\n",
        "src/payload.test.ts": "export const p = 1;\n",
        "src/query-users.ts": "export const q = 1;\n",
        "src/tool-payload.mjs": "export const t = 1;\n",
      })
    );
    expect(message).toContain("scripts/shared.mjs");
    expect(message).toContain("src/payload.test.ts");
    expect(message).toContain("src/tool-payload.mjs");
    expect(message).toContain("src/query-users.ts");
    expect(message).toContain("src/dashboard/nested/dashboard-widget.ts");
  });

  it("allows neighboring concepts that do not repeat path ownership", {
    timeout: 20_000,
  }, () => {
    const root = trackedRepo({
      "docs/docs.json": "{}\n",
      "src/payloads.ts": "export const p = 1;\n",
      "src/user-query.ts": "export const q = 1;\n",
    });
    expect(() => check(root)).not.toThrow();
  });

  it("requires a populated sibling client boundary for root server directories", () => {
    expect(guardMessage(trackedRepo({ "src/server/index.ts": "export const s = 1;\n" }))).toContain(
      "src/server"
    );
  });

  it("requires a populated sibling client boundary for nested server directories", {
    timeout: 20_000,
  }, () => {
    expect(
      guardMessage(
        trackedRepo({
          "src/client/nested/index.ts": "export const c = 1;\n",
          "src/feature/server/index.ts": "export const s = 1;\n",
        })
      )
    ).toContain("src/feature/server");
  });

  it("allows a root server directory with a populated sibling client boundary", () => {
    const root = trackedRepo({
      "src/client/index.ts": "export const c = 1;\n",
      "src/server/index.ts": "export const s = 1;\n",
      "src/serverless/index.ts": "export const sl = 1;\n",
    });
    expect(() => check(root)).not.toThrow();
  });

  it("passes a clean owner-named layout", () => {
    const root = trackedRepo({
      "src/owner/named.ts": "export const n = 1;\n",
    });
    expect(() => check(root)).not.toThrow();
  });
});
