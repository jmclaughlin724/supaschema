#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { arrayOf, at, stringsOf } from "../../lib/json.mts";
import { assert, ok } from "../lib/assertions.mts";
import { run } from "../lib/process.mts";
import { ROOT, readJson } from "../lib/repository.mts";

const nonCode = new Set([
  "editorconfig",
  "gitattributes",
  "gitignore",
  "gitkeep",
  "license",
  "nvmrc",
  "prettierignore",
  "png",
  "snap",
  "svg",
  "tgz",
  "txt",
]);
const ignoredFiles = new Set(["package-lock.json", "uv.lock"]);

function extensionFor(file: string): string {
  const basename = path.basename(file).toLowerCase();
  if (basename === "dockerfile") {
    return "dockerfile";
  }
  const extension = path.extname(file).slice(1).toLowerCase();
  if (extension) {
    return extension;
  }
  if (basename.startsWith(".")) {
    return basename.slice(1);
  }
  return "";
}

export function check(root = ROOT): string {
  const config = readJson("lsp-soleaux.json", root);
  const mapped = new Set<string>();
  for (const server of arrayOf(at(config, "servers"))) {
    for (const extension of stringsOf(at(server, "extensions"))) {
      mapped.add(extension.toLowerCase());
    }
  }

  const trackedFiles = run("git", ["ls-files", "-z", "--cached"], {}, root)
    .stdout.split("\0")
    .filter(Boolean);

  for (const file of trackedFiles) {
    if (ignoredFiles.has(path.basename(file))) {
      continue;
    }
    const extension = extensionFor(file);
    if (!extension) {
      continue;
    }
    assert(
      mapped.has(extension) || nonCode.has(extension),
      `tracked extension .${extension} is not mapped in lsp-soleaux.json`
    );
  }

  return "LSP_COVERAGE_OK";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  ok(check());
}
