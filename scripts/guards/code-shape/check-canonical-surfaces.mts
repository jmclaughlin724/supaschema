#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { at, recordOf } from "../../lib/json.mts";
import {
  isCodeFile,
  jsTsExtensions,
  pythonExtensions,
  shellExtensions,
} from "../../lib/source-comments.mts";
import { assert, ok } from "../lib/assertions.mts";
import { exists, gitFiles, ROOT, readJson } from "../lib/repository.mts";
import { changeDisciplineViolations } from "./check-change-discipline.mts";
import { packageScriptViolations } from "./check-package-scripts.mts";
import { patternEngineViolations } from "./check-pattern-engine.mts";

export async function check(root = ROOT): Promise<void> {
  const packageJson = readJson("package.json", root);
  const files = gitFiles(root).filter((file) => exists(file, root));
  const codeFiles = files.filter(isCodeFile);
  const jsTsFiles = codeFiles.filter((file) => jsTsExtensions.has(path.extname(file)));
  const pythonFiles = codeFiles.filter((file) => pythonExtensions.has(path.extname(file)));
  const shellFiles = codeFiles.filter((file) => shellExtensions.has(path.extname(file)));
  const violations = [
    ...(await changeDisciplineViolations(codeFiles, jsTsFiles, pythonFiles, shellFiles, root)),
    ...(await patternEngineViolations(jsTsFiles, pythonFiles, shellFiles, root)),
    ...packageScriptViolations(recordOf(at(packageJson, "scripts"))),
  ];

  assert(
    violations.length === 0,
    `canonical surfaces guard failed:\n${violations.map((item) => `- ${item}`).join("\n")}`
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  check().then(() => ok("CANONICAL_SURFACES_OK"));
}
