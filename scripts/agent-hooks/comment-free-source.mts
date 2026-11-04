import fs from "node:fs";
import path from "node:path";
import { isRecord, type JsonRecord } from "../lib/json.mts";
import { isJsTsCodeFile, jsTsComments, type SourceComment } from "../lib/source-comments.mts";
import type { HookCheckResult } from "./hook-output.mts";
import type { HookPayload } from "./hook-runtime.mts";

interface HunkOperation {
  kind: "add" | "anchor" | "context" | "remove";
  line: string;
}

interface PatchTarget {
  hunk: HunkOperation[];
  isAddFile: boolean;
  moveDest?: string;
  rel: string;
}

interface PatchHeader {
  kind: "add" | "move" | "update";
  rel: string;
}

interface EditFields {
  newString: string;
  oldString: string;
  replaceAll: boolean;
}

const editTools = new Set(["Edit", "MultiEdit", "Write", "apply_patch"]);
const addHeader = "*** Add File: ";
const updateHeader = "*** Update File: ";
const moveHeader = "*** Move to: ";

export function commentFreeSource(
  payload: HookPayload,
  context: { root: string }
): HookCheckResult {
  const toolName = payload?.tool_name;
  if (!(typeof toolName === "string" && editTools.has(toolName))) {
    return {};
  }
  const input = payload?.tool_input;
  if (!isRecord(input)) {
    return {};
  }
  const reason = addedCommentReason(toolName, input, context.root);
  return reason ? { deny: reason } : {};
}

function addedCommentReason(toolName: string, input: JsonRecord, root: string): string | undefined {
  if (toolName === "Write") {
    return writeReason(input, root);
  }
  if (toolName === "Edit" || toolName === "MultiEdit") {
    return editReason(toolName, input, root);
  }
  return patchReason(input, root);
}

function writeReason(input: JsonRecord, root: string): string | undefined {
  const filePath = stringField(input, "file_path");
  const content = stringField(input, "content");
  if (filePath === undefined || content === undefined) {
    return;
  }
  const rel = repoRelative(filePath, root);
  if (!isJsTsCodeFile(rel)) {
    return;
  }
  return denyForAddedComments(rel, content, [readTextIfExists(path.resolve(root, rel))]);
}

function editReason(toolName: string, input: JsonRecord, root: string): string | undefined {
  const filePath = stringField(input, "file_path");
  if (filePath === undefined) {
    return;
  }
  const rel = repoRelative(filePath, root);
  if (!isJsTsCodeFile(rel)) {
    return;
  }
  const preText = readTextIfExists(path.resolve(root, rel));
  let postText = preText ?? "";
  for (const edit of collectEdits(toolName, input)) {
    postText = applyEdit(postText, edit);
  }
  return denyForAddedComments(rel, postText, [preText]);
}

function patchReason(input: JsonRecord, root: string): string | undefined {
  const command = stringField(input, "command");
  if (command === undefined) {
    return;
  }
  const reconstructions = new Map<string, string>();
  for (const target of patchCodeTargets(command, root)) {
    const reason = denyForPatchTarget(target, root, reconstructions);
    if (reason) {
      return reason;
    }
  }
}

function denyForPatchTarget(
  target: PatchTarget,
  root: string,
  reconstructions: Map<string, string>
): string | undefined {
  if (target.moveDest !== undefined) {
    const sourcePreText = patchPreText(target.rel, root, reconstructions);
    const destPreText = readTextIfExists(path.resolve(root, target.moveDest));
    const postText = applyHunk(sourcePreText ?? "", target.hunk);
    return denyForAddedComments(target.moveDest, postText, [sourcePreText, destPreText]);
  }
  if (target.isAddFile) {
    const postText = target.hunk
      .filter((operation) => operation.kind === "add")
      .map((operation) => operation.line)
      .join("\n");
    return denyForAddedComments(target.rel, postText, []);
  }
  const preText = patchPreText(target.rel, root, reconstructions);
  const postText = applyHunk(preText ?? "", target.hunk);
  reconstructions.set(target.rel, postText);
  return denyForAddedComments(target.rel, postText, [preText]);
}

function patchPreText(
  rel: string,
  root: string,
  reconstructions: Map<string, string>
): string | undefined {
  const carried = reconstructions.get(rel);
  if (carried !== undefined) {
    return carried;
  }
  return readTextIfExists(path.resolve(root, rel));
}

function denyForAddedComments(
  rel: string,
  postText: string,
  preTexts: (string | undefined)[]
): string | undefined {
  const added = addedComments(rel, postText, preTexts);
  return added.length > 0 ? denyMessage(rel, added) : undefined;
}

function addedComments(
  fileName: string,
  postText: string,
  preTexts: (string | undefined)[] | string | undefined
): SourceComment[] {
  let preTextList: (string | undefined)[];
  if (preTexts === undefined) {
    preTextList = [];
  } else if (Array.isArray(preTexts)) {
    preTextList = preTexts;
  } else {
    preTextList = [preTexts];
  }
  const preComments = preTextList.flatMap((text) => jsTsComments(fileName, text ?? ""));
  const preCounts = commentTextCounts(preComments);
  const added: SourceComment[] = [];
  for (const comment of jsTsComments(fileName, postText)) {
    const remaining = preCounts.get(comment.text) ?? 0;
    if (remaining > 0) {
      preCounts.set(comment.text, remaining - 1);
    } else {
      added.push(comment);
    }
  }
  return added;
}

function commentTextCounts(comments: readonly SourceComment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const comment of comments) {
    counts.set(comment.text, (counts.get(comment.text) ?? 0) + 1);
  }
  return counts;
}

function collectEdits(toolName: string, input: JsonRecord): EditFields[] {
  if (toolName === "MultiEdit") {
    return readArray(input.edits).map((edit) => editFields(edit));
  }
  return [editFields(input)];
}

function editFields(edit: unknown): EditFields {
  return {
    oldString: stringField(edit, "old_string") ?? "",
    newString: stringField(edit, "new_string") ?? "",
    replaceAll: isRecord(edit) && edit.replace_all === true,
  };
}

function applyEdit(text: string, edit: EditFields): string {
  if (edit.oldString === "") {
    return text;
  }
  return edit.replaceAll
    ? text.replaceAll(edit.oldString, edit.newString)
    : text.replace(edit.oldString, edit.newString);
}

function applyHunk(preText: string, hunk: readonly HunkOperation[]): string {
  const preLines = preText.split("\n");
  const postLines: string[] = [];
  let preIndex = 0;

  for (const operation of hunk) {
    if (operation.kind === "anchor") {
      const anchored = findAnchor(preLines, operation.line, preIndex);
      if (anchored >= 0) {
        postLines.push(...preLines.slice(preIndex, anchored + 1));
        preIndex = anchored + 1;
      }
    } else if (operation.kind === "context" || operation.kind === "remove") {
      const found = findLine(preLines, operation.line, preIndex);
      if (found >= 0) {
        postLines.push(
          ...preLines.slice(preIndex, operation.kind === "remove" ? found : found + 1)
        );
        preIndex = found + 1;
      }
    } else if (operation.kind === "add") {
      postLines.push(operation.line);
    }
  }

  postLines.push(...preLines.slice(preIndex));
  return postLines.join("\n");
}

function findLine(lines: readonly string[], line: string, startIndex: number): number {
  const direct = lines.indexOf(line, startIndex);
  if (direct >= 0 || line.length === 0) {
    return direct;
  }
  const stripped = line.startsWith(" ") ? line.slice(1) : line;
  return stripped === line ? -1 : lines.indexOf(stripped, startIndex);
}

function findAnchor(lines: readonly string[], anchor: string, startIndex: number): number {
  for (let index = startIndex; index < lines.length; index += 1) {
    if (lines[index].trim() === anchor) {
      return index;
    }
  }
  return -1;
}

function anchorText(line: string): string {
  const rest = line.slice(2).trim();
  const closing = rest.indexOf("@@");
  if (closing >= 0 && rest.slice(0, closing).trim().length > 0) {
    return rest.slice(closing + 2).trim();
  }
  return rest;
}

function patchCodeTargets(command: string, root: string): PatchTarget[] {
  const targets: PatchTarget[] = [];
  let current: PatchTarget | undefined;
  const flush = () => {
    if (current !== undefined) {
      targets.push(current);
      current = undefined;
    }
  };
  for (const line of command.split("\n")) {
    const header = patchHeader(line, root);
    if (header !== undefined) {
      if (header.kind === "move") {
        if (current === undefined) {
          current = { rel: header.rel, hunk: [], isAddFile: false };
        } else {
          current.moveDest = header.rel;
        }
      } else {
        flush();
        current = { rel: header.rel, hunk: [], isAddFile: header.kind === "add" };
      }
      continue;
    }
    if (current === undefined) {
      continue;
    }
    const operation = hunkOperation(line, current.isAddFile);
    if (operation !== undefined) {
      current.hunk.push(operation);
    }
  }
  flush();
  return targets.filter((target) => isJsTsCodeFile(target.moveDest ?? target.rel));
}

function hunkOperation(line: string, isAddFile: boolean): HunkOperation | undefined {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    return { kind: "add", line: line.slice(1) };
  }
  if (line.startsWith("-") && !line.startsWith("---")) {
    return { kind: "remove", line: line.slice(1) };
  }
  if (isAddFile) {
    return;
  }
  if (line.startsWith("@@")) {
    const anchor = anchorText(line);
    return anchor.length > 0 ? { kind: "anchor", line: anchor } : undefined;
  }
  return { kind: "context", line };
}

function patchHeader(line: string, root: string): PatchHeader | undefined {
  if (line.startsWith(addHeader)) {
    return { kind: "add", rel: repoRelative(line.slice(addHeader.length).trim(), root) };
  }
  if (line.startsWith(updateHeader)) {
    return { kind: "update", rel: repoRelative(line.slice(updateHeader.length).trim(), root) };
  }
  if (line.startsWith(moveHeader)) {
    return { kind: "move", rel: repoRelative(line.slice(moveHeader.length).trim(), root) };
  }
}

function denyMessage(rel: string, added: readonly SourceComment[]): string {
  const first = added[0];
  const tally = added.length === 1 ? "a comment" : `${added.length} comments`;
  return `${rel}:${first.line}:${first.character}: tracked JS/TS source is comment-free (rule 07); this edit adds ${tally}. Move the explanation to an intent-carrying name, a diagnostic hint, a test name, or the owning rule.`;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = isRecord(value) ? value[key] : undefined;
  return typeof field === "string" ? field : undefined;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readTextIfExists(absolutePath: string): string | undefined {
  return fs.existsSync(absolutePath) ? fs.readFileSync(absolutePath, "utf8") : undefined;
}

function repoRelative(filePath: string, root: string): string {
  const posix = filePath.replaceAll("\\", "/");
  const absolute = path.isAbsolute(posix) ? posix : path.resolve(root, posix);
  return path.relative(root, absolute).replaceAll("\\", "/");
}
