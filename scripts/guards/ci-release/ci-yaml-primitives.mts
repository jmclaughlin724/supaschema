import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { arrayOf, at, recordOf } from "../../lib/json.mts";

export interface WorkflowStep {
  job: unknown;
  jobId: string;
  step: unknown;
}

const HEX = "0123456789abcdef";

export function isSha40(ref: unknown): boolean {
  return typeof ref === "string" && ref.length === 40 && [...ref].every((c) => HEX.includes(c));
}

export function* eachStep(doc: unknown): Generator<WorkflowStep> {
  for (const [jobId, job] of Object.entries(recordOf(at(doc, "jobs")))) {
    for (const step of arrayOf(at(job, "steps"))) {
      yield { job, jobId, step };
    }
  }
}

export function jobMatrix(doc: unknown, jobId: string, key: string): unknown[] {
  return arrayOf(at(doc, "jobs", jobId, "strategy", "matrix", key));
}

export function matrixValues(doc: unknown, jobId: string, key: string): unknown[] {
  const matrix = recordOf(at(doc, "jobs", jobId, "strategy", "matrix"));
  const values = matrix[key];
  if (Array.isArray(values)) {
    return values;
  }
  if (Array.isArray(matrix.include)) {
    return matrix.include
      .map((entry: unknown) => at(entry, key))
      .filter((value: unknown) => value !== undefined);
  }
  return [];
}

export function permissionsAreReadOnly(perms: unknown): boolean {
  if (perms === undefined) {
    return false;
  }
  if (typeof perms === "string") {
    return perms === "read-all" || perms === "read";
  }
  if (typeof perms === "object" && perms !== null) {
    return Object.values(perms).every((value) => value === "read" || value === "none");
  }
  return false;
}

export function asArray(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }
  return value === undefined ? [] : [value];
}

export function stepActionName(step: unknown): string | undefined {
  const uses = at(step, "uses");
  if (typeof uses !== "string" || uses.startsWith("./")) {
    return;
  }
  const separator = uses.lastIndexOf("@");
  return separator > 0 ? uses.slice(0, separator) : uses;
}

export function stepIf(step: unknown): string {
  return String(at(step, "if") ?? "").trim();
}

export function stepName(step: unknown): string {
  return String(at(step, "name") ?? "");
}

export function stepRun(step: unknown): string {
  return String(at(step, "run") ?? "").trim();
}

export function stepRunBefore(steps: readonly unknown[], before: string, after: string): boolean {
  const beforeIndex = steps.findIndex((step) => stepRun(step) === before);
  const afterIndex = steps.findIndex((step) => stepRun(step) === after);
  return beforeIndex !== -1 && afterIndex !== -1 && beforeIndex < afterIndex;
}

export function findNamedStep(steps: readonly unknown[], name: string): unknown {
  return steps.find((step) => stepName(step) === name);
}

export function workflowFiles(root: string): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--", ".github/workflows"], {
    cwd: root,
  }).toString("utf8");
  return out
    .split("\0")
    .filter(Boolean)
    .filter((file) => fs.existsSync(path.join(root, file)))
    .map((file) => path.basename(file))
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
}
