import { isRecord, type JsonRecord } from "../lib/json.mts";
import type { DocsViolation } from "./check-standard.mts";
import type { DocsNode, DocsTree } from "./page.mts";

const { parse: parseYaml } = await import("yaml");

const lineOf = (node: DocsNode) => node.position?.start?.line ?? 1;

const pushFrontmatterViolation = (violations: DocsViolation[], file: string, msg: string) => {
  violations.push({ file, line: 1, msg, rule: "frontmatter" });
};

export const readFrontmatter = (tree: DocsTree, file: string, violations: DocsViolation[]) => {
  const firstNode = tree.children[0];
  if (firstNode?.type !== "yaml" || lineOf(firstNode) !== 1) {
    pushFrontmatterViolation(
      violations,
      file,
      "page must open with a YAML frontmatter block (---)"
    );
    return;
  }

  let data: unknown;
  try {
    data = parseYaml(firstNode.value);
  } catch (error) {
    pushFrontmatterViolation(
      violations,
      file,
      `frontmatter is not valid YAML: ${error instanceof Error ? error.message : String(error)}`
    );
    return;
  }

  if (!isRecord(data)) {
    pushFrontmatterViolation(violations, file, "frontmatter must be a YAML mapping");
    return;
  }
  validateRequiredFrontmatterFields(data, file, violations);
  validateFrontmatterFieldTypes(data, file, violations);
  return data;
};

const validateRequiredFrontmatterFields = (
  data: JsonRecord,
  file: string,
  violations: DocsViolation[]
) => {
  if (typeof data.title !== "string" || data.title.trim().length === 0) {
    pushFrontmatterViolation(violations, file, "missing `title`");
  }
  if (typeof data.description !== "string" || data.description.trim().length === 0) {
    pushFrontmatterViolation(violations, file, "missing `description`");
  }
  if (
    !Array.isArray(data.keywords) ||
    data.keywords.length === 0 ||
    !data.keywords.every(
      (keyword: unknown) => typeof keyword === "string" && keyword.trim().length > 0
    )
  ) {
    pushFrontmatterViolation(violations, file, "missing or invalid `keywords` array");
  }
};

const validateFrontmatterFieldTypes = (
  data: JsonRecord,
  file: string,
  violations: DocsViolation[]
) => {
  for (const field of ["slug", "type", "date", "lastModified"]) {
    if (data[field] !== undefined && typeof data[field] !== "string") {
      pushFrontmatterViolation(violations, file, `\`${field}\` must be a string when present`);
    }
  }
  for (const field of ["draft", "hidden"]) {
    if (data[field] !== undefined && typeof data[field] !== "boolean") {
      pushFrontmatterViolation(violations, file, `\`${field}\` must be a boolean when present`);
    }
  }
  for (const field of ["sidebar", "seo", "search"]) {
    const value = data[field];
    if (
      value !== undefined &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      pushFrontmatterViolation(violations, file, `\`${field}\` must be a mapping when present`);
    }
  }
};
