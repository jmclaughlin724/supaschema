#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assert, ok } from "../lib/assertions.mts";
import { gitFiles, ROOT } from "../lib/repository.mts";

interface RuleToken {
  kind: "number" | "symbol" | "word";
  value: string;
}

function numberedRulePrefix(name: string): string | undefined {
  if (name.length < 6 || !name.endsWith(".md") || name[2] !== "-") {
    return;
  }
  const prefix = name.slice(0, 2);
  return isDigits(prefix) ? prefix : undefined;
}

function ruleCitationNumbers(line: string): string[] {
  const tokens = tokensForLine(line);
  const numbers: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind !== "word" || !(token.value === "rule" || token.value === "rules")) {
      continue;
    }
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const current = tokens[cursor];
      if (current.kind === "number" && current.value.length <= 2) {
        numbers.push(current.value);
        continue;
      }
      if (
        (current.kind === "word" && current.value === "and") ||
        (current.kind === "symbol" &&
          (current.value === "," || current.value === "/" || current.value === "#"))
      ) {
        continue;
      }
      break;
    }
  }
  return numbers;
}

function tokensForLine(line: string): RuleToken[] {
  const tokens: RuleToken[] = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index] ?? "";
    if (isAsciiLetter(char)) {
      const start = index;
      index += 1;
      while (index < line.length && isAsciiLetter(line[index] ?? "")) {
        index += 1;
      }
      tokens.push({ kind: "word", value: line.slice(start, index).toLowerCase() });
      continue;
    }
    if (isDigit(char)) {
      const start = index;
      index += 1;
      while (index < line.length && isDigit(line[index] ?? "")) {
        index += 1;
      }
      tokens.push({ kind: "number", value: line.slice(start, index) });
      continue;
    }
    if (char === "," || char === "/" || char === "#") {
      tokens.push({ kind: "symbol", value: char });
    }
    index += 1;
  }
  return tokens;
}

function isDigits(value: string): boolean {
  return value.length > 0 && [...value].every(isDigit);
}

function isAsciiLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function citationNumberViolations(
  rel: string,
  lineNumber: number,
  rawNumbers: readonly string[],
  validNumbers: ReadonlySet<string>,
  isRuleSource: boolean,
  ownerNumber: string | undefined
): string[] {
  return rawNumbers.flatMap((raw) => {
    const number = raw.padStart(2, "0");
    if (!validNumbers.has(number)) {
      return [`${rel}:${lineNumber}: cites "rule ${raw}" but no rule ${number} exists`];
    }
    if (isRuleSource && number !== ownerNumber) {
      return [
        `${rel}:${lineNumber}: cross-rule citation "rule ${raw}" is prohibited; rule sources must be self-contained`,
      ];
    }
    return [];
  });
}

function crossRuleFilenameViolations(
  rel: string,
  lineNumber: number,
  line: string,
  citedNumbers: ReadonlySet<string>,
  numberedRuleNames: ReadonlyMap<string, string>,
  ownerNumber: string | undefined
): string[] {
  const normalizedLine = line.toLowerCase();
  return [...numberedRuleNames].flatMap(([number, name]) => {
    if (number === ownerNumber || citedNumbers.has(number)) {
      return [];
    }
    const stem = name.slice(0, -path.extname(name).length);
    return normalizedLine.includes(name) || normalizedLine.includes(stem)
      ? [
          `${rel}:${lineNumber}: cross-rule filename "${name}" is prohibited; rule sources must be self-contained`,
        ]
      : [];
  });
}

export function check(root = ROOT): void {
  const ruleDir = path.join(root, ".claude", "rules");
  const validNumbers = new Set<string>();
  const numberedRuleNames = new Map<string, string>();
  for (const name of fs.readdirSync(ruleDir)) {
    const prefix = numberedRulePrefix(name);
    if (prefix !== undefined) {
      validNumbers.add(prefix);
      numberedRuleNames.set(prefix, name);
    }
  }
  assert(validNumbers.size > 0, "no numbered .claude/rules/NN-*.md files found");

  const scanRoots = [".claude/rules", ".claude/skills", ".codex/rules", ".agents/skills"];
  const scanExtensions = [".md", ".rules"];
  const extraFiles = ["AGENTS.md"];
  const worktreeFiles = gitFiles(root).filter((file) => fs.existsSync(path.join(root, file)));
  const violations: string[] = [];

  function scanText(rel: string, text: string): void {
    const isRuleSource = rel.startsWith(".claude/rules/") && rel.endsWith(".md");
    const ownerNumber = isRuleSource ? numberedRulePrefix(path.basename(rel)) : undefined;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? "";
      const rawNumbers = ruleCitationNumbers(line);
      const citedNumbers = new Set(rawNumbers.map((raw) => raw.padStart(2, "0")));
      violations.push(
        ...citationNumberViolations(
          rel,
          index + 1,
          rawNumbers,
          validNumbers,
          isRuleSource,
          ownerNumber
        )
      );
      if (isRuleSource) {
        violations.push(
          ...crossRuleFilenameViolations(
            rel,
            index + 1,
            line,
            citedNumbers,
            numberedRuleNames,
            ownerNumber
          )
        );
      }
    }
  }

  function walk(dir: string): void {
    for (const rel of worktreeFiles) {
      if (
        (rel === dir || rel.startsWith(`${dir}/`)) &&
        scanExtensions.some((ext) => rel.endsWith(ext))
      ) {
        scanText(rel, fs.readFileSync(path.join(root, rel), "utf8"));
      }
    }
  }

  for (const scanRoot of scanRoots) {
    walk(scanRoot);
  }
  for (const file of extraFiles) {
    if (worktreeFiles.includes(file)) {
      scanText(file, fs.readFileSync(path.join(root, file), "utf8"));
    }
  }

  assert(violations.length === 0, `rule citation violations found:\n${violations.join("\n")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  check();
  ok("RULE_CITATIONS_OK");
}
