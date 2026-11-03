import type { DocsViolation } from "./check-standard.mts";
import { addLinkViolation, inspectImageSrc } from "./links.mts";
import type { DocsNode } from "./page.mts";

const CALLOUT_DIRECTIVES = new Set(["danger", "info", "note", "success", "tip", "warning"]);
const DIRECTIVE_FENCE = ":::";

const lineOf = (node: Pick<DocsNode, "position">) => node.position?.start?.line ?? 1;

const isWhitespace = (char: string) =>
  char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f";

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

const isMdxJsxNode = (node: DocsNode) =>
  node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";

const isMdxJsxNamed = (node: DocsNode, name: string) => isMdxJsxNode(node) && node.name === name;

const getMdxAttribute = (node: DocsNode, name: string) =>
  (node.attributes ?? []).find(
    (attribute) => attribute.type === "mdxJsxAttribute" && attribute.name === name
  );

const mdxAttributeString = (node: DocsNode, name: string) => {
  const attribute = getMdxAttribute(node, name);
  return typeof attribute?.value === "string" ? attribute.value : undefined;
};

const mdxAttributeNumber = (node: DocsNode, name: string) => {
  const attribute = getMdxAttribute(node, name);
  if (!attribute) {
    return;
  }
  if (typeof attribute.value === "number") {
    return attribute.value;
  }
  if (
    attribute.value &&
    typeof attribute.value === "object" &&
    attribute.value.type === "mdxJsxAttributeValueExpression"
  ) {
    const parsed = Number(attribute.value.value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof attribute.value === "string") {
    const parsed = Number(attribute.value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
};

const wordCount = (text: string) => splitWhitespace(text.trim()).length;

const childText = (node: DocsNode): string => {
  if (typeof node.value === "string") {
    return node.value;
  }
  return (node.children ?? []).map(childText).join(" ");
};

const isWhitespaceText = (node: DocsNode) =>
  node.type === "text" && node.value?.trim().length === 0;

const collectMdxDescendants = (node: DocsNode, name: string, matches: DocsNode[] = []) => {
  for (const child of node.children ?? []) {
    if (isMdxJsxNamed(child, name)) {
      matches.push(child);
    }
    collectMdxDescendants(child, name, matches);
  }
  return matches;
};

export function inspectMdxNode(node: DocsNode, displayFile: string, violations: DocsViolation[]) {
  if (!isMdxJsxNode(node)) {
    return;
  }
  if (node.name === "img") {
    inspectImgElement(node, displayFile, violations);
  }
  if (node.name === "Columns") {
    inspectColumnsElement(node, displayFile, violations);
  }
  if (node.name === "CardGroup") {
    inspectCardGroupElement(node, displayFile, violations);
  }
  if (node.name === "Card") {
    inspectCardElement(node, displayFile, violations);
  }
  for (const attribute of node.attributes ?? []) {
    if (
      attribute.type === "mdxJsxAttribute" &&
      attribute.name === "href" &&
      typeof attribute.value === "string"
    ) {
      addLinkViolation(violations, displayFile, lineOf(attribute), attribute.value);
    }
    if (
      attribute.type === "mdxJsxAttribute" &&
      (attribute.name === "src" || attribute.name === "img") &&
      typeof attribute.value === "string"
    ) {
      inspectImageSrc(attribute.value, displayFile, lineOf(attribute), violations);
    }
  }
}

function inspectColumnsElement(node: DocsNode, displayFile: string, violations: DocsViolation[]) {
  if (collectMdxDescendants(node, "Card").length === 0) {
    return;
  }
  violations.push({
    file: displayFile,
    line: lineOf(node),
    msg: "use <CardGroup> for docs card grids so the repo has one card layout owner",
    rule: "card-grid",
  });
}

function inspectCardGroupElement(node: DocsNode, displayFile: string, violations: DocsViolation[]) {
  const cols = mdxAttributeNumber(node, "cols") ?? 2;
  const cards = collectMdxDescendants(node, "Card");
  if (![2, 3].includes(cols)) {
    violations.push({
      file: displayFile,
      line: lineOf(node),
      msg: "<CardGroup> must use cols={2} or cols={3}",
      rule: "card-grid",
    });
    return;
  }
  if (cols === 3 && cards.length !== 3) {
    violations.push({
      file: displayFile,
      line: lineOf(node),
      msg: "<CardGroup cols={3}> must contain exactly three direct <Card> children",
      rule: "card-grid",
    });
  }
  if (cols === 2 && cards.length > 4) {
    violations.push({
      file: displayFile,
      line: lineOf(node),
      msg: "<CardGroup cols={2}> must contain at most four direct <Card> children",
      rule: "card-grid",
    });
  }
}

function inspectCardElement(node: DocsNode, displayFile: string, violations: DocsViolation[]) {
  for (const attributeName of ["title", "icon"]) {
    if (typeof mdxAttributeString(node, attributeName) !== "string") {
      violations.push({
        file: displayFile,
        line: lineOf(node),
        msg: `<Card> must include a string ${attributeName} attribute`,
        rule: "card",
      });
    }
  }
  const bodyWords = wordCount(childText(node));
  if (bodyWords > 35) {
    violations.push({
      file: displayFile,
      line: lineOf(node),
      msg: `<Card> body is ${bodyWords} words; keep card bodies to one short sentence (35 words max)`,
      rule: "card",
    });
  }
}

function inspectImgElement(node: DocsNode, displayFile: string, violations: DocsViolation[]) {
  const attributes = new Map<string | undefined, unknown>(
    (node.attributes ?? [])
      .filter((attribute) => attribute.type === "mdxJsxAttribute")
      .map((attribute) => [attribute.name, attribute.value])
  );
  const alt = attributes.get("alt");
  if (typeof alt !== "string" || alt.trim().length === 0) {
    violations.push({
      file: displayFile,
      line: lineOf(node),
      msg: "`<img>` elements need descriptive alt text",
      rule: "image-alt",
    });
  }
  const src = attributes.get("src");
  if (typeof src === "string") {
    inspectImageSrc(src, displayFile, lineOf(node), violations);
  }
}

export function inspectImageFrame(
  node: DocsNode,
  ancestors: readonly DocsNode[],
  displayFile: string,
  violations: DocsViolation[]
) {
  if (node.type === "image") {
    violations.push({
      file: displayFile,
      line: lineOf(node),
      msg: 'use <Frame><img src="/images/..." alt="..." /></Frame> instead of markdown image syntax',
      rule: "image-frame",
    });
    return;
  }
  if (!isMdxJsxNode(node) || node.name !== "img") {
    return;
  }
  const isInsideFrame = ancestors.some(
    (ancestor) => isMdxJsxNode(ancestor) && ancestor.name === "Frame"
  );
  if (!isInsideFrame) {
    violations.push({
      file: displayFile,
      line: lineOf(node),
      msg: "`<img>` elements in docs must be wrapped in a <Frame>",
      rule: "image-frame",
    });
  }
}

const opensCalloutDirective = (node: DocsNode) => {
  if (node.type !== "paragraph") {
    return false;
  }
  const [first] = node.children ?? [];
  if (first?.type !== "text" || !first.value?.startsWith(DIRECTIVE_FENCE)) {
    return false;
  }
  const [openingLine] = first.value.slice(DIRECTIVE_FENCE.length).split("\n");
  const [directive] = openingLine.split("[");
  return CALLOUT_DIRECTIVES.has(directive.trim());
};

export function inspectAdjacentCallouts(
  node: DocsNode,
  displayFile: string,
  violations: DocsViolation[]
) {
  let previousCallout = false;
  for (const child of node.children ?? []) {
    if (isWhitespaceText(child)) {
      continue;
    }
    const currentCallout = opensCalloutDirective(child);
    if (currentCallout && previousCallout) {
      violations.push({
        file: displayFile,
        line: lineOf(child),
        msg: "do not stack callouts without intervening explanatory content",
        rule: "callout-spacing",
      });
    }
    previousCallout = currentCallout;
  }
}
