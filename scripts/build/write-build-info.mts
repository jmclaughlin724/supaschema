import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { snapshotCommitSha } from "../release/snapshot-version.mts";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function git(args: readonly string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: root, maxBuffer: 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

const raw = await readFile(join(root, "package.json"), "utf8");
const version = JSON.parse(raw).version;
const commit = await git(["rev-parse", "HEAD"]);
const porcelain = await git(["status", "--porcelain"]);

const devSha = snapshotCommitSha(version);
const builtAt =
  devSha === null
    ? new Date().toISOString()
    : ((await git(["show", "-s", "--format=%cI", devSha])) ?? new Date().toISOString());

const stamp = {
  version: typeof version === "string" ? version : "0.0.0",
  commit,
  builtAt,
  dirty: porcelain === null ? null : porcelain.length > 0,
};

await writeFile(join(root, "dist", "build-info.json"), `${JSON.stringify(stamp, null, 2)}\n`);
