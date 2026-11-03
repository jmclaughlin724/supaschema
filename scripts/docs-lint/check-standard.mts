#!/usr/bin/env node

import { globSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectLocalRunnerConvention } from "./local-runner.mts";
import { inspectDocsPage } from "./page.mts";

const DOCS_GLOB = "docs/**/*.{md,mdx}";
const EXCLUDED_DOC_PREFIXES = [
  "docs/node_modules/",
  "docs/.blume/",
  "docs/.blume-verify/",
  "docs/dist/",
];
const toPosix = (path: string) => path.replaceAll("\\", "/");

export interface DocsViolation {
  file: string;
  line: number;
  msg: string;
  rule: string;
}

interface DocsLintOptions {
  files?: readonly string[];
  rootDir?: string;
}

const discoverDocsFiles = (rootDir: string) =>
  globSync(DOCS_GLOB, { cwd: rootDir })
    .map(toPosix)
    .filter((file) => !EXCLUDED_DOC_PREFIXES.some((prefix) => file.startsWith(prefix)))
    .sort();

export function lintDocsStandard({
  rootDir = process.cwd(),
  files,
}: DocsLintOptions = {}): DocsViolation[] {
  const relativeFiles = (files ?? discoverDocsFiles(rootDir)).map(toPosix).sort();
  const violations: DocsViolation[] = [];
  const isFullDocsLint = files === undefined;

  for (const file of relativeFiles) {
    const absoluteFile = isAbsolute(file) ? file : join(rootDir, file);
    const displayFile = toPosix(isAbsolute(file) ? relative(rootDir, absoluteFile) : file);
    const text = readFileSync(absoluteFile, "utf8");
    inspectDocsPage(text, displayFile, violations);
  }

  if (isFullDocsLint) {
    inspectLocalRunnerConvention(rootDir, violations);
  }

  return violations;
}

function formatViolations(violations: readonly DocsViolation[], pageCount: number) {
  if (violations.length === 0) {
    return `docs-standard: ${pageCount} pages OK`;
  }

  const filesWithViolations = new Set(violations.map((violation) => violation.file)).size;
  const lines = [
    `docs-standard: ${violations.length} violation(s) across ${filesWithViolations} file(s):`,
    "",
  ];
  for (const violation of violations) {
    lines.push(`  ${violation.file}:${violation.line}  [${violation.rule}] ${violation.msg}`);
  }
  lines.push(
    "",
    "See .claude/rules/02-blume-writing-standards.md and .claude/rules/03-blume-component-reference.md for the full contract."
  );
  return lines.join("\n");
}

function runCli() {
  const files = discoverDocsFiles(process.cwd());
  const violations = lintDocsStandard();
  const output = formatViolations(violations, files.length);
  if (violations.length === 0) {
    console.log(output);
    return 0;
  }
  console.error(output);
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(runCli());
}
