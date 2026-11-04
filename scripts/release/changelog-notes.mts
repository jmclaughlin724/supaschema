#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { at, parseJson } from "../lib/json.mts";

interface NotesOptions {
  changelog: string;
  out: string | undefined;
  version: string | undefined;
}

function normalizeNewlines(text: string): string {
  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function isDigit(char: string): boolean {
  return char >= "0" && char <= "9";
}

function isIsoDate(value: string): boolean {
  if (
    value.length !== 10 ||
    value[4] !== "-" ||
    value[7] !== "-" ||
    ![...value.slice(0, 4)].every(isDigit) ||
    ![...value.slice(5, 7)].every(isDigit) ||
    ![...value.slice(8, 10)].every(isDigit)
  ) {
    return false;
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function trimBlankEdges(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") {
    start += 1;
  }
  while (end > start && lines[end - 1].trim() === "") {
    end -= 1;
  }
  return lines.slice(start, end);
}

export function extractChangelogEntry(changelogText: string, version: unknown) {
  if (typeof version !== "string" || version.length === 0) {
    throw new Error("package.json version must be set before extracting release notes");
  }

  const lines = normalizeNewlines(changelogText).split("\n");
  const firstVersionIndex = lines.findIndex((line) => line.startsWith("## "));
  if (firstVersionIndex === -1) {
    throw new Error("CHANGELOG.md must contain a version heading");
  }

  const heading = lines[firstVersionIndex];
  const headingPrefix = `## ${version} (`;
  if (!(heading.startsWith(headingPrefix) && heading.endsWith(")"))) {
    throw new Error(`CHANGELOG.md first version heading must be "## ${version} (YYYY-MM-DD)"`);
  }

  const date = heading.slice(headingPrefix.length, -1);
  if (!isIsoDate(date)) {
    throw new Error(`CHANGELOG.md version ${version} date must be YYYY-MM-DD`);
  }

  const nextVersionIndex = lines.findIndex(
    (line, index) => index > firstVersionIndex && line.startsWith("## ")
  );
  const rawBody = lines.slice(
    firstVersionIndex + 1,
    nextVersionIndex === -1 ? lines.length : nextVersionIndex
  );
  const body = trimBlankEdges(rawBody).join("\n");
  if (body.trim().length === 0) {
    throw new Error(`CHANGELOG.md version ${version} entry must include release notes`);
  }

  return { body, date, heading, version };
}

function readPackageVersion(): unknown {
  return at(parseJson(readFileSync("package.json", "utf8")), "version");
}

function parseArgs(argv: string[]): NotesOptions {
  const options: NotesOptions = {
    changelog: "CHANGELOG.md",
    out: undefined,
    version: undefined,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--version") {
      options.version = argv[index + 1];
      index += 1;
    } else if (arg === "--out" || arg === "--notes-file") {
      options.out = argv[index + 1];
      index += 1;
    } else if (arg === "--changelog") {
      options.changelog = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const version = options.version ?? readPackageVersion();
  const entry = extractChangelogEntry(readFileSync(options.changelog, "utf8"), version);
  const notes = `${entry.body}\n`;

  if (options.out) {
    writeFileSync(options.out, notes);
  } else {
    process.stdout.write(notes);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `RELEASE_CHANGELOG_NOTES_FAILED ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}
