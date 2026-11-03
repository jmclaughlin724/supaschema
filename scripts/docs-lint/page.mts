import { toString as nodeText } from "mdast-util-to-string";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import { at } from "../lib/json.mts";
import type { DocsViolation } from "./check-standard.mts";
import { inspectAdjacentCallouts, inspectImageFrame, inspectMdxNode } from "./components.mts";
import { readFrontmatter } from "./frontmatter.mts";
import { addLinkViolation, inspectImageSrc, isHttpUrl } from "./links.mts";
import { isDigit } from "./paths.mts";

const COMPARISON_PREFIX = "docs/comparisons/";
const GENERIC_LINK_TEXT = new Set([
  "click here",
  "here",
  "learn more",
  "read more",
  "this",
  "this page",
]);

const TITLE_CASE_WORD_ALLOWLIST = new Set([
  "AGENTS.md",
  "API",
  "CI",
  "CLI",
  "Codex",
  "GitHub",
  "JSON",
  "Blume",
  "MCP",
  "Node.js",
  "PostgreSQL",
  "RLS",
  "SQL",
  "SUPA",
  "Supabase",
  "TypeScript",
  "URL",
  "URLs",
  "Zod",
]);

const markdownProcessor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm);
const mdxProcessor = unified()
  .use(remarkParse)
  .use(remarkFrontmatter, ["yaml"])
  .use(remarkGfm)
  .use(remarkMdx);

export type DocsTree = ReturnType<typeof mdxProcessor.parse>;

interface DocsMdxAttributeExpression {
  readonly type: string;
  readonly value: string;
}

interface DocsMdxAttribute {
  readonly name?: string;
  readonly position?: DocsTree["position"];
  readonly type: string;
  readonly value?: DocsMdxAttributeExpression | string | null;
}

export interface DocsNode {
  readonly alt?: string | null;
  readonly attributes?: readonly DocsMdxAttribute[];
  readonly children?: readonly DocsNode[];
  readonly depth?: number;
  readonly lang?: string | null;
  readonly meta?: string | null;
  readonly name?: string | null;
  readonly position?: DocsTree["position"];
  readonly type: string;
  readonly url?: string;
  readonly value?: string;
}

const lineOf = (node: DocsNode) => node.position?.start?.line ?? 1;

const splitWhitespace = (value: string) => {
  const words: string[] = [];
  let current = "";
  for (const char of value) {
    if (isWhitespace(char)) {
      if (current.length > 0) {
        words.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) {
    words.push(current);
  }
  return words;
};

const collapseWhitespace = (value: string) => splitWhitespace(value).join(" ");

const trimWordEdgePunctuation = (word: string) => {
  let start = 0;
  let end = word.length;
  while (start < end && !isWordEdgeChar(word[start] ?? "")) {
    start += 1;
  }
  while (end > start && !isWordEdgeChar(word[end - 1] ?? "")) {
    end -= 1;
  }
  return word.slice(start, end);
};

const isWhitespace = (char: string) =>
  char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";

const isWordEdgeChar = (char: string) =>
  isAsciiLetter(char) || isDigit(char) || char === "_" || char === "." || char === "-";

const isAsciiLetter = (char: string) => {
  const code = char.charCodeAt(0);
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
};

const isUppercaseAscii = (char: string) => {
  const code = char.charCodeAt(0);
  return code >= 65 && code <= 90;
};

const isLowercaseAscii = (char: string) => {
  const code = char.charCodeAt(0);
  return code >= 97 && code <= 122;
};

const isLowercaseOrDigit = (char: string) => isLowercaseAscii(char) || isDigit(char);

const isTitleCaseWord = (word: string) =>
  word.length >= 2 && isUppercaseAscii(word[0] ?? "") && isLowercaseAscii(word[1] ?? "");

export function inspectDocsPage(text: string, displayFile: string, violations: DocsViolation[]) {
  const processor = displayFile.endsWith(".mdx") ? mdxProcessor : markdownProcessor;

  let tree: DocsTree;
  try {
    tree = processor.parse(text);
  } catch (error) {
    const line = at(error, "line");
    violations.push({
      file: displayFile,
      line: typeof line === "number" ? line : 1,
      msg: error instanceof Error ? error.message : String(error),
      rule: "parse",
    });
    return;
  }

  const frontmatter = readFrontmatter(tree, displayFile, violations);

  visit(tree, (node) => {
    inspectDocNode(node, displayFile, violations);
  });
  visitWithParents(tree, (node, ancestors) => {
    inspectAdjacentCallouts(node, displayFile, violations);
    inspectImageFrame(node, ancestors, displayFile, violations);
  });
  inspectComparisonPage(tree, displayFile, violations);

  return frontmatter;
}

function inspectDocNode(node: DocsNode, displayFile: string, violations: DocsViolation[]) {
  inspectHeading(node, displayFile, violations);
  inspectCodeFence(node, displayFile, violations);
  inspectMarkdownLink(node, displayFile, violations);
  inspectMdxNode(node, displayFile, violations);
}

function inspectComparisonPage(tree: DocsNode, displayFile: string, violations: DocsViolation[]) {
  if (!(displayFile.startsWith(COMPARISON_PREFIX) && displayFile.endsWith(".mdx"))) {
    return;
  }
  if (!hasVerificationDate(nodeText(tree))) {
    violations.push({
      file: displayFile,
      line: 1,
      msg: "comparison pages must include `Last verified YYYY-MM-DD` for external claims",
      rule: "comparison-claim",
    });
  }
  if (!hasSourcedSection(tree)) {
    violations.push({
      file: displayFile,
      line: 1,
      msg: "comparison pages must include a Sources section with at least one outbound link",
      rule: "comparison-claim",
    });
  }
}

function hasVerificationDate(text: string) {
  const marker = "Last verified ";
  let index = text.indexOf(marker);
  while (index !== -1) {
    if (isIsoDate(text.slice(index + marker.length, index + marker.length + 10))) {
      return true;
    }
    index = text.indexOf(marker, index + 1);
  }
  return false;
}

function isIsoDate(value: string) {
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
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function hasSourcedSection(tree: DocsNode) {
  const children = tree.children ?? [];
  const headingIndex = children.findIndex(
    (node) => node.type === "heading" && node.depth === 2 && nodeText(node) === "Sources"
  );
  if (headingIndex === -1) {
    return false;
  }
  for (const node of children.slice(headingIndex + 1)) {
    if (node.type === "heading" && node.depth !== undefined && node.depth <= 2) {
      break;
    }
    if (hasOutboundLink(node)) {
      return true;
    }
  }
  return false;
}

function hasOutboundLink(node: DocsNode) {
  let found = false;
  visit(node, (child) => {
    if (child.type === "link" && typeof child.url === "string" && isHttpUrl(child.url)) {
      found = true;
    }
  });
  return found;
}

function inspectHeading(node: DocsNode, displayFile: string, violations: DocsViolation[]) {
  if (node.type !== "heading") {
    return;
  }
  const headingText = nodeText(node);
  if (node.depth === 1) {
    violations.push({
      file: displayFile,
      line: lineOf(node),
      msg: "drop the body `# ` heading - the frontmatter `title` is the page H1; start in-page headings at `##`",
      rule: "body-h1",
    });
  }
  if (node.depth !== undefined && node.depth >= 2 && isObviousTitleCaseHeading(node, headingText)) {
    violations.push({
      file: displayFile,
      line: lineOf(node),
      msg: `heading "${headingText}" should use sentence case unless it is a command, acronym, code symbol, product name, or diagnostic code`,
      rule: "heading-case",
    });
  }
}

function inspectCodeFence(node: DocsNode, displayFile: string, violations: DocsViolation[]) {
  if (node.type !== "code") {
    return;
  }
  if (typeof node.lang !== "string" || node.lang.trim().length === 0) {
    violations.push({
      file: displayFile,
      line: lineOf(node),
      msg: "add a code fence language tag (use `text` for terminal output, diagrams, and plain text)",
      rule: "code-fence-language",
    });
  }
  if (typeof node.meta === "string" && node.meta.includes("theme={null}")) {
    violations.push({
      file: displayFile,
      line: lineOf(node),
      msg: "remove `theme={null}` from the code fence",
      rule: "fence-artifact",
    });
  }
}

function inspectMarkdownLink(node: DocsNode, displayFile: string, violations: DocsViolation[]) {
  if ((node.type === "link" || node.type === "definition") && typeof node.url === "string") {
    addLinkViolation(violations, displayFile, lineOf(node), node.url);
  }
  if (node.type === "link") {
    inspectLinkText(node, displayFile, violations);
  }
  if (node.type === "image") {
    inspectImage(node, displayFile, violations);
  }
}

function inspectLinkText(node: DocsNode, displayFile: string, violations: DocsViolation[]) {
  const text = collapseWhitespace(nodeText(node).trim().toLowerCase());
  if (!GENERIC_LINK_TEXT.has(text)) {
    return;
  }
  violations.push({
    file: displayFile,
    line: lineOf(node),
    msg: `link text "${text}" is too generic; use descriptive text that names the destination`,
    rule: "link-text",
  });
}

function inspectImage(node: DocsNode, displayFile: string, violations: DocsViolation[]) {
  if (typeof node.alt !== "string" || node.alt.trim().length === 0) {
    violations.push({
      file: displayFile,
      line: lineOf(node),
      msg: "images need descriptive alt text",
      rule: "image-alt",
    });
  }
  inspectImageSrc(node.url, displayFile, lineOf(node), violations);
}

function isObviousTitleCaseHeading(node: DocsNode, text: string) {
  if ((node.children ?? []).some((child) => child.type === "inlineCode")) {
    return false;
  }
  const normalized = text.trim();
  if (
    normalized.length === 0 ||
    !normalized.includes(" ") ||
    isLowercaseOrDigit(normalized[0] ?? "") ||
    normalized.startsWith("SUPA_")
  ) {
    return false;
  }

  const words = splitWhitespace(normalized).map(trimWordEdgePunctuation).filter(Boolean);
  if (words.length < 2) {
    return false;
  }
  if (
    words
      .slice(1)
      .some(
        (word) =>
          isLowercaseAscii(word[0] ?? "") &&
          !["and", "or", "to", "of", "in", "with", "for"].includes(word)
      )
  ) {
    return false;
  }

  const titleWords = words.filter(
    (word) => isTitleCaseWord(word) && !TITLE_CASE_WORD_ALLOWLIST.has(word)
  );
  return titleWords.length >= 2;
}

function visitWithParents(
  node: DocsNode,
  visitor: (node: DocsNode, ancestors: readonly DocsNode[]) => void,
  ancestors: readonly DocsNode[] = []
) {
  visitor(node, ancestors);
  for (const child of node.children ?? []) {
    if (child && typeof child === "object") {
      visitWithParents(child, visitor, [...ancestors, node]);
    }
  }
}
