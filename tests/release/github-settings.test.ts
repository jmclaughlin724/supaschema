import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = resolve("scripts/github/audit-settings.mts");
const policy = JSON.parse(readFileSync(resolve(".github/repo-policy.json"), "utf8"));
const repo = policy.repositoryFullName;

function runAudit(options: { approved?: boolean; apply?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "supa-github-audit-"));
  const log = join(dir, "gh.log");
  const result = spawnSync(
    process.execPath,
    [script, ...(options.apply === true ? ["--apply-topics"] : [])],
    {
      cwd: resolve("."),
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_REPOSITORY_TOPICS_APPROVED: options.approved === true ? "1" : undefined,
        SUPASCHEMA_FAKE_GH_LOG: log,
        SUPASCHEMA_FAKE_GH_POLICY: JSON.stringify(policy),
      },
    }
  );
  const calls = readCalls(log);
  return { calls, result };
}

function readCalls(file: string): unknown[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

describe("GitHub settings audit", () => {
  it("refuses topic apply without approval", () => {
    const { calls, result } = runAudit({ apply: true });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--apply-topics requires GITHUB_REPOSITORY_TOPICS_APPROVED=1");
    expect(calls).toEqual([]);
  });

  it("replaces topics after explicit approval", () => {
    const { calls, result } = runAudit({ apply: true, approved: true });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("GITHUB_SETTINGS_APPLY_OK");
    expect(calls).toEqual([
      {
        body: { names: policy.repositoryTopics },
        endpoint: `repos/${repo}/topics`,
        method: "PUT",
      },
    ]);
  });
});
