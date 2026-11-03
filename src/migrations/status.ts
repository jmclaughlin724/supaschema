import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Client } from "pg";
import { diagnostic } from "../diagnostics/diagnostics.js";
import { redactSecrets } from "../redaction.js";
import { quoteIdent } from "../sql/identifiers.js";
import type { Diagnostic } from "../types.js";
import { migrationFiles } from "./files.js";
import type { MigrationLineage } from "./lineage.js";
import { parseLineage } from "./lineage.js";

export interface MigrationsStatusOptions {
  allowMissingHistoryTable?: boolean;
  currentFingerprints?: CurrentBaselineFingerprints;
  databaseUrl?: string;
  directory: string;
  expectedAppliedVersions?: string[];
  historyTable?: string;
  runnerLabel?: string;
  targetLabel?: string;
}

export interface CurrentBaselineFingerprints {
  head?: string;
  tree?: string;
}

export interface MigrationHistoryComparison {
  expectedAppliedVersions: string[];
  missingExpectedVersions: string[];
  unexpectedAppliedVersions: string[];
}

export interface MigrationsStatusReport {
  applied: string[];
  appliedLineage: MigrationLineage[];
  expectedAppliedVersions: string[];
  files: string[];

  ghosts: string[];
  historyTable: string;

  missingExpectedVersions: string[];

  outOfOrder: string[];

  pending: string[];

  pendingLineage: MigrationLineage[];
  runnerLabel?: string;
  staleBaseline: string[];
  target?: string;
  targetLabel?: string;

  unexpectedAppliedVersions: string[];
}

const defaultHistoryTable = "supabase_migrations.schema_migrations";
const lineageScanBytes = 4096;

export async function migrationsStatus(
  options: MigrationsStatusOptions
): Promise<{ diagnostics: Diagnostic[]; report: MigrationsStatusReport }> {
  const diagnostics: Diagnostic[] = [];
  const historyTable = options.historyTable ?? defaultHistoryTable;
  const files = (await migrationFiles(options.directory))
    .map((file) => basename(file))
    .filter((name) => name.endsWith(".sql") && migrationFileVersion(name) !== undefined)
    .sort((left, right) => left.localeCompare(right));
  const versionsByFile = new Map(files.map((name) => [name, migrationFileVersion(name) ?? ""]));
  const expectedAppliedVersions =
    options.expectedAppliedVersions === undefined
      ? migrationFileVersions(files)
      : [...options.expectedAppliedVersions].sort(
          (left, right) => Number(left > right) - Number(left < right)
        );
  const report: MigrationsStatusReport = {
    applied: [],
    appliedLineage: [],
    expectedAppliedVersions,
    files,
    ghosts: [],
    historyTable,
    missingExpectedVersions: [],
    outOfOrder: [],
    pending: [],
    pendingLineage: [],
    ...(options.runnerLabel === undefined ? {} : { runnerLabel: options.runnerLabel }),
    staleBaseline: [],
    ...(options.targetLabel === undefined ? {} : { targetLabel: options.targetLabel }),
    unexpectedAppliedVersions: [],
  };
  if (!options.databaseUrl) {
    report.pending = files;
    report.missingExpectedVersions = expectedAppliedVersions;
    diagnostics.push(
      diagnostic(
        "SUPA_MIGRATIONS_NO_TARGET",
        "warning",
        "no database URL resolved; reporting disk files only",
        { hint: "Pass --database-url or set SUPASCHEMA_DATABASE_URL to compare against a target." }
      )
    );
    await annotateLineage(options.directory, report);
    diagnostics.push(...classifyStaleBaselines(report, options.currentFingerprints));
    return { diagnostics, report };
  }
  report.target = databaseTargetLabel(options.databaseUrl);
  const appliedVersions = await readHistory(options.databaseUrl, historyTable, diagnostics, {
    allowMissingHistoryTable: options.allowMissingHistoryTable === true,
  });
  if (appliedVersions === undefined) {
    return { diagnostics, report };
  }
  const diskVersions = new Set(versionsByFile.values());
  const newestApplied =
    [...appliedVersions]
      .sort((left, right) => Number(left > right) - Number(left < right))
      .at(-1) ?? "";
  const comparison = compareMigrationHistory(appliedVersions, expectedAppliedVersions);
  report.missingExpectedVersions = comparison.missingExpectedVersions;
  report.unexpectedAppliedVersions = comparison.unexpectedAppliedVersions;
  for (const file of files) {
    const version = versionsByFile.get(file) ?? "";
    if (appliedVersions.has(version)) {
      report.applied.push(file);
      continue;
    }
    report.pending.push(file);
    if (version < newestApplied) {
      report.outOfOrder.push(file);
    }
  }
  report.ghosts = [...appliedVersions]
    .filter((version) => !diskVersions.has(version))
    .sort((left, right) => left.localeCompare(right));
  await annotateLineage(options.directory, report);
  diagnostics.push(...classifyStaleBaselines(report, options.currentFingerprints));
  if (report.ghosts.length > 0) {
    diagnostics.push(
      diagnostic(
        "SUPA_MIGRATIONS_GHOST_VERSIONS",
        "error",
        `${report.ghosts.length} applied version(s) have no migration file on disk`,
        { hint: `ghost versions: ${report.ghosts.slice(0, 8).join(", ")}` }
      )
    );
  }
  if (report.outOfOrder.length > 0) {
    diagnostics.push(
      diagnostic(
        "SUPA_MIGRATIONS_OUT_OF_ORDER",
        "error",
        `${report.outOfOrder.length} pending file(s) are older than the target's newest applied version`,
        { hint: `out-of-order: ${report.outOfOrder.slice(0, 8).join(", ")}` }
      )
    );
  }
  return { diagnostics, report };
}

export function renderMigrationsStatus(report: MigrationsStatusReport): string {
  const lines: string[] = [];
  const labels = [report.targetLabel, report.runnerLabel].filter((label) => label !== undefined);
  lines.push(
    `migrations${labels.length > 0 ? ` [${labels.join(" / ")}]` : ""}: ${report.files.length} file(s) on disk vs ${report.target ?? "no target"} (${report.historyTable})`
  );
  lines.push(
    `  applied: ${report.applied.length}  pending: ${report.pending.length}  ghosts: ${report.ghosts.length}  out-of-order: ${report.outOfOrder.length}`
  );
  for (const file of report.pending) {
    const lineage = report.pendingLineage.find((item) => item.file === file);
    const stale = report.staleBaseline.includes(file);
    lines.push(
      `  pending: ${file}${lineage ? ` (supaschema lineage${stale ? ", stale baseline" : ""})` : ""}`
    );
  }
  for (const version of report.ghosts) {
    lines.push(`  ghost: ${version} (applied on target, no file on disk)`);
  }
  for (const file of report.outOfOrder) {
    lines.push(`  out-of-order: ${file}`);
  }
  return `${lines.join("\n")}\n`;
}

export function migrationFileVersion(file: string): string | undefined {
  let index = 0;
  while (index < file.length && isDigit(file[index] ?? "")) {
    index += 1;
  }
  return index >= 8 ? file.slice(0, index) : undefined;
}

function isDigit(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

export function migrationFileVersions(files: string[]): string[] {
  return files
    .map((file) => migrationFileVersion(file))
    .filter((version): version is string => version !== undefined)
    .sort((left, right) => left.localeCompare(right));
}

export function compareMigrationHistory(
  appliedVersions: Iterable<string>,
  expectedAppliedVersions: Iterable<string>
): MigrationHistoryComparison {
  const applied = new Set(appliedVersions);
  const expected = [...new Set(expectedAppliedVersions)].sort(
    (left, right) => Number(left > right) - Number(left < right)
  );
  const expectedSet = new Set(expected);
  return {
    expectedAppliedVersions: expected,
    missingExpectedVersions: expected.filter((version) => !applied.has(version)),
    unexpectedAppliedVersions: [...applied]
      .filter((version) => !expectedSet.has(version))
      .sort((left, right) => left.localeCompare(right)),
  };
}

async function readHistory(
  databaseUrl: string,
  historyTable: string,
  diagnostics: Diagnostic[],
  options: { allowMissingHistoryTable?: boolean } = {}
): Promise<Set<string> | undefined> {
  const parts = historyTable.split(".");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    diagnostics.push(
      diagnostic(
        "SUPA_MIGRATIONS_HISTORY_TABLE",
        "error",
        `history table "${historyTable}" must be schema-qualified`
      )
    );
    return;
  }
  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const exists = await client.query<{ found: boolean }>(
      "select exists (select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relname = $2) as found",
      [parts[0], parts[1]]
    );
    if (exists.rows[0]?.found !== true) {
      if (options.allowMissingHistoryTable === true) {
        diagnostics.push(
          diagnostic(
            "SUPA_MIGRATIONS_HISTORY_TABLE",
            "warning",
            `history table ${historyTable} does not exist on the target`,
            { hint: "The selected runner may create it before applying migrations." }
          )
        );
        return new Set();
      }
      diagnostics.push(
        diagnostic(
          "SUPA_MIGRATIONS_HISTORY_TABLE",
          "error",
          `history table ${historyTable} does not exist on the target`,
          { hint: "Pass --history-table for runners that record history elsewhere." }
        )
      );
      return;
    }
    const result = await client.query<{ version: string }>(
      `select version::text as version from ${quoteIdent(parts[0] ?? "")}.${quoteIdent(parts[1] ?? "")}`
    );
    return new Set(result.rows.map((row) => row.version));
  } catch (error) {
    diagnostics.push(
      diagnostic(
        "SUPA_MIGRATIONS_TARGET_UNAVAILABLE",
        "error",
        error instanceof Error ? error.message : String(error),
        { hint: "Confirm the database URL is reachable." }
      )
    );
  } finally {
    await client.end().catch(() => undefined);
  }
}

function classifyStaleBaselines(
  report: MigrationsStatusReport,
  currentFingerprints: CurrentBaselineFingerprints | undefined
): Diagnostic[] {
  if (currentFingerprints === undefined) {
    return [];
  }
  const known = new Set(
    [currentFingerprints.head, currentFingerprints.tree].filter(
      (fingerprint): fingerprint is string => fingerprint !== undefined
    )
  );
  if (known.size === 0) {
    return [];
  }
  const staleFiles = new Set<string>();
  const staleFingerprints = new Set<string>();
  for (const lineage of report.pendingLineage) {
    if (known.has(lineage.to) && !staleFingerprints.has(lineage.from)) {
      continue;
    }
    staleFiles.add(lineage.file);
    staleFingerprints.add(lineage.to);
  }
  report.staleBaseline = [...staleFiles].sort((left, right) => left.localeCompare(right));
  if (report.staleBaseline.length === 0) {
    return [];
  }
  return [
    diagnostic(
      "SUPA_MIGRATIONS_STALE_BASELINE",
      "warning",
      `${report.staleBaseline.length} pending generated migration(s) record a lineage end-state that matches neither git:HEAD nor the current tree`,
      {
        file: report.staleBaseline[0],
        hint: "The recorded end-state is unreproducible (likely generated from an uncommitted tree that has since moved). If no target records the version as applied, review and delete the pending migration, then regenerate from the current tree.",
      }
    ),
  ];
}

async function annotateLineage(directory: string, report: MigrationsStatusReport): Promise<void> {
  const pending = new Set(report.pending);
  for (const file of report.files) {
    const handle = await readFile(join(directory, file), "utf8").catch(() => undefined);
    if (handle === undefined) {
      continue;
    }
    const lineage = parseLineage(handle.slice(0, lineageScanBytes));
    if (lineage) {
      (pending.has(file) ? report.pendingLineage : report.appliedLineage).push({
        file,
        ...lineage,
      });
    }
  }
}

function databaseTargetLabel(value: string): string {
  if (URL.canParse(value)) {
    return redactSecrets(value);
  }
  return "<database>";
}
