import { performance } from "node:perf_hooks";
import { extractRoutineExecuteGrantees } from "../catalog/extract.js";
import type { SupaschemaConfig } from "../config/schema.js";
import { buildSchemaPlanningContext, type SchemaPlanningMode } from "../planner/context.js";
import { planSchemaDiff } from "../planner/schema.js";
import { migrationSafetyPack, runRulePacks } from "../scan/rules.js";
import { filterModelBySchemas, parseSchemaFilter } from "../source/extract.js";
import type { MigrationPlan, SchemaModel } from "../types.js";

interface SchemaDiffPlanOptions {
  checkMigrationBaseline?: boolean;
  config: SupaschemaConfig;
  cwd?: string;
  excludeMigrationFiles?: readonly string[];
  from: string;
  migrationsDir?: string;
  mode?: SchemaPlanningMode;
  routinePrivilegeDatabaseUrl?: string;
  schema?: string;
  timing?: boolean;
  to: string;
}

export async function buildSchemaDiffPlan(options: SchemaDiffPlanOptions): Promise<MigrationPlan> {
  const context = await buildSchemaPlanningContext(options);
  if (context.diagnostics.some((item) => item.severity === "error")) {
    return blockedPlan(options.from, options.to, context.diagnostics);
  }
  if (!(context.from && context.to && context.migrationCorpus)) {
    return blockedPlan(options.from, options.to, context.diagnostics);
  }
  let appliedRoutineExecuteGrantees: Map<string, Set<string>> | undefined;
  if (options.routinePrivilegeDatabaseUrl !== undefined) {
    const applied = await extractRoutineExecuteGrantees({
      config: options.config,
      databaseUrl: options.routinePrivilegeDatabaseUrl,
    });
    if (!(applied instanceof Map)) {
      return blockedPlan(options.from, options.to, [...context.diagnostics, applied]);
    }
    appliedRoutineExecuteGrantees = applied;
  }
  const plan = planSchemaDiff(context.from, context.to, {
    ...(appliedRoutineExecuteGrantees === undefined ? {} : { appliedRoutineExecuteGrantees }),
    config: options.config,
    migrationCorpus: context.migrationCorpus,
  });

  plan.diagnostics.push(...context.diagnostics);
  plan.diagnostics.push(...runRulePacks([migrationSafetyPack], { model: context.to, plan }));
  if (options.timing) {
    process.stderr.write(
      `timing: extract-from ${Math.round(context.fromMs)}ms · extract-to ${Math.round(context.toMs)}ms · plan ${Math.round(performance.now() - context.planStart)}ms\n`
    );
  }
  return plan;
}

function blockedPlan(
  from: string,
  to: string,
  diagnostics: MigrationPlan["diagnostics"]
): MigrationPlan {
  return {
    diagnostics,
    fingerprint: "blocked",
    from,
    fromFingerprint: "",
    operations: [],
    to,
    toFingerprint: "",
  };
}

export function filterModel(model: SchemaModel, schemaFilter: string | undefined): SchemaModel {
  return filterModelBySchemas(model, parseSchemaFilter(schemaFilter));
}
