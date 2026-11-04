#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arrayOf, at, recordOf, stringsOf } from "../../lib/json.mts";
import { assert, ok } from "../lib/assertions.mts";
import { exists, ROOT, readJson } from "../lib/repository.mts";

const deletedGithubWorkflowFiles = [
  "scripts/github/merge.mjs",
  "scripts/github/merge-preflight.mjs",
  "scripts/github/post-merge-verify.mjs",
  "scripts/github/pr-preflight.mjs",
];

const deletedGithubWorkflowScripts = [
  "github:merge",
  "github:merge-preflight",
  "github:post-merge-verify",
  "github:pr-preflight",
];

function assertProtectedMainPolicy(policy: unknown): void {
  const main = at(policy, "branches", "main");
  assert(main, "repo policy must define branches.main");
  assert(at(main, "required_linear_history") === true, "main must require linear history");
  assert(
    at(main, "required_conversation_resolution") === true,
    "main must require conversation resolution"
  );
  assert(at(main, "required_signatures") === false, "required signatures must stay disabled");
  assert(at(main, "enforce_admins") === true, "main branch protection must apply to admins");
  assert(at(main, "allow_force_pushes") === false, "main must block force pushes");
  assert(at(main, "allow_deletions") === false, "main must block deletions");
  assert(at(main, "direct_pushes") === false, "main policy must reject direct pushes");
  assert(
    !("required_pull_request_reviews" in recordOf(main)),
    "classic main protection must not duplicate ruleset reviews"
  );
  assert(
    !("required_status_checks" in recordOf(main)),
    "classic main protection must not duplicate ruleset checks"
  );

  const mainRuleset = arrayOf(at(policy, "rulesets")).find(
    (ruleset) => at(ruleset, "name") === "main branch policy"
  );
  assert(mainRuleset, "repo policy must define the main branch policy ruleset");
  assert(at(mainRuleset, "target") === "branch", "main branch policy ruleset must target branches");
  assert(at(mainRuleset, "enforcement") === "active", "main branch policy ruleset must be active");
  const bypassActors = at(mainRuleset, "bypass_actors");
  const mainRules = arrayOf(at(mainRuleset, "rules"));
  assert(
    stringsOf(at(mainRuleset, "conditions", "ref_name", "include")).includes("~DEFAULT_BRANCH"),
    "main branch policy ruleset must target the default branch"
  );
  assert(
    Array.isArray(bypassActors) && bypassActors.length === 0,
    "main branch policy ruleset must not define bypass actors"
  );
  for (const type of [
    "deletion",
    "non_fast_forward",
    "required_linear_history",
    "pull_request",
    "required_status_checks",
  ]) {
    assert(
      mainRules.some((rule) => at(rule, "type") === type),
      `main branch policy ruleset must include ${type}`
    );
  }
  const pullRequestRule = mainRules.find((rule) => at(rule, "type") === "pull_request");
  assert(
    JSON.stringify(at(pullRequestRule, "parameters", "allowed_merge_methods")) ===
      JSON.stringify(["squash"]) &&
      at(pullRequestRule, "parameters", "required_approving_review_count") === 0,
    "main pull-request rule must require GitHub squash PRs without an unsatisfiable solo-review gate"
  );
  const requiredChecksRule = mainRules.find(
    (rule) => at(rule, "type") === "required_status_checks"
  );
  const requiredContexts = arrayOf(
    at(requiredChecksRule, "parameters", "required_status_checks")
  ).map((check) => at(check, "context"));
  assert(
    JSON.stringify(requiredContexts) === JSON.stringify(["CI required", "dependency-review"]) &&
      at(requiredChecksRule, "parameters", "strict_required_status_checks_policy") === true,
    "main ruleset must require the stable CI and dependency-review checks against current main"
  );

  const releaseTagRuleset = arrayOf(at(policy, "rulesets")).find(
    (ruleset) => at(ruleset, "name") === "release tag policy"
  );
  assert(at(releaseTagRuleset, "target") === "tag", "release tag policy must target tags");
  assert(
    stringsOf(at(releaseTagRuleset, "conditions", "ref_name", "include")).includes("refs/tags/v*"),
    "release tag policy must target v* tags"
  );
  for (const type of ["deletion", "non_fast_forward"]) {
    assert(
      arrayOf(at(releaseTagRuleset, "rules")).some((rule) => at(rule, "type") === type),
      `release tag policy must include ${type}`
    );
  }

  const releaseEnvironment = at(policy, "environments", "release");
  assert(
    at(releaseEnvironment, "deployment_branch_policy", "custom_branch_policies") === true &&
      at(releaseEnvironment, "deployment_branch_policy", "protected_branches") === false,
    "release environment must use an explicit deployment branch policy"
  );
  assert(
    JSON.stringify(at(releaseEnvironment, "branch_policies")) ===
      JSON.stringify([{ name: "main", type: "branch" }]),
    "release environment must permit only main"
  );
}

export function check(root = ROOT): void {
  const policy = readJson(".github/repo-policy.json", root);
  const packageJson = readJson("package.json", root);

  assert(exists(".claude/rules/21-source-control.md", root), "Rule 21 must own source control");
  for (const file of [
    ".claude/rules/14-editing-worktree-git.md",
    ".claude/rules/21-github-process.md",
  ]) {
    assert(!exists(file, root), `${file} must not exist`);
  }

  for (const file of ["scripts/github/policy.mts", "scripts/github/audit-settings.mts"]) {
    assert(exists(file, root), `${file} must exist`);
  }
  for (const file of deletedGithubWorkflowFiles) {
    assert(!exists(file, root), `${file} must not exist`);
  }

  assert(
    at(packageJson, "scripts", "github:audit-settings") ===
      "node scripts/github/audit-settings.mts",
    "package.json#scripts.github:audit-settings must be node scripts/github/audit-settings.mts"
  );
  assert(
    at(packageJson, "scripts", "guard:github-process") ===
      "node scripts/guards/ci-release/check-github-process.mts",
    "package.json#scripts.guard:github-process must be node scripts/guards/ci-release/check-github-process.mts"
  );
  for (const script of deletedGithubWorkflowScripts) {
    assert(
      !(script in recordOf(at(packageJson, "scripts"))),
      `package.json#scripts.${script} must not exist`
    );
  }

  assert(
    arrayOf(at(policy, "upstreamSources")).length > 0,
    "repo policy must cite GitHub upstream sources"
  );

  assert(
    at(policy, "repositoryFullName") === "jmclaughlin724/supaschema",
    "repo policy must name this repository"
  );
  const expectedTopics = [
    "ai-coding-agents",
    "database-migrations",
    "declarative-schema",
    "drift-detection",
    "postgres",
    "postgres-migrations",
    "postgresql",
    "postgresql-migrations",
    "row-level-security",
    "schema-diff",
    "schema-management",
    "supabase",
    "supabase-migrations",
    "typescript-types",
    "zod",
  ];
  assert(
    JSON.stringify(at(policy, "repositoryTopics")) === JSON.stringify(expectedTopics),
    "repo policy topics must match the G41 distribution set"
  );
  for (const topic of expectedTopics) {
    assert(
      stringsOf(at(packageJson, "keywords")).includes(topic),
      `package keywords must include ${topic}`
    );
  }

  assert(at(policy, "repository", "default_branch") === "main", "default branch must be main");
  assert(
    at(policy, "repository", "allow_merge_commit") === false,
    "merge commits must be disabled"
  );
  assert(at(policy, "repository", "allow_squash_merge") === true, "squash merges must be enabled");
  assert(
    at(policy, "repository", "allow_rebase_merge") === false,
    "rebase merges must be disabled"
  );
  assert(
    at(policy, "repository", "delete_branch_on_merge") === true,
    "merged head branches must auto-delete"
  );
  assert(
    at(policy, "repository", "web_commit_signoff_required") === false,
    "web commit signoff must not be required"
  );
  assert(
    at(policy, "actions", "permissions", "sha_pinning_required") === true,
    "GitHub Actions must require full-length SHA-pinned actions"
  );
  assert(
    at(policy, "actions", "permissions", "allowed_actions") === "selected",
    "GitHub Actions must allow only selected action owners"
  );
  assert(
    at(policy, "actions", "selectedActions", "github_owned_allowed") === true &&
      at(policy, "actions", "selectedActions", "verified_allowed") === false,
    "selected Actions policy must allow GitHub-owned actions and deny the broad verified-creator set"
  );
  const requiredThirdPartyActions = [
    "astral-sh/setup-uv@*",
    "codecov/codecov-action@*",
    "ossf/scorecard-action@*",
    "oven-sh/setup-bun@*",
    "step-security/harden-runner@*",
  ];
  assert(
    JSON.stringify(at(policy, "actions", "selectedActions", "patterns_allowed")) ===
      JSON.stringify(requiredThirdPartyActions),
    "selected Actions policy must match the reviewed third-party action set"
  );
  assert(
    at(policy, "actions", "workflowPermissions", "default_workflow_permissions") === "read",
    "GitHub Actions default workflow token permissions must be read-only"
  );
  assert(
    at(policy, "actions", "workflowPermissions", "can_approve_pull_request_reviews") === false,
    "GitHub Actions must not create or approve pull request reviews"
  );
  assert(!("dco" in recordOf(policy)), "repo policy must not define DCO enforcement");
  assert(
    at(policy, "pullRequests", "mergeMethod") === "squash",
    "canonical PR merge method must be squash"
  );
  for (const key of [
    "optionalMergeWorkflow",
    "optionalPreflight",
    "optionalMergePreflight",
    "optionalPostMergeVerification",
    "mergeCliIsolation",
    "postMergeLocalSync",
  ]) {
    assert(!(key in recordOf(at(policy, "pullRequests"))), `pullRequests.${key} must not exist`);
  }

  assertProtectedMainPolicy(policy);

  assert(
    !(
      at(packageJson, "scripts", "github:check-dco") || exists("scripts/github/check-dco.mjs", root)
    ),
    "DCO checker must not be exposed as a repo blocker"
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  check();
  ok("GITHUB_PROCESS_GUARD_OK");
}
