#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { collectRepoFiles } from "./lib/repo-files.mts";

const roots = process.argv.slice(2);
const files = collectRepoFiles(roots.length > 0 ? roots : ["."], ".toml");

if (files.length > 0) {
  execFileSync("taplo", ["format", ...files], { stdio: "inherit" });
}

process.stdout.write(`taplo: formatted ${files.length} TOML file(s)\n`);
