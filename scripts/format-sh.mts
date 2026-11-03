#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { print } from "sh-syntax";
import { collectRepoFiles } from "./lib/repo-files.mts";

const roots = process.argv.slice(2);
const files = collectRepoFiles(roots.length > 0 ? roots : ["."], ".sh");

let changed = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const formatted = await print(src, { filepath: file, indent: 2 });
  if (formatted !== src) {
    writeFileSync(file, formatted);
    changed += 1;
  }
}

process.stdout.write(`shfmt (sh-syntax): formatted ${changed} of ${files.length} shell file(s)\n`);
