#!/usr/bin/env node
import { arrayOf, at, isRecord, recordOf, stringsOf } from "../lib/json.mts";
import {
  argValue,
  asEnabled,
  ghJson,
  hasFlag,
  readPolicy,
  repoFullName,
  reportFailures,
  setDifference,
  sorted,
} from "./policy.mts";

const args = process.argv.slice(2);
const policy = readPolicy();
const repo = argValue(args, "--repo") ?? repoFullName(policy);
const applyTopics = hasFlag(args, "--apply-topics");
const failures: string[] = [];
const topicFailures: string[] = [];

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareObject(actual: unknown, expected: unknown, path: string): void {
  for (const [key, expectedValue] of Object.entries(recordOf(expected))) {
    const actualValue = at(actual, key);
    if (actualValue !== expectedValue) {
      failures.push(
        `${path}.${key} expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`
      );
    }
  }
}

function normalizeRequiredStatusChecks(value: unknown) {
  return arrayOf(value)
    .map((check) => ({
      context: at(check, "context"),
      integration_id: at(check, "integration_id"),
    }))
    .sort((left, right) => String(left.context).localeCompare(String(right.context)));
}

function normalizeBypassActors(value: unknown) {
  return arrayOf(value)
    .map((actor) => ({
      actor_id: at(actor, "actor_id"),
      actor_type: at(actor, "actor_type"),
      bypass_mode: at(actor, "bypass_mode"),
    }))
    .sort((left, right) =>
      `${left.actor_type}:${left.actor_id}:${left.bypass_mode}`.localeCompare(
        `${right.actor_type}:${right.actor_id}:${right.bypass_mode}`
      )
    );
}

function normalizedParameterValue(ruleType: string, key: string, value: unknown): unknown {
  if (ruleType === "required_status_checks" && key === "required_status_checks") {
    return normalizeRequiredStatusChecks(value);
  }
  const strings = stringsOf(value);
  if (Array.isArray(value) && strings.length === value.length) {
    return sorted(strings);
  }
  return value;
}

const repoSettings = ghJson(["api", `repos/${repo}`]);
for (const [key, expected] of Object.entries(recordOf(at(policy, "repository")))) {
  const actual = at(repoSettings, key);
  if (actual !== expected) {
    failures.push(
      `repository.${key} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

const expectedTopics = sorted(stringsOf(at(policy, "repositoryTopics")));
if (expectedTopics.length > 0) {
  const actualTopics = sorted(stringsOf(at(ghJson(["api", `repos/${repo}/topics`]), "names")));
  for (const topic of setDifference(expectedTopics, actualTopics)) {
    topicFailures.push(`repositoryTopics missing required topic: ${topic}`);
  }
  for (const topic of setDifference(actualTopics, expectedTopics)) {
    topicFailures.push(`repositoryTopics has unowned topic: ${topic}`);
  }
}

const expectedActions = at(policy, "actions");
const expectedPermissions = at(expectedActions, "permissions");
if (expectedPermissions) {
  const actualPermissions = ghJson(["api", `repos/${repo}/actions/permissions`]);
  compareObject(actualPermissions, expectedPermissions, "actions.permissions");
}
const expectedSelectedActions = at(expectedActions, "selectedActions");
if (expectedSelectedActions) {
  const actualSelectedActions = ghJson([
    "api",
    `repos/${repo}/actions/permissions/selected-actions`,
  ]);
  compareObject(
    actualSelectedActions,
    {
      github_owned_allowed: at(expectedSelectedActions, "github_owned_allowed"),
      verified_allowed: at(expectedSelectedActions, "verified_allowed"),
    },
    "actions.selectedActions"
  );
  const expectedPatterns = sorted(stringsOf(at(expectedSelectedActions, "patterns_allowed")));
  const actualPatterns = sorted(stringsOf(at(actualSelectedActions, "patterns_allowed")));
  if (!sameJson(actualPatterns, expectedPatterns)) {
    failures.push(
      `actions.selectedActions.patterns_allowed expected ${JSON.stringify(expectedPatterns)}, got ${JSON.stringify(actualPatterns)}`
    );
  }
}
const expectedWorkflowPermissions = at(expectedActions, "workflowPermissions");
if (expectedWorkflowPermissions) {
  const actualWorkflowPermissions = ghJson(["api", `repos/${repo}/actions/permissions/workflow`]);
  compareObject(
    actualWorkflowPermissions,
    expectedWorkflowPermissions,
    "actions.workflowPermissions"
  );
}
const expectedForkApproval = at(expectedActions, "forkPullRequestContributorApproval");
if (expectedForkApproval) {
  const actualForkApproval = ghJson([
    "api",
    `repos/${repo}/actions/permissions/fork-pr-contributor-approval`,
  ]);
  compareObject(
    actualForkApproval,
    expectedForkApproval,
    "actions.forkPullRequestContributorApproval"
  );
}

for (const [environmentName, environmentPolicy] of Object.entries(
  recordOf(at(policy, "environments"))
)) {
  const environment = ghJson(["api", `repos/${repo}/environments/${environmentName}`]);
  compareObject(
    at(environment, "deployment_branch_policy"),
    at(environmentPolicy, "deployment_branch_policy"),
    `environments.${environmentName}.deployment_branch_policy`
  );
  const actualBranchPolicies = at(
    ghJson(["api", `repos/${repo}/environments/${environmentName}/deployment-branch-policies`]),
    "branch_policies"
  );
  const normalizeBranchPolicies = (value: unknown) =>
    arrayOf(value)
      .map((branchPolicy) => ({ name: at(branchPolicy, "name"), type: at(branchPolicy, "type") }))
      .sort((left, right) =>
        `${left.type}:${left.name}`.localeCompare(`${right.type}:${right.name}`)
      );
  const expectedBranchPolicies = normalizeBranchPolicies(at(environmentPolicy, "branch_policies"));
  const normalizedActualBranchPolicies = normalizeBranchPolicies(actualBranchPolicies);
  if (!sameJson(normalizedActualBranchPolicies, expectedBranchPolicies)) {
    failures.push(
      `environments.${environmentName}.branch_policies expected ${JSON.stringify(expectedBranchPolicies)}, got ${JSON.stringify(normalizedActualBranchPolicies)}`
    );
  }
}

for (const [branch, branchPolicy] of Object.entries(recordOf(at(policy, "branches")))) {
  const protection = ghJson(["api", `repos/${repo}/branches/${branch}/protection`]);

  for (const key of [
    "allow_deletions",
    "allow_force_pushes",
    "enforce_admins",
    "required_conversation_resolution",
    "required_linear_history",
    "required_signatures",
  ]) {
    const expected = at(branchPolicy, key);
    const actual = asEnabled(at(protection, key));
    if (actual !== expected) {
      failures.push(`branches.${branch}.${key} expected ${expected}, got ${actual}`);
    }
  }

  const actualReviews = at(protection, "required_pull_request_reviews");
  if (isRecord(branchPolicy) && "required_pull_request_reviews" in branchPolicy) {
    const expectedReviews = recordOf(branchPolicy.required_pull_request_reviews);
    for (const [key, expected] of Object.entries(expectedReviews)) {
      const actual = at(actualReviews, key);
      if (actual !== expected) {
        failures.push(
          `branches.${branch}.required_pull_request_reviews.${key} expected ${JSON.stringify(
            expected
          )}, got ${JSON.stringify(actual)}`
        );
      }
    }
  } else if (actualReviews) {
    failures.push(`branches.${branch}.required_pull_request_reviews has unowned requirement`);
  }

  const expectedStatus = at(branchPolicy, "required_status_checks");
  const actualStatus = at(protection, "required_status_checks");
  const expectedStrict = at(expectedStatus, "strict");
  const actualStrict = at(actualStatus, "strict");
  if (actualStrict !== expectedStrict) {
    failures.push(
      `branches.${branch}.required_status_checks.strict expected ${expectedStrict}, got ${actualStrict}`
    );
  }
  const expectedContexts = sorted(stringsOf(at(expectedStatus, "contexts")));
  const actualContexts = sorted(stringsOf(at(actualStatus, "contexts")));
  for (const context of setDifference(expectedContexts, actualContexts)) {
    failures.push(`branches.${branch}.required_status_checks missing required context: ${context}`);
  }
  for (const context of setDifference(actualContexts, expectedContexts)) {
    failures.push(`branches.${branch}.required_status_checks has unowned context: ${context}`);
  }
  const expectedAppId = at(expectedStatus, "app_id");
  if (expectedAppId !== undefined) {
    const actualChecksByContext = new Map(
      arrayOf(at(actualStatus, "checks")).map((check): [unknown, unknown] => [
        at(check, "context"),
        check,
      ])
    );
    for (const context of expectedContexts) {
      const check = actualChecksByContext.get(context);
      if (!check) {
        failures.push(
          `branches.${branch}.required_status_checks missing app-bound check: ${context}`
        );
        continue;
      }
      const actualAppId = at(check, "app_id");
      if (actualAppId !== expectedAppId) {
        failures.push(
          `branches.${branch}.required_status_checks.${context}.app_id expected ${expectedAppId}, got ${actualAppId}`
        );
      }
    }
  }
}

const liveRulesets = arrayOf(ghJson(["api", `repos/${repo}/rulesets`]));
for (const expectedRuleset of arrayOf(at(policy, "rulesets"))) {
  const expectedName = at(expectedRuleset, "name");
  const listed = liveRulesets.find((ruleset) => at(ruleset, "name") === expectedName);
  if (!listed) {
    failures.push(`rulesets missing required ruleset: ${expectedName}`);
    continue;
  }
  const actualRuleset = ghJson(["api", `repos/${repo}/rulesets/${at(listed, "id")}`]);
  compareObject(
    actualRuleset,
    {
      enforcement: at(expectedRuleset, "enforcement"),
      name: expectedName,
      target: at(expectedRuleset, "target"),
    },
    `rulesets.${expectedName}`
  );
  const expectedBypassActors = normalizeBypassActors(at(expectedRuleset, "bypass_actors"));
  const actualBypassActors = normalizeBypassActors(at(actualRuleset, "bypass_actors"));
  if (!sameJson(actualBypassActors, expectedBypassActors)) {
    failures.push(
      `rulesets.${expectedName}.bypass_actors expected ${JSON.stringify(expectedBypassActors)}, got ${JSON.stringify(actualBypassActors)}`
    );
  }

  const expectedInclude = sorted(
    stringsOf(at(expectedRuleset, "conditions", "ref_name", "include"))
  );
  const actualInclude = sorted(stringsOf(at(actualRuleset, "conditions", "ref_name", "include")));
  if (!sameJson(actualInclude, expectedInclude)) {
    failures.push(
      `rulesets.${expectedName}.conditions.ref_name.include expected ${JSON.stringify(expectedInclude)}, got ${JSON.stringify(actualInclude)}`
    );
  }
  const expectedExclude = sorted(
    stringsOf(at(expectedRuleset, "conditions", "ref_name", "exclude"))
  );
  const actualExclude = sorted(stringsOf(at(actualRuleset, "conditions", "ref_name", "exclude")));
  if (!sameJson(actualExclude, expectedExclude)) {
    failures.push(
      `rulesets.${expectedName}.conditions.ref_name.exclude expected ${JSON.stringify(expectedExclude)}, got ${JSON.stringify(actualExclude)}`
    );
  }

  const expectedByType = new Map(
    arrayOf(at(expectedRuleset, "rules")).map((rule): [string, unknown] => [
      String(at(rule, "type")),
      rule,
    ])
  );
  const actualByType = new Map(
    arrayOf(at(actualRuleset, "rules")).map((rule): [string, unknown] => [
      String(at(rule, "type")),
      rule,
    ])
  );
  for (const type of setDifference([...expectedByType.keys()], [...actualByType.keys()])) {
    failures.push(`rulesets.${expectedName}.rules missing required rule: ${type}`);
  }
  for (const type of setDifference([...actualByType.keys()], [...expectedByType.keys()])) {
    failures.push(`rulesets.${expectedName}.rules has unowned rule: ${type}`);
  }
  for (const [type, expectedRule] of expectedByType) {
    const actualRule = actualByType.get(type);
    if (!actualRule) {
      continue;
    }
    for (const [key, expectedValue] of Object.entries(recordOf(at(expectedRule, "parameters")))) {
      const actualValue = normalizedParameterValue(type, key, at(actualRule, "parameters", key));
      const normalizedExpected = normalizedParameterValue(type, key, expectedValue);
      if (!sameJson(actualValue, normalizedExpected)) {
        failures.push(
          `rulesets.${expectedName}.rules.${type}.parameters.${key} expected ${JSON.stringify(normalizedExpected)}, got ${JSON.stringify(actualValue)}`
        );
      }
    }
  }
}

if (applyTopics) {
  if (process.env.GITHUB_REPOSITORY_TOPICS_APPROVED !== "1") {
    failures.push("--apply-topics requires GITHUB_REPOSITORY_TOPICS_APPROVED=1");
  }
  if (failures.length > 0) {
    failures.push(...topicFailures);
  } else if (topicFailures.length > 0) {
    applyRepositoryTopics(repo, expectedTopics);
    const updatedTopics = sorted(stringsOf(at(ghJson(["api", `repos/${repo}/topics`]), "names")));
    for (const topic of setDifference(expectedTopics, updatedTopics)) {
      failures.push(`repositoryTopics missing required topic after apply: ${topic}`);
    }
    for (const topic of setDifference(updatedTopics, expectedTopics)) {
      failures.push(`repositoryTopics has unowned topic after apply: ${topic}`);
    }
  }
} else {
  failures.push(...topicFailures);
}

reportFailures(failures, applyTopics ? "GITHUB_SETTINGS_APPLY_OK" : "GITHUB_SETTINGS_AUDIT_OK");

function applyRepositoryTopics(targetRepo: string, topics: readonly string[]): void {
  ghJson(["api", `repos/${targetRepo}/topics`, "-X", "PUT", "--input", "-"], {
    input: JSON.stringify({ names: topics }),
  });
}
