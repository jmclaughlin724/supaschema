#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { arrayOf, at, recordOf, stringAt, stringsOf } from "../../lib/json.mts";
import { assert, ok } from "../lib/assertions.mts";
import { ROOT, readJson } from "../lib/repository.mts";
import {
  asArray,
  eachStep,
  findNamedStep,
  isSha40,
  jobMatrix,
  permissionsAreReadOnly,
  stepActionName,
  stepIf,
  stepName,
  stepRun,
  stepRunBefore,
  workflowFiles,
} from "./ci-yaml-primitives.mts";

export interface ParsedWorkflow {
  doc: unknown;
  raw: string;
}

export type ParsedWorkflows = Map<string, ParsedWorkflow>;

const SHOULD_CREATE_GITHUB_RELEASE_IF =
  "steps.preflight.outputs.SUPASCHEMA_RELEASE_SHOULD_CREATE_GITHUB_RELEASE == 'true'";

function assertWorkflowBasics(
  parsed: ParsedWorkflows,
  allowedActionPatterns: ReadonlySet<string>
): void {
  for (const [file, { doc, raw }] of parsed) {
    assert(
      permissionsAreReadOnly(at(doc, "permissions")),
      `${file}: top-level permissions must be read-only (contents: read or read-all); jobs elevate per-need. Got ${JSON.stringify(at(doc, "permissions"))}`
    );

    assert(
      !(raw.includes("NODE_AUTH_TOKEN") || raw.includes("NPM_TOKEN")),
      `${file}: must not reference a stored npm token (NODE_AUTH_TOKEN/NPM_TOKEN); publishing is OIDC trusted publishing`
    );

    for (const { step } of eachStep(doc)) {
      const uses = at(step, "uses");
      if (typeof uses !== "string" || uses.startsWith("./")) {
        continue;
      }
      const separator = uses.lastIndexOf("@");
      assert(separator > 0, `${file}: \`uses: ${uses}\` is not pinned to a ref`);
      const ref = uses.slice(separator + 1);
      const action = uses.slice(0, separator);
      assert(
        isSha40(ref),
        `${file}: \`uses: ${uses}\` must pin a full 40-character commit SHA (got "${ref}")`
      );
      assert(
        action.startsWith("actions/") ||
          action.startsWith("github/") ||
          allowedActionPatterns.has(`${action}@*`),
        `${file}: third-party action ${action} must be allowlisted in .github/repo-policy.json selectedActions.patterns_allowed`
      );
      if (action === "actions/checkout") {
        assert(
          at(step, "with", "persist-credentials") === false,
          `${file}: actions/checkout must set with.persist-credentials: false`
        );
      }
    }
  }
}

const HARDEN_RUNNER_ENDPOINTS = [
  "*.actions.githubusercontent.com:443",
  "api.github.com:443",
  "fulcio.sigstore.dev:443",
  "github.com:443",
  "registry.npmjs.org:443",
  "rekor.sigstore.dev:443",
  "tuf-repo-cdn.sigstore.dev:443",
];

const GITHUB_PACKAGES_ENDPOINTS = ["npm.pkg.github.com:443"];

const RELEASE_ASSET_CDN_ENDPOINTS = [
  "objects.githubusercontent.com:443",
  "release-assets.githubusercontent.com:443",
];

function usesAction(step: unknown, prefix: string): boolean {
  return stringAt(step, "uses")?.startsWith(prefix) === true;
}

function assertHardenRunnerBaseline(
  jobLabel: string,
  job: unknown,
  extraEndpoints: readonly string[] = []
): void {
  const expectedEndpoints = [...HARDEN_RUNNER_ENDPOINTS, ...extraEndpoints];
  const hardenRunnerStep = arrayOf(at(job, "steps")).find((step) =>
    usesAction(step, "step-security/harden-runner")
  );
  assert(hardenRunnerStep, `${jobLabel} must run step-security/harden-runner`);
  const allowedEndpointsValue = String(
    at(hardenRunnerStep, "with", "allowed-endpoints") ?? ""
  ).trim();
  assert(
    !allowedEndpointsValue.includes("\n"),
    `${jobLabel} harden-runner endpoints must use a folded YAML scalar so the agent receives space-separated tokens`
  );
  const allowedEndpoints = allowedEndpointsValue
    .split(" ")
    .map((endpoint) => endpoint.trim())
    .filter(Boolean);
  assert(
    at(hardenRunnerStep, "with", "egress-policy") === "block" &&
      expectedEndpoints.length === allowedEndpoints.length &&
      expectedEndpoints.every((endpoint) => allowedEndpoints.includes(endpoint)),
    `${jobLabel} must enforce the reviewed egress endpoint allow-list`
  );
}

function assertReleaseConditionals(release: ParsedWorkflow, publishJob: unknown): void {
  assert(
    !release.raw.includes("env.SUPASCHEMA_RELEASE_SHOULD_"),
    "release.yml step conditionals must use preflight step outputs, not dynamic env context"
  );
  const prepareReleaseNotesStep = findNamedStep(
    arrayOf(at(publishJob, "steps")),
    "Prepare GitHub release notes"
  );
  const createGithubReleaseStep = findNamedStep(
    arrayOf(at(publishJob, "steps")),
    "Create GitHub release"
  );
  assert(
    prepareReleaseNotesStep && stepIf(prepareReleaseNotesStep) === SHOULD_CREATE_GITHUB_RELEASE_IF,
    "release.yml must prepare GitHub release notes from preflight create-release output"
  );
  assert(
    createGithubReleaseStep && stepIf(createGithubReleaseStep) === SHOULD_CREATE_GITHUB_RELEASE_IF,
    "release.yml must create GitHub release from preflight create-release output"
  );
}

export function assertReleasePublicationOrder(publishJob: unknown): void {
  const publishIndex = arrayOf(at(publishJob, "steps")).findIndex(
    (step) => stepRun(step) === 'npm publish "$SUPASCHEMA_TARBALL" --access public --provenance'
  );
  const attestIndex = arrayOf(at(publishJob, "steps")).findIndex(
    (step) => stepActionName(step) === "actions/attest"
  );
  const prepareReleaseNotesIndex = arrayOf(at(publishJob, "steps")).findIndex(
    (step) => stepName(step) === "Prepare GitHub release notes"
  );
  const createReleaseIndex = arrayOf(at(publishJob, "steps")).findIndex(
    (step) => stepName(step) === "Create GitHub release"
  );
  assert(
    publishIndex >= 0 && attestIndex === publishIndex + 1,
    "release.yml must attest the published tarball immediately after npm publish"
  );
  assert(
    prepareReleaseNotesIndex >= 0 &&
      prepareReleaseNotesIndex < publishIndex &&
      createReleaseIndex > attestIndex,
    "release.yml must prepare GitHub release notes before external publication and create the GitHub Release after npm provenance attestation"
  );
}

function assertReleaseYaml(parsed: ParsedWorkflows): void {
  const release = parsed.get("release.yml");
  assert(release, "release.yml must exist");
  const releaseOn = recordOf(at(release.doc, "on"));
  assert(
    !at(releaseOn, "release"),
    "release.yml must not publish from GitHub Release events; npm and GitHub releases are created from main"
  );
  assert(
    !at(releaseOn, "workflow_run"),
    "release.yml must not wait on workflow_run; release must not be gated on the full CI workflow"
  );
  assert(
    asArray(at(releaseOn, "push", "branches")).includes("main"),
    `release.yml push trigger must be scoped to main (got ${JSON.stringify(at(releaseOn, "push", "branches"))})`
  );
  assert(
    at(releaseOn, "workflow_dispatch") !== undefined,
    "release.yml must keep workflow_dispatch for release repair"
  );
  assert(
    at(release.doc, "concurrency", "group") === "release-npm" &&
      at(release.doc, "concurrency", "queue") === "max" &&
      at(release.doc, "concurrency", "cancel-in-progress") !== true,
    "release.yml must queue npm publishes with concurrency group release-npm and queue: max"
  );
  const preflightJob = at(release.doc, "jobs", "preflight");
  assert(preflightJob, "release.yml must define a read-only preflight job");
  const preflightIf = String(at(preflightJob, "if") ?? "");
  assert(
    preflightIf.includes("github.event_name == 'workflow_dispatch'") &&
      preflightIf.includes("github.event_name == 'push'") &&
      preflightIf.includes("github.ref == 'refs/heads/main'"),
    "release.yml preflight must run only for main push or main workflow_dispatch"
  );
  assert(
    !at(preflightJob, "permissions") || permissionsAreReadOnly(at(preflightJob, "permissions")),
    "release.yml preflight job must not elevate the read-only workflow token"
  );
  assert(
    at(preflightJob, "permissions", "contents") === "read" &&
      at(preflightJob, "permissions", "packages") === "read",
    "release.yml preflight job must grant only the content and package reads needed by release preflight"
  );
  assert(
    arrayOf(at(preflightJob, "steps")).some((step) =>
      String(at(step, "run") ?? "").includes("node scripts/release/preflight.mts")
    ),
    "release.yml read-only preflight job must run release preflight"
  );
  const publishJob = at(release.doc, "jobs", "publish");
  assert(
    at(publishJob, "permissions", "id-token") === "write",
    "release.yml must have a publish job with id-token: write (OIDC trusted publishing)"
  );
  const publishIf = String(at(publishJob, "if") ?? "");
  assert(
    at(publishJob, "runs-on") === "ubuntu-latest",
    "release.yml publish job must run on a GitHub-hosted Ubuntu runner for npm trusted publishing"
  );
  for (const output of ["create-github-release", "publish-github-package", "publish-npm"]) {
    assert(
      publishIf.includes(`needs.preflight.outputs.${output} == 'true'`),
      `release.yml publish job must require the ${output} preflight output`
    );
  }
  assert(
    at(publishJob, "needs") === "preflight",
    "release.yml privileged publish job must depend on the read-only preflight"
  );
  assert(
    at(publishJob, "permissions", "contents") === "write",
    "release.yml publish job must grant contents: write so it can create the GitHub Release/tag"
  );
  assert(
    !at(publishJob, "env", "SUPASCHEMA_DATABASE_URL"),
    "release.yml publish job must not configure a DB URL"
  );
  assert(!at(publishJob, "services"), "release.yml publish job must not start database services");
  assertHardenRunnerBaseline("release.yml publish job", publishJob, GITHUB_PACKAGES_ENDPOINTS);
  const checkoutStep = arrayOf(at(publishJob, "steps")).find((step) =>
    usesAction(step, "actions/checkout")
  );
  const workflowRunHeadShaRef = ["${{", " github.sha ", "}}"].join("");
  assert(
    at(checkoutStep, "with", "ref") === workflowRunHeadShaRef,
    "release.yml checkout must use github.sha so publish and GitHub release target the merged main commit"
  );
  const setupNodeStep = arrayOf(at(publishJob, "steps")).find(
    (step) => stepActionName(step) === "actions/setup-node"
  );
  assert(setupNodeStep, "release.yml publish job must set up Node for npm trusted publishing");
  assert(
    Number(at(setupNodeStep, "with", "node-version")) >= 24,
    `release.yml publish job must use Node 24+ for npm trusted publishing (got ${JSON.stringify(at(setupNodeStep, "with", "node-version"))})`
  );
  assert(
    at(setupNodeStep, "with", "package-manager-cache") === false,
    "release.yml publish job must disable package-manager caching on the OIDC publish path"
  );
  assert(
    at(setupNodeStep, "with", "registry-url") === "https://registry.npmjs.org",
    "release.yml publish job must configure the npm registry URL for trusted publishing"
  );
  assert(
    arrayOf(at(publishJob, "steps")).some((step) =>
      String(at(step, "run") ?? "").includes("node scripts/release/preflight.mts")
    ),
    "release.yml must run release version preflight before npm ci"
  );
  assert(
    release.raw.includes("npm >= 11.5.1"),
    "release.yml must assert npm >= 11.5.1 for npm trusted publishing"
  );
  assert(
    arrayOf(at(publishJob, "steps")).some((step) =>
      String(at(step, "run") ?? "").includes("npm pack --ignore-scripts")
    ),
    "release.yml must pack the already-built package without rerunning lifecycle scripts"
  );
  assert(
    release.raw.includes("--provenance"),
    "release.yml must publish with explicit `npm publish --provenance` (repo policy, even though trusted publishing also generates provenance)"
  );
  assert(
    release.raw.includes('npm publish "$SUPASCHEMA_TARBALL"'),
    "release.yml must publish the exact tarball that was smoked"
  );
  assertReleaseConditionals(release, publishJob);
  assertReleasePublicationOrder(publishJob);
  assert(
    release.raw.includes("gh release create") &&
      release.raw.includes('--target "$GITHUB_SHA"') &&
      release.raw.includes("--notes-file") &&
      release.raw.includes("node scripts/release/changelog-notes.mts") &&
      !release.raw.includes("--generate-notes"),
    "release.yml must create the GitHub Release/tag from the CHANGELOG.md release notes file"
  );
  assert(
    arrayOf(at(publishJob, "steps")).some((step) => stepActionName(step) === "actions/attest"),
    "release.yml must use actions/attest@v4 for tarball provenance attestation"
  );
  assert(
    !release.raw.includes("npm run benchmark"),
    "release.yml must not run benchmark; benchmarks are advisory and must not block release publication"
  );
  assert(
    !release.raw.includes("gh release upload"),
    "release.yml must not upload extra artifacts to a GitHub Release; create the release/tag only"
  );
}

export function assertSnapshotJob(parsed: ParsedWorkflows): void {
  const release = parsed.get("release.yml");
  const snapshotJob = at(release?.doc, "jobs", "publish-next");
  assert(
    snapshotJob,
    "release.yml must own the publish-next snapshot job; npm trusted publishing accepts one workflow per package and the registration names release.yml, so a separate workflow's OIDC token is rejected"
  );
  const snapshotIf = String(at(snapshotJob, "if") ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  const expectedSnapshotIf = [
    "${{",
    " !cancelled() && github.event_name == 'push' && needs.preflight.result == 'success' && (needs.publish.result == 'success' || needs.publish.result == 'skipped') ",
    "}}",
  ].join("");
  assert(
    snapshotIf === expectedSnapshotIf,
    "release.yml publish-next must run only for main pushes after successful preflight and a successful or intentionally skipped stable publish, and must fail closed on failure or cancellation"
  );
  assert(
    JSON.stringify(asArray(at(snapshotJob, "needs"))) === JSON.stringify(["preflight", "publish"]),
    "release.yml publish-next must need preflight and publish so the next-tag publish cannot bypass or race the stable release transaction"
  );
  assert(
    at(snapshotJob, "environment") === "release",
    "release.yml publish-next job must run in the release environment so OIDC stays main-gated"
  );
  assert(
    at(snapshotJob, "permissions", "id-token") === "write" &&
      at(snapshotJob, "permissions", "attestations") === "write",
    "release.yml publish-next job must grant id-token and attestations writes for trusted publishing and provenance"
  );
  assert(
    at(snapshotJob, "permissions", "contents") === "read",
    "release.yml publish-next job must not grant contents: write; snapshots create no releases or tags"
  );
  assert(
    at(snapshotJob, "runs-on") === "ubuntu-latest",
    "release.yml publish-next job must run on a GitHub-hosted Ubuntu runner for npm trusted publishing"
  );
  assertHardenRunnerBaseline(
    "release.yml publish-next job",
    snapshotJob,
    RELEASE_ASSET_CDN_ENDPOINTS
  );
  const checkoutStep = arrayOf(at(snapshotJob, "steps")).find((step) =>
    usesAction(step, "actions/checkout")
  );
  const workflowRunHeadShaRef = ["${{", " github.sha ", "}}"].join("");
  assert(
    at(checkoutStep, "with", "ref") === workflowRunHeadShaRef,
    "release.yml publish-next checkout must use github.sha so the snapshot targets the merged main commit"
  );
  const steps = arrayOf(at(snapshotJob, "steps"));
  const stepRuns = steps.map((step) => String(at(step, "run") ?? ""));
  const stampIndex = steps.findIndex((step) =>
    String(at(step, "run") ?? "").includes("node scripts/release/snapshot-version.mts")
  );
  const buildIndex = steps.findIndex((step) =>
    String(at(step, "run") ?? "").includes("npm run build")
  );
  const publishIndex = steps.findIndex(
    (step) =>
      stepRun(step) === 'npm publish "$SUPASCHEMA_TARBALL" --access public --provenance --tag next'
  );
  const attestIndex = steps.findIndex((step) => stepActionName(step) === "actions/attest");
  const preparePackageManagersIndex = steps.findIndex(
    (step) => stepName(step) === "Prepare alternative package managers"
  );
  const setupBunIndex = steps.findIndex(
    (step) => stepName(step) === "Install Bun for registry smoke"
  );
  const setupBunStep = steps[setupBunIndex];
  assert(
    stampIndex >= 0 && buildIndex > stampIndex,
    "release.yml publish-next must stamp the snapshot version before npm run build so dist/build-info.json carries it"
  );
  assert(
    stepRuns.some(
      (run) => run === 'npm publish "$SUPASCHEMA_TARBALL" --access public --provenance --tag next'
    ),
    "release.yml publish-next must publish the smoked tarball with explicit `npm publish --tag next`"
  );
  assert(
    preparePackageManagersIndex >= 0 &&
      preparePackageManagersIndex < publishIndex &&
      setupBunIndex >= 0 &&
      setupBunIndex < publishIndex,
    "release.yml publish-next must prepare every registry-smoke package manager before external publication"
  );
  assert(
    stepActionName(setupBunStep) === "oven-sh/setup-bun" &&
      String(at(setupBunStep, "with", "bun-version")) === "1.3.14",
    "release.yml publish-next must install pinned Bun 1.3.14 before publication"
  );
  assert(
    publishIndex >= 0 && attestIndex === publishIndex + 1,
    "release.yml publish-next must attest the published tarball immediately after npm publish"
  );
  assert(
    !stepRuns.some((run) => run.includes("--tag latest")),
    "release.yml publish-next must never publish to the latest dist-tag"
  );
  assert(
    !stepRuns.some((run) => run.includes("node scripts/release/preflight.mts")),
    "release.yml publish-next must bypass the stable-release preflight; snapshots carry no changelog entry"
  );
  assert(
    !stepRuns.some((run) => run.includes("gh release create")),
    "release.yml publish-next must not create GitHub Releases or tags"
  );
  const registrySmokeStep = steps.find((step) =>
    String(at(step, "run") ?? "").includes("node scripts/release/registry-smoke.mts")
  );
  const registrySmokeIndex = steps.indexOf(registrySmokeStep);
  const immutableSnapshotSpec = ["supaschema@$", "{{ steps.snapshot.outputs.version }}"].join("");
  assert(
    at(registrySmokeStep, "env", "SUPASCHEMA_REGISTRY_SMOKE_SPEC") === immutableSnapshotSpec,
    "release.yml publish-next must registry-smoke the immutable version emitted by the stamp step"
  );
  assert(
    registrySmokeIndex > attestIndex,
    "release.yml publish-next must registry-smoke only after publication and provenance attestation"
  );
}

function assertConsumerCanaryYaml(parsed: ParsedWorkflows): void {
  const canary = parsed.get("consumer-canary.yml");
  assert(canary, "consumer-canary.yml must exist");
  const canaryOn = recordOf(at(canary.doc, "on"));
  assert(
    at(canaryOn, "workflow_dispatch") !== undefined &&
      at(canaryOn, "push") === undefined &&
      at(canaryOn, "pull_request") === undefined &&
      at(canaryOn, "schedule") === undefined &&
      at(canaryOn, "workflow_run") === undefined,
    "consumer-canary.yml must run on workflow_dispatch only; canaries never gate or auto-run"
  );
  const canaryJob = Object.values(recordOf(at(canary.doc, "jobs")))[0];
  assert(canaryJob, "consumer-canary.yml must define a canary job");
  assert(
    !at(canaryJob, "permissions") || permissionsAreReadOnly(at(canaryJob, "permissions")),
    "consumer-canary.yml job must not elevate the read-only workflow token"
  );
  assert(
    !JSON.stringify(recordOf(at(canaryJob, "permissions"))).includes("id-token"),
    "consumer-canary.yml must not request OIDC; canaries never publish"
  );
  assert(
    arrayOf(at(canaryJob, "steps")).some((step) => usesAction(step, "step-security/harden-runner")),
    "consumer-canary.yml must run step-security/harden-runner"
  );
  assert(
    canary.raw.includes("secrets.CONSUMER_CANARY_TOKEN"),
    "consumer-canary.yml must read the consumer clone token from secrets.CONSUMER_CANARY_TOKEN"
  );
  assert(
    canary.raw.includes("node scripts/release/consumer-canary.mts"),
    "consumer-canary.yml must run the consumer-canary script"
  );
}

function assertConsumerPackageSmokeSteps(qualitySteps: readonly unknown[]): void {
  const preparePackageManagersStep = findNamedStep(
    qualitySteps,
    "Prepare alternate consumer package managers"
  );
  assert(
    preparePackageManagersStep &&
      stepIf(preparePackageManagersStep) === "matrix.node-version == 22" &&
      stepRun(preparePackageManagersStep).includes("corepack prepare pnpm@11.1.2 --activate") &&
      stepRun(preparePackageManagersStep).includes("corepack prepare yarn@4.17.1 --activate"),
    "ci.yml must prepare pnpm and Yarn only for the Node 22 consumer package-smoke lane"
  );
  const setupBunStep = findNamedStep(qualitySteps, "Install Bun for consumer package smoke");
  assert(
    setupBunStep &&
      stepIf(setupBunStep) === "matrix.node-version == 22" &&
      stepActionName(setupBunStep) === "oven-sh/setup-bun" &&
      String(at(setupBunStep, "with", "bun-version")) === "1.3.14",
    "ci.yml must install pinned Bun only for the Node 22 consumer package-smoke lane"
  );
  const packageSmokeStep = findNamedStep(qualitySteps, "Smoke package managers from tarball");
  assert(
    packageSmokeStep &&
      stepIf(packageSmokeStep) === "matrix.node-version == 22" &&
      !at(packageSmokeStep, "env") &&
      stepRun(packageSmokeStep) === "npm run package:smoke",
    "ci.yml must run npm run package:smoke with all package-manager lanes required on Node 22"
  );
  const examplesSmokeStep = findNamedStep(
    qualitySteps,
    "Examples smoke (shipped examples render + check clean)"
  );
  assert(examplesSmokeStep, "ci.yml quality job must keep the examples smoke step");
  assert(
    stepIf(examplesSmokeStep) === "matrix.node-version == 22",
    "ci.yml examples smoke must run once on Node 22, not across the full quality matrix"
  );
  const examplesTestsStep = findNamedStep(qualitySteps, "Examples tests");
  assert(examplesTestsStep, "ci.yml quality job must run the examples test lane");
  assert(
    stepIf(examplesTestsStep) === "matrix.node-version == 22" &&
      stepRun(examplesTestsStep) === "npm run test:examples",
    "ci.yml examples tests must run once on Node 22 via npm run test:examples"
  );
}

export function check(root = ROOT): void {
  const WORKFLOWS_DIR = path.join(root, ".github", "workflows");
  const files = workflowFiles(root);
  const expectedWorkflowFiles = [
    "ci.yml",
    "consumer-canary.yml",
    "dependency-review.yml",
    "docs.yml",
    "python.yml",
    "release.yml",
    "scorecard.yml",
  ];
  assert(
    JSON.stringify(files) === JSON.stringify(expectedWorkflowFiles),
    `expected tracked workflows ${expectedWorkflowFiles.join(", ")} under .github/workflows, found ${files.join(", ")}`
  );

  const parsed: ParsedWorkflows = new Map();
  for (const file of files) {
    const raw = fs.readFileSync(path.join(WORKFLOWS_DIR, file), "utf8");
    parsed.set(file, { doc: parseYaml(raw), raw });
  }
  const packageJson = readJson("package.json", root);
  const allowedActionPatterns = new Set(
    stringsOf(
      at(
        readJson(".github/repo-policy.json", root),
        "actions",
        "selectedActions",
        "patterns_allowed"
      )
    )
  );

  assertWorkflowBasics(parsed, allowedActionPatterns);

  for (const file of ["ci.yml", "dependency-review.yml", "docs.yml"]) {
    const doc = parsed.get(file)?.doc;
    assert(doc, `${file} must exist`);
    assert(
      at(doc, "concurrency", "cancel-in-progress") === true,
      `${file}: PR-facing workflow must declare concurrency with cancel-in-progress: true`
    );
  }
  assert(
    at(parsed.get("release.yml")?.doc, "concurrency", "cancel-in-progress") !== true,
    "release.yml must not set cancel-in-progress: true (never cancel an in-flight publish)"
  );

  assertReleaseYaml(parsed);
  assertSnapshotJob(parsed);
  assertConsumerCanaryYaml(parsed);

  const ci = parsed.get("ci.yml")?.doc;
  assert(ci, "ci.yml must exist");
  const requiredJob = at(ci, "jobs", "required");
  assert(
    at(requiredJob, "name") === "CI required" &&
      String(at(requiredJob, "if")).includes("always()") &&
      JSON.stringify(asArray(at(requiredJob, "needs"))) ===
        JSON.stringify(["quality", "check", "check-os"]),
    "ci.yml must expose one stable CI required job over every matrix lane"
  );
  const nodes = jobMatrix(ci, "quality", "node-version");
  assert(
    [22, 24].every((value) => nodes.includes(value)),
    `ci.yml quality node-version matrix must include 22 and 24 (got ${JSON.stringify(nodes)})`
  );
  const postgres = jobMatrix(ci, "check", "postgres");
  assert(
    [15, 16, 17].every((value) => postgres.includes(value)),
    `ci.yml check postgres matrix must include 15, 16, 17 (got ${JSON.stringify(postgres)})`
  );
  const qualityRuns = arrayOf(at(ci, "jobs", "quality", "steps")).map((step) =>
    String(at(step, "run") ?? "")
  );
  assert(
    !qualityRuns.some((run) => run.includes("npm run benchmark")),
    "ci.yml quality job must not run npm run benchmark without a database URL"
  );
  const qualitySteps = arrayOf(at(ci, "jobs", "quality", "steps"));
  assert(
    at(packageJson, "scripts", "check") ===
      "npm run build && npm run lint && npm run typecheck && npm test",
    "package.json check must run the documented build, lint, typecheck, and test contract"
  );
  assert(
    stepRunBefore(qualitySteps, "npm run build", "npm run lint:ci"),
    "ci.yml quality job must build generated dist before npm run lint:ci resolves dist imports"
  );
  assert(
    qualitySteps.some((step) => stepRun(step) === "npm run format:md:check"),
    "ci.yml quality job must run the read-only Markdown formatting check"
  );
  assert(
    !at(packageJson, "scripts", "github:check-dco"),
    "package.json must not expose a DCO blocker as npm run github:check-dco"
  );
  assert(
    !qualitySteps.some(
      (step) =>
        at(step, "name") === "DCO sign-off" ||
        String(at(step, "run") ?? "").includes("github:check-dco")
    ),
    "ci.yml quality job must not enforce a DCO signoff blocker"
  );
  assert(
    at(packageJson, "scripts", "package:smoke") === "node scripts/release/package-smoke.mts",
    "package.json must expose one strict npm run package:smoke consumer tarball smoke"
  );
  assert(
    at(packageJson, "scripts", "test:consumer-lifecycle") ===
      "vitest run tests/package/consumer.test.ts",
    "package.json must expose npm run test:consumer-lifecycle for installed-CLI consumer lifecycle proof"
  );
  assert(
    !at(packageJson, "scripts", "package:smoke:all"),
    "package.json must not expose a second package-smoke entry point"
  );
  const releaseVerifyScript = String(at(packageJson, "scripts", "release:verify") ?? "");
  assert(
    releaseVerifyScript.includes("npm run test:consumer-lifecycle"),
    "release:verify must include npm run test:consumer-lifecycle"
  );
  assert(
    releaseVerifyScript.includes("npm run package:smoke"),
    "release:verify must include npm run package:smoke"
  );
  assert(
    releaseVerifyScript.indexOf("npm run test:consumer-lifecycle") <
      releaseVerifyScript.indexOf("npm run package:smoke"),
    "release:verify must run npm run test:consumer-lifecycle before npm run package:smoke"
  );
  assertConsumerPackageSmokeSteps(qualitySteps);

  const dependencyReview = at(
    parsed.get("dependency-review.yml")?.doc,
    "jobs",
    "dependency-review"
  );
  const dependencyReviewStep = arrayOf(at(dependencyReview, "steps")).find(
    (step) => stepActionName(step) === "actions/dependency-review-action"
  );
  assert(dependencyReviewStep, "dependency-review.yml must run dependency-review-action");
  assert(
    !("comment-summary-in-pr" in recordOf(at(dependencyReviewStep, "with"))),
    "dependency-review.yml must remain read-only and must not request PR comment writes"
  );
  assert(
    !(
      "allow-licenses" in recordOf(at(dependencyReviewStep, "with")) ||
      "deny-licenses" in recordOf(at(dependencyReviewStep, "with")) ||
      "allow-dependencies-licenses" in recordOf(at(dependencyReviewStep, "with"))
    ),
    "dependency-review.yml must stay vulnerability-only; the license allow-list was retired as metadata noise"
  );

  const checkRuns = arrayOf(at(ci, "jobs", "check", "steps")).map((step) =>
    String(at(step, "run") ?? "")
  );
  assert(
    !checkRuns.some((run) => run.includes("npm run benchmark")),
    "ci.yml check job must not run npm run benchmark; benchmarks are advisory and must not block CI"
  );
  assert(
    !checkRuns.some((run) => ["npm test", "npm run test:coverage"].includes(run.trim())),
    "ci.yml check job must use matrix-focused test scripts, not the full examples suite"
  );
  const checkSteps = arrayOf(at(ci, "jobs", "check", "steps"));
  const dbTestsStep = findNamedStep(checkSteps, "DB-gated tests");
  assert(
    dbTestsStep &&
      stepIf(dbTestsStep) === "matrix.postgres != 17" &&
      stepRun(dbTestsStep) === "npm run test:matrix",
    "ci.yml DB-gated tests must use npm run test:matrix for postgres 15/16"
  );
  const coverageStep = findNamedStep(
    checkSteps,
    "Coverage (pg17 runs the suite once, with coverage)"
  );
  assert(
    coverageStep &&
      stepIf(coverageStep) === "matrix.postgres == 17" &&
      stepRun(coverageStep) === "npm run test:matrix:coverage",
    "ci.yml pg17 coverage must use npm run test:matrix:coverage"
  );
  const oses = jobMatrix(ci, "check-os", "os");
  assert(
    ["macos-latest", "windows-latest"].every((value) => oses.includes(value)),
    `ci.yml check-os os matrix must include macos-latest and windows-latest (got ${JSON.stringify(oses)})`
  );
  const osDbTestsStep = findNamedStep(
    arrayOf(at(ci, "jobs", "check-os", "steps")),
    "DB-gated tests (DB-gated cases skip without a database)"
  );
  assert(
    osDbTestsStep && stepRun(osDbTestsStep) === "npm run test:matrix",
    "ci.yml check-os must use npm run test:matrix so examples failures stay in quality"
  );

  assert(files.includes("python.yml"), "python.yml must stay tracked with the agent MCP service");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  check();
  ok("CI_GOVERNANCE_OK");
}
