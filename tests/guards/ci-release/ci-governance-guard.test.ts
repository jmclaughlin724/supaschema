import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  assertReleasePublicationOrder,
  assertSnapshotJob,
} from "../../../scripts/guards/ci-release/check-ci-governance.mts";

describe("CI governance guard", () => {
  it("scans cached workflow files only", () => {
    const source = ts.createSourceFile(
      "ci-yaml-primitives.mts",
      readFileSync(resolve("scripts/guards/ci-release/ci-yaml-primitives.mts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );
    const args = gitWorkflowLsFilesArgs(source);

    expect(args).toHaveLength(5);
    expect(args).toContain("--cached");
    expect(args).not.toContain("--others");
    expect(args).not.toContain("--exclude-standard");
  });

  it("accepts the fail-closed snapshot gate for stable success or intentional skip", () => {
    const parsed = releaseWorkflow();
    const snapshotJob = releaseJobs(parsed)["publish-next"];

    expect(() => assertSnapshotJob(parsed)).not.toThrow();
    expect(String(snapshotJob.if)).toContain("needs.publish.result == 'success'");
    expect(String(snapshotJob.if)).toContain("needs.publish.result == 'skipped'");
    expect(String(snapshotJob.if)).not.toContain("always()");
  });

  it("rejects snapshot gates that can run after a failed or cancelled dependency", () => {
    const parsed = releaseWorkflow();
    releaseJobs(parsed)["publish-next"].if = [
      "${{",
      " always() && github.event_name == 'push' ",
      "}}",
    ].join("");

    expect(() => assertSnapshotJob(parsed)).toThrow("fail closed on failure or cancellation");
  });

  it("rejects a snapshot job that bypasses the preflight dependency", () => {
    const parsed = releaseWorkflow();
    releaseJobs(parsed)["publish-next"].needs = ["publish"];

    expect(() => assertSnapshotJob(parsed)).toThrow("must need preflight and publish");
  });

  it("rejects snapshot registry-smoke tools prepared after publication", () => {
    const parsed = releaseWorkflow();
    const steps = releaseJobs(parsed)["publish-next"].steps;
    const prepareIndex = steps.findIndex(
      (step: { name?: string }) => step.name === "Prepare alternative package managers"
    );
    const [prepareStep] = steps.splice(prepareIndex, 1);
    const publishIndex = steps.findIndex((step: { run?: string }) =>
      String(step.run).includes("npm publish")
    );
    steps.splice(publishIndex + 1, 0, prepareStep);

    expect(() => assertSnapshotJob(parsed)).toThrow(
      "prepare every registry-smoke package manager before external publication"
    );
  });

  it("rejects an unpinned snapshot Bun runtime", () => {
    const parsed = releaseWorkflow();
    const setupBun = releaseJobs(parsed)["publish-next"].steps.find(
      (step: { name?: string }) => step.name === "Install Bun for registry smoke"
    );
    setupBun.with["bun-version"] = "latest";

    expect(() => assertSnapshotJob(parsed)).toThrow("must install pinned Bun 1.3.14");
  });

  it("rejects GitHub Packages egress from the snapshot lane", () => {
    const parsed = releaseWorkflow();
    const hardenRunner = releaseJobs(parsed)["publish-next"].steps.find((step: { uses?: string }) =>
      String(step.uses).startsWith("step-security/harden-runner")
    );
    hardenRunner.with["allowed-endpoints"] = `${String(
      hardenRunner.with["allowed-endpoints"]
    ).trim()} npm.pkg.github.com:443`;

    expect(() => assertSnapshotJob(parsed)).toThrow("reviewed egress endpoint allow-list");
  });

  it("requires stable release-note preparation before external publication", () => {
    const parsed = releaseWorkflow();
    const publishJob = releaseJobs(parsed).publish;

    expect(() => assertReleasePublicationOrder(publishJob)).not.toThrow();
    const steps = publishJob.steps;
    const notesIndex = steps.findIndex(
      (step: { name?: string }) => step.name === "Prepare GitHub release notes"
    );
    const [notesStep] = steps.splice(notesIndex, 1);
    const publishIndex = steps.findIndex((step: { run?: string }) =>
      String(step.run).includes('npm publish "$SUPASCHEMA_TARBALL" --access public')
    );
    steps.splice(publishIndex + 2, 0, notesStep);

    expect(() => assertReleasePublicationOrder(publishJob)).toThrow(
      "prepare GitHub release notes before external publication"
    );
  });

  it("covers the consumer canary lane invariants", () => {
    const source = readFileSync(
      resolve("scripts/guards/ci-release/check-ci-governance.mts"),
      "utf8"
    );
    expect(source).toContain('parsed.get("consumer-canary.yml")');
    expect(source).toContain("secrets.CONSUMER_CANARY_TOKEN");
    expect(source).toContain("node scripts/release/consumer-canary.mts");
  });

  it("scans tracked exec-policy rule files only", () => {
    const source = ts.createSourceFile(
      "check-codex-execpolicy.mts",
      readFileSync(resolve("scripts/guards/ci-release/check-codex-execpolicy.mts"), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    expect(namedImports(source, "../lib/repository.mts")).toContain("gitTrackedFiles");
    expect(callNames(source)).not.toContain("fs.readdirSync");
  });
});

function releaseWorkflow() {
  const raw = readFileSync(resolve(".github/workflows/release.yml"), "utf8");
  return new Map([["release.yml", { doc: parseYaml(raw), raw }]]);
}

function releaseJobs(parsed: ReturnType<typeof releaseWorkflow>) {
  const jobs = parsed.get("release.yml")?.doc?.jobs;
  if (!jobs) {
    throw new Error("release.yml jobs are required by the test fixture");
  }
  return jobs;
}

function namedImports(source: ts.SourceFile, moduleSpecifier: string): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === moduleSpecifier
    ) {
      const bindings = node.importClause?.namedBindings;
      if (bindings !== undefined && ts.isNamedImports(bindings)) {
        names.push(...bindings.elements.map((element) => element.name.text));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function callNames(source: ts.SourceFile): string[] {
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      names.push(node.expression.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function gitWorkflowLsFilesArgs(source: ts.SourceFile): string[] {
  const matches: string[][] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(source) === "execFileSync") {
      const [command, args] = node.arguments;
      if (
        ts.isStringLiteral(command) &&
        command.text === "git" &&
        args !== undefined &&
        ts.isArrayLiteralExpression(args)
      ) {
        const values = args.elements.filter(ts.isStringLiteral).map((element) => element.text);
        if (values.includes("ls-files") && values.includes(".github/workflows")) {
          matches.push(values);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (matches.length !== 1) {
    throw new Error(`expected one git workflow ls-files call, found ${matches.length}`);
  }
  return matches[0] ?? [];
}
