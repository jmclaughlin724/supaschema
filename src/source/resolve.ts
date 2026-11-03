import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveConfig, type SupaschemaConfig } from "../config/schema.js";
import { MODEL_FORMAT_VERSION, stableJson } from "../hash.js";
import type { CurrentBaselineFingerprints } from "../migrations/status.js";
import { redactSecrets } from "../redaction.js";
import type { ExtractOptions, SchemaModel } from "../types.js";
import { extractSourceModel } from "./extract.js";

const execFileAsync = promisify(execFile);

export interface ResolvedSources {
  from: string;
  notice: string | undefined;
  to: string;
}

export function defaultTreeSource(config: SupaschemaConfig): string {
  return `dir:${config.schemaPaths[0] ?? "database/schemas"}`;
}

export function resolveMigrationsDir(
  flagValue: string | undefined,
  config: SupaschemaConfig
): string {
  return flagValue ?? config.migrationsDir;
}

export async function resolveSourceDefaults(
  options: { from?: string; to?: string },
  config: SupaschemaConfig,
  resolveDbUrl: () => Promise<string | undefined>,
  gitHeadExists: () => Promise<boolean> = defaultGitHeadExists
): Promise<ResolvedSources> {
  const defaulted: string[] = [];
  const to = options.to ?? defaultTreeSource(config);
  if (options.to === undefined) {
    defaulted.push(`--to ${to}`);
  }
  let from = options.from;
  if (from === undefined) {
    if (config.sources.from === "auto") {
      if (await gitHeadExists()) {
        from = "git:HEAD";
      } else {
        const databaseUrl = await resolveDbUrl();
        if (databaseUrl === undefined) {
          from = "empty:";
        } else {
          from = `database:${databaseUrl}`;
        }
      }
    } else {
      from = config.sources.from;
    }
    defaulted.push(`--from ${redactSecrets(from)}`);
  }
  const notice =
    defaulted.length > 0 ? `defaults: ${defaulted.join(" · ")} (flags override)\n` : undefined;
  return { from, notice, to };
}

export async function currentBaselineFingerprints(
  config: SupaschemaConfig,
  cwd: string = process.cwd()
): Promise<CurrentBaselineFingerprints> {
  const head = (await defaultGitHeadExists(cwd))
    ? await sourceFingerprint("git:HEAD", config, cwd)
    : undefined;
  const tree = await sourceFingerprint(defaultTreeSource(config), config, cwd);
  return {
    ...(head === undefined ? {} : { head }),
    ...(tree === undefined ? {} : { tree }),
  };
}

export async function sourceFingerprint(
  source: string,
  config: SupaschemaConfig,
  cwd: string
): Promise<string | undefined> {
  try {
    return (await extractGenerationSourceModel(source, { config, cwd })).fingerprint;
  } catch {
    const unreadableFallbackSourcesAreIgnoredWhileResolvingAlternatives = undefined;
    return unreadableFallbackSourcesAreIgnoredWhileResolvingAlternatives;
  }
}

const generationSourceModels = new Map<string, Promise<SchemaModel>>();

export async function extractGenerationSourceModel(
  source: string,
  options: ExtractOptions
): Promise<SchemaModel> {
  const cwd = options.cwd ?? process.cwd();
  const key = await commitScopedModelKey(source, cwd, options);
  if (key === undefined) {
    return extractSourceModel(source, options);
  }
  const memoized = generationSourceModels.get(key);
  if (memoized !== undefined) {
    return memoized;
  }
  const pending = extractSourceModel(source, options);
  generationSourceModels.set(key, pending);
  try {
    return await pending;
  } catch (error) {
    generationSourceModels.delete(key);
    throw error;
  }
}

async function commitScopedModelKey(
  source: string,
  cwd: string,
  options: ExtractOptions
): Promise<string | undefined> {
  if (!source.startsWith("git:")) {
    return;
  }
  const revision = await resolvedGitObject(source.slice("git:".length), cwd);
  if (revision === undefined) {
    return;
  }
  return stableJson([
    source,
    revision,
    cwd,
    MODEL_FORMAT_VERSION,
    stableJson(resolveConfig(options.config)),
    [...(options.excludeMigrationFiles ?? [])].sort(
      (left, right) => Number(left > right) - Number(left < right)
    ),
  ]);
}

async function resolvedGitObject(revision: string, cwd: string): Promise<string | undefined> {
  if (revision === "INDEX") {
    return;
  }
  try {
    const { stdout } = await execFileAsync("git", ["-C", cwd, "rev-parse", `${revision}^{tree}`], {
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  } catch {
    const unresolvableRevisionsAreExtractedWithoutMemoization = undefined;
    return unresolvableRevisionsAreExtractedWithoutMemoization;
  }
}

export async function defaultGitHeadExists(cwd: string = process.cwd()): Promise<boolean> {
  try {
    await execFileAsync("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd,
      maxBuffer: 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}
