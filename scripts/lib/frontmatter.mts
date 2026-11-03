export type Frontmatter = Map<string, string | string[]>;

interface FrontmatterCursor {
  currentList: string | undefined;
  index: number;
}

interface ScalarLine {
  key: string;
  value: string;
}

export function parseFrontmatter(
  text: string,
  sourcePath: string
): { body: string; frontmatter: Frontmatter } {
  const lines = splitLines(text);
  if (lines[0] !== "---") {
    throw new Error(`frontmatter source must start with frontmatter: ${sourcePath}`);
  }
  const frontmatter: Frontmatter = new Map();
  let currentList: string | undefined;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line === "---") {
      return {
        body: lines.slice(index + 1).join("\n"),
        frontmatter,
      };
    }
    const parsed = readFrontmatterLine(lines, index, frontmatter, currentList);
    currentList = parsed.currentList;
    index = parsed.index;
  }
  throw new Error(`frontmatter is not closed: ${sourcePath}`);
}

export function scalar(frontmatter: Frontmatter, key: string): string | undefined {
  const value = frontmatter.get(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function list(frontmatter: Frontmatter, key: string): string[] {
  const value = frontmatter.get(key);
  return Array.isArray(value) ? value : [];
}

function readFrontmatterLine(
  lines: readonly string[],
  index: number,
  frontmatter: Frontmatter,
  currentList: string | undefined
): FrontmatterCursor {
  const line = lines[index] ?? "";
  const listItem = readListItem(line);
  if (currentList && listItem !== undefined) {
    const items = frontmatter.get(currentList);
    if (!Array.isArray(items)) {
      throw new Error(`frontmatter list ${currentList} is not open`);
    }
    items.push(unquote(listItem));
    return { currentList, index };
  }
  const scalarLine = readScalarLine(line);
  if (scalarLine !== undefined) {
    return readFrontmatterScalar(lines, index, frontmatter, scalarLine);
  }
  const listStart = readListStart(line);
  if (listStart !== undefined) {
    frontmatter.set(listStart, []);
    return { currentList: listStart, index };
  }
  return { currentList, index };
}

function readFrontmatterScalar(
  lines: readonly string[],
  index: number,
  frontmatter: Frontmatter,
  scalarLine: ScalarLine
): FrontmatterCursor {
  const { key, value } = scalarLine;
  if (value === "|") {
    const block = readBlockScalar(lines, index + 1);
    frontmatter.set(key, block.value);
    return { currentList: undefined, index: block.end - 1 };
  }
  if (value === "") {
    frontmatter.set(key, []);
    return { currentList: key, index };
  }
  frontmatter.set(key, unquote(value));
  return { currentList: undefined, index };
}

function readBlockScalar(lines: readonly string[], start: number): { end: number; value: string } {
  const block: string[] = [];
  let end = start;
  for (; end < lines.length; end += 1) {
    const line = lines[end] ?? "";
    if (line === "---" || (isRootScalarStart(line) && block.length > 0)) {
      break;
    }
    block.push(line);
  }
  const indents = block
    .filter((line) => line.trim().length > 0)
    .map((line) => leadingWhitespaceLength(line));
  const indent = indents.length > 0 ? Math.min(...indents) : 0;
  return {
    end,
    value: block
      .map((line) => line.slice(indent))
      .join("\n")
      .trim(),
  };
}

function readListItem(line: string): string | undefined {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("- ")) {
    return;
  }
  return trimmed.slice(2).trim();
}

function readListStart(line: string): string | undefined {
  const trimmed = line.trim();
  if (!trimmed.endsWith(":")) {
    return;
  }
  const key = trimmed.slice(0, -1);
  return isBareKey(key) ? key : undefined;
}

function readScalarLine(line: string): ScalarLine | undefined {
  const colon = line.indexOf(":");
  if (colon <= 0) {
    return;
  }
  const key = line.slice(0, colon);
  if (!isBareKey(key)) {
    return;
  }
  return {
    key,
    value: line.slice(colon + 1).trim(),
  };
}

function isRootScalarStart(line: string): boolean {
  const colon = line.indexOf(":");
  return colon > 0 && !isWhitespace(line[0] ?? "") && isBareKey(line.slice(0, colon));
}

function isBareKey(value: string): boolean {
  if (value.length === 0 || !isAsciiLetter(value[0] ?? "")) {
    return false;
  }
  return [...value].every(isBareKeyChar);
}

function isBareKeyChar(char: string): boolean {
  return isAsciiLetter(char) || isDigit(char);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed[0] === `"` && trimmed.at(-1) === `"`) ||
      (trimmed[0] === "'" && trimmed.at(-1) === "'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function leadingWhitespaceLength(value: string): number {
  let count = 0;
  for (const char of value) {
    if (!isWhitespace(char)) {
      break;
    }
    count += 1;
  }
  return count;
}

function splitLines(value: string): string[] {
  return value.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

function isWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";
}

function isAsciiLetter(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}
