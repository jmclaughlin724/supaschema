import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, test } from "vitest";

const workflowSources = [
  ".claude/skills/deep-research/references/workflow-backed-deep-research.js",
  ".claude/skills/code-review/references/workflow-backed-code-review.js",
  ".claude/skills/batch/SKILL.md",
  ".claude/agents/worker.md",
];
const hasWorkflowSources = workflowSources.every((file) => existsSync(join(process.cwd(), file)));

describe.skipIf(!hasWorkflowSources)("extracted workflow sources", () => {
  test("keeps deep-research resilient to failed searches and bounded fetches", async () => {
    const sourceText = await readFile(
      join(
        process.cwd(),
        ".claude/skills/deep-research/references/workflow-backed-deep-research.js"
      ),
      "utf8"
    );
    const sourceFile = ts.createSourceFile(
      "workflow-backed-deep-research.js",
      sourceText,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS
    );
    const ifStatements = collectIfStatements(sourceFile);

    const failedSearch = ifStatements.find(
      (statement) => statement.expression.getText(sourceFile) === "!r"
    );
    expect(failedSearch?.thenStatement.getText(sourceFile)).toContain(
      "return { angle: angle.label, results: [] }"
    );

    expect(sourceText).toContain("searchParams.delete(param)");
    expect(sourceText).toContain("const query = p.searchParams.toString()");
    expect(sourceText).toContain('(query ? "?" + query : "")');
    expect(sourceText).toContain(".slice(0, MAX_FETCH)");
    expect(
      ifStatements.some((statement) =>
        statement.expression.getText(sourceFile).includes("fetchSlots <= 0 &&")
      )
    ).toBe(false);
  });

  test("parses workflow code-review flags outside the review target", async () => {
    const sourceText = await readFile(
      join(process.cwd(), ".claude/skills/code-review/references/workflow-backed-code-review.js"),
      "utf8"
    );
    expect(sourceText).toContain('token === "--fix"');
    expect(sourceText).toContain('token === "--comment"');
    expect(sourceText).toContain("POSITIONAL_ARGS");
    expect(sourceText).toContain("FLAG_INSTRUCTIONS");
  });

  test("keeps batch and worker extraction edit-only and runtime-neutral", async () => {
    const [batchText, workerText] = await Promise.all([
      readFile(join(process.cwd(), ".claude/skills/batch/SKILL.md"), "utf8"),
      readFile(join(process.cwd(), ".claude/agents/worker.md"), "utf8"),
    ]);

    expect(workerText).toContain("Do not stage, commit, push");
    expect(workerText).toContain("Findings or files changed, with precise references.");
    expect(workerText).not.toContain("Committed abc123");

    expect(batchText).toContain("workers edit the current branch in the current worktree");
    expect(batchText).toContain("Do not stage, commit, push");
    expect(batchText).toContain("| # | Unit | Status | Files |");
    expect(batchText).not.toContain("| # | Unit | Status | Commit |");
    expect(batchText).not.toContain("Invoke the `Skill` tool");
    expect(batchText).not.toContain("Use `subagent_type:");
    expect(batchText).not.toContain("commit, push, and open a PR");
  });
});

function collectIfStatements(node: ts.Node): ts.IfStatement[] {
  const out: ts.IfStatement[] = [];
  const visit = (current: ts.Node) => {
    if (ts.isIfStatement(current)) {
      out.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return out;
}
