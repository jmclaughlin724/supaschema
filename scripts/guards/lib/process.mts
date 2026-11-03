import { type SpawnSyncOptions, type SpawnSyncReturns, spawnSync } from "node:child_process";
import { fail } from "./assertions.mts";

export type RunOptions = Omit<SpawnSyncOptions, "cwd" | "encoding">;

export function run(
  command: string,
  args: readonly string[],
  options: RunOptions,
  root: string
): SpawnSyncReturns<string> {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}
