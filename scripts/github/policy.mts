import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arrayOf, at, parseJson, stringAt } from "../lib/json.mts";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const POLICY_PATH = ".github/repo-policy.json";

interface RunOptions {
  allowFailure?: boolean;
  input?: string;
}

export function readPolicy(): unknown {
  return parseJson(fs.readFileSync(path.join(ROOT, POLICY_PATH), "utf8"));
}

export function argValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) {
    return;
  }
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function hasFlag(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

export function run(command: string, args: readonly string[], options: RunOptions = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0 && !options.allowFailure) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${output ? `:\n${output}` : ""}`);
  }
  return result;
}

export function git(args: readonly string[], options: RunOptions = {}): string {
  return run("git", args, options).stdout.trim();
}

export function ghJson(args: readonly string[], options: RunOptions = {}): unknown {
  const fakePolicy = process.env.SUPASCHEMA_FAKE_GH_POLICY;
  if (fakePolicy) {
    return fakeGhJson(parseJson(fakePolicy), args, options);
  }
  const result = run("gh", args, options);
  return parseJson(result.stdout);
}

function fakeGhJson(policy: unknown, args: readonly string[], options: RunOptions): unknown {
  const log = process.env.SUPASCHEMA_FAKE_GH_LOG;
  const endpoint = args[1];
  const repo = stringAt(policy, "repositoryFullName");
  const methodIndex = args.indexOf("-X");
  const method = methodIndex === -1 ? "GET" : args[methodIndex + 1];

  if (endpoint === `repos/${repo}`) {
    return at(policy, "repository");
  }
  if (endpoint === `repos/${repo}/topics` && method === "PUT") {
    const body = parseJson(options.input ?? "{}");
    if (log) {
      fs.appendFileSync(log, `${JSON.stringify({ body, endpoint, method })}\n`);
    }
    return { names: at(body, "names") };
  }
  if (endpoint === `repos/${repo}/topics`) {
    return {
      names:
        log && fs.existsSync(log) && fs.readFileSync(log, "utf8").includes('"method":"PUT"')
          ? at(policy, "repositoryTopics")
          : ["cli", "database", "idempotent-migrations", "migrations", "rls", "typescript"],
    };
  }
  if (endpoint === `repos/${repo}/actions/permissions`) {
    return at(policy, "actions", "permissions");
  }
  const settingsResponse = fakeSettingsResponse(endpoint, repo, policy);
  if (settingsResponse !== undefined) {
    return settingsResponse;
  }
  if (endpoint === `repos/${repo}/branches/main/protection`) {
    const main = at(policy, "branches", "main");
    const statusChecks = at(main, "required_status_checks");
    return {
      allow_deletions: { enabled: at(main, "allow_deletions") },
      allow_force_pushes: { enabled: at(main, "allow_force_pushes") },
      enforce_admins: { enabled: at(main, "enforce_admins") },
      required_conversation_resolution: { enabled: at(main, "required_conversation_resolution") },
      required_linear_history: { enabled: at(main, "required_linear_history") },
      required_pull_request_reviews: at(main, "required_pull_request_reviews") ?? null,
      required_signatures: { enabled: at(main, "required_signatures") },
      required_status_checks: statusChecks
        ? {
            checks: arrayOf(at(statusChecks, "contexts")).map((context) => ({
              app_id: at(statusChecks, "app_id"),
              context,
            })),
            contexts: at(statusChecks, "contexts"),
            strict: at(statusChecks, "strict"),
          }
        : null,
    };
  }
  const rulesets = arrayOf(at(policy, "rulesets"));
  if (endpoint === `repos/${repo}/rulesets`) {
    return rulesets.map((ruleset, index) => ({ id: index + 1, name: at(ruleset, "name") }));
  }
  const rulesetPrefix = `repos/${repo}/rulesets/`;
  if (endpoint.startsWith(rulesetPrefix)) {
    const index = Number(endpoint.slice(rulesetPrefix.length)) - 1;
    return rulesets[index];
  }
  throw new Error(`unhandled fake gh endpoint ${endpoint}`);
}

function fakeSettingsResponse(
  endpoint: string,
  repo: string | undefined,
  policy: unknown
): unknown {
  const responses = new Map<string, unknown>([
    [
      `repos/${repo}/actions/permissions/selected-actions`,
      at(policy, "actions", "selectedActions"),
    ],
    [`repos/${repo}/actions/permissions/workflow`, at(policy, "actions", "workflowPermissions")],
    [
      `repos/${repo}/actions/permissions/fork-pr-contributor-approval`,
      at(policy, "actions", "forkPullRequestContributorApproval"),
    ],
    [`repos/${repo}/environments/release`, at(policy, "environments", "release")],
    [
      `repos/${repo}/environments/release/deployment-branch-policies`,
      { branch_policies: at(policy, "environments", "release", "branch_policies") },
    ],
  ]);
  return responses.get(endpoint);
}

export function repoFullName(policy: unknown = readPolicy()): string {
  const policyRepo = stringAt(policy, "repositoryFullName");
  if (policyRepo) {
    return policyRepo;
  }

  const envRepo = process.env.GITHUB_REPOSITORY;
  if (envRepo?.includes("/")) {
    return envRepo;
  }

  const remote = git(["config", "--get", "remote.origin.url"]);
  const httpsPrefix = "https://github.com/";
  const sshPrefix = "git@github.com:";
  let value = remote;
  if (value.startsWith(httpsPrefix)) {
    value = value.slice(httpsPrefix.length);
  } else if (value.startsWith(sshPrefix)) {
    value = value.slice(sshPrefix.length);
  }
  if (value.endsWith(".git")) {
    value = value.slice(0, -4);
  }
  if (!value.includes("/")) {
    throw new Error(`cannot derive GitHub repository from origin URL: ${remote}`);
  }
  return value;
}

export function currentBranch(): string {
  return git(["branch", "--show-current"]);
}

export function defaultBase(policy: unknown = readPolicy()): string {
  return (
    stringAt(policy, "pullRequests", "base") ??
    stringAt(policy, "repository", "default_branch") ??
    "main"
  );
}

export function reportFailures(failures: readonly string[], okToken: string): void {
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`${okToken}\n`);
}

export function sorted(values: readonly string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b));
}

export function setDifference(left: readonly string[], right: readonly string[]): string[] {
  const rightSet = new Set(right);
  return sorted(left.filter((value) => !rightSet.has(value)));
}

export function asEnabled(value: unknown): unknown {
  if (value && typeof value === "object" && "enabled" in value) {
    return value.enabled;
  }
  return Boolean(value);
}

export function parsePrNumber(value: string | undefined): string | undefined {
  if (!value) {
    return;
  }
  const marker = "/pull/";
  if (value.includes(marker)) {
    const tail = value.slice(value.indexOf(marker) + marker.length);
    return tail.split("/")[0].split("#")[0].split("?")[0];
  }
  return value;
}

export function successfulCheck(item: unknown): boolean {
  const status = at(item, "status");
  const conclusion = at(item, "conclusion");
  if (status && status !== "COMPLETED") {
    return false;
  }
  return conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED";
}
