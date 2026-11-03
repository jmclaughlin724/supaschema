#!/usr/bin/env node
import nodeAssert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  resolveActionVersion,
  validateExactVersion,
} from "../../actions/run-supaschema-action.mjs";
import { at } from "../../lib/json.mts";
import { extractChangelogEntry } from "../../release/changelog-notes.mts";
import { assert, ok } from "../lib/assertions.mts";
import { ROOT, readJson, readText } from "../lib/repository.mts";

export function check(root = ROOT): void {
  const packageJson = readJson("package.json", root);
  const packageLock = readJson("package-lock.json", root);
  const version = at(packageJson, "version");

  assert(typeof version === "string" && version.length > 0, "package.json version must be set");
  assert(
    at(packageLock, "version") === version,
    `package-lock.json version must match package.json version ${version}`
  );
  assert(
    at(packageLock, "packages", "", "version") === version,
    `package-lock.json root package version must match package.json version ${version}`
  );

  const changelog = readText("CHANGELOG.md", root);
  try {
    extractChangelogEntry(changelog, version);
  } catch (error) {
    assert(false, error instanceof Error ? error.message : String(error));
  }

  const actionText = readText("action.yml", root);
  const action: unknown = parseYaml(actionText);
  const actionVersionInput = at(action, "inputs", "version");
  assert(actionVersionInput, "action.yml must declare inputs.version");
  assert(
    at(actionVersionInput, "default") === undefined,
    "action.yml inputs.version.default must stay unset; the runner defaults from package.json"
  );
  assert(
    resolveActionVersion(undefined) === version,
    "action version must default from package.json"
  );
  assert(validateExactVersion(version) === version, "package version must be exact");
  for (const invalid of ["latest", "next", "1", "1.2", "1.2.x"]) {
    nodeAssert.throws(() => validateExactVersion(invalid));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  check();
  ok("RELEASE_VERSION_SURFACES_OK");
}
