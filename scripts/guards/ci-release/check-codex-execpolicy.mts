#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexExecPolicyEntries } from "../../skills/codex-rules.mts";
import { assert, ok } from "../lib/assertions.mts";
import { gitTrackedFiles, ROOT } from "../lib/repository.mts";

function prefixMatchesCommand(pattern: readonly (string | string[])[], command: string): boolean {
  const words = shellWords(command);
  if (words.length < pattern.length) {
    return false;
  }
  return pattern.every((part, index) => {
    const word = words[index] ?? "";
    return Array.isArray(part) ? part.includes(word) : part === word;
  });
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote = "";
  let escaped = false;

  const pushWord = (): void => {
    if (word.length > 0) {
      words.push(word);
      word = "";
    }
  };

  for (const char of command) {
    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = "";
      } else {
        word += char;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (isWhitespace(char)) {
      pushWord();
      continue;
    }
    word += char;
  }
  pushWord();
  return words;
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

export function check(root = ROOT): void {
  const oldMirrorText = "Claude Markdown policy is mirrored as comments";
  const claudeRuleRoot = path.join(root, ".claude", "rules");
  const codexRuleRoot = path.join(root, ".codex", "rules");

  function trackedWorktreeFilesUnder(ruleRoot: string, extension: string): string[] {
    return gitTrackedFiles(root)
      .filter(
        (file) =>
          file.startsWith(`${ruleRoot}/`) &&
          file.endsWith(extension) &&
          fs.existsSync(path.join(root, file))
      )
      .sort((left, right) => Number(left > right) - Number(left < right));
  }

  function codexRulePathFor(sourceRelativePath: string): string {
    const relative = path.relative(claudeRuleRoot, path.join(root, sourceRelativePath));
    const parsed = path.parse(relative);
    return path.join(path.relative(root, codexRuleRoot), parsed.dir, `${parsed.name}.rules`);
  }

  for (const relativePath of trackedWorktreeFilesUnder(".codex/rules", ".rules")) {
    const text = fs.readFileSync(path.join(root, relativePath), "utf8");
    assert(
      !text.includes(oldMirrorText),
      `${relativePath} must not be a comment-only Markdown mirror`
    );
  }

  for (const sourceRelativePath of trackedWorktreeFilesUnder(".claude/rules", ".md")) {
    const sourcePath = path.join(root, sourceRelativePath);
    const entries = codexExecPolicyEntries(fs.readFileSync(sourcePath, "utf8"), sourceRelativePath);
    if (entries.length === 0) {
      continue;
    }

    const targetRelativePath = codexRulePathFor(sourceRelativePath);
    const targetPath = path.join(root, targetRelativePath);
    assert(fs.existsSync(targetPath), `${targetRelativePath} missing generated Codex rule`);

    const targetText = fs.readFileSync(targetPath, "utf8");
    assert(
      targetText.includes("prefix_rule("),
      `${targetRelativePath} must render codexExecPolicy as prefix_rule entries`
    );

    for (const [entryIndex, entry] of entries.entries()) {
      for (const command of entry.match) {
        assert(
          prefixMatchesCommand(entry.pattern, command),
          `${sourceRelativePath} codexExecPolicy[${entryIndex}] match does not match pattern: ${command}`
        );
      }
      for (const command of entry.not_match) {
        assert(
          !prefixMatchesCommand(entry.pattern, command),
          `${sourceRelativePath} codexExecPolicy[${entryIndex}] not_match matches pattern: ${command}`
        );
      }
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  check();
  ok("CODEX_EXECPOLICY_OK");
}
