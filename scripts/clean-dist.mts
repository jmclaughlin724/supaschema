import { rm } from "node:fs/promises";
import { resolve, sep } from "node:path";

const root = process.cwd();
const dist = resolve(root, "dist");

if (!dist.startsWith(`${root}${sep}`)) {
  throw new Error(`refusing to clean dist outside repository: ${dist}`);
}

await rm(dist, { force: true, recursive: true });
