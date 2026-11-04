export interface DiagnosticDefinition {
  cause?: string;
  commands?: readonly string[];
  docs?: string;
  expectedEvidence?: readonly string[];
  forbiddenActions?: readonly string[];
  recoverySteps?: readonly string[];
  summary: string;
}

const diagnosticSummaries: Record<string, string> = {
  SUPA_BUILD_STALE_DIST:
    "The compiled dist is older than src in a repository checkout; rebuild before trusting CLI behavior.",
  SUPA_CATALOG_EXTRACT_FAILED: "Live catalog extraction failed; check the database URL and role.",
  SUPA_CATALOG_SNAPSHOT_VERSION:
    "The catalog snapshot was produced by a different supaschema model version; hashes may not be comparable.",
  SUPA_CHECK_ADD_CONSTRAINT_GUARD: "ADD CONSTRAINT must be wrapped in a catalog guard DO block.",
  SUPA_CHECK_ALTER_COLUMN_TYPE_REWRITE:
    "ALTER COLUMN TYPE can rewrite the table under an ACCESS EXCLUSIVE lock.",
  SUPA_CHECK_CASCADE: "Implicit CASCADE is forbidden; drop dependents explicitly in order.",
  SUPA_CHECK_CREATE_EXTENSION_GUARD: "CREATE EXTENSION must use IF NOT EXISTS.",
  SUPA_CHECK_CREATE_INDEX_GUARD: "CREATE INDEX must use IF NOT EXISTS.",
  SUPA_CHECK_CREATE_MATERIALIZED_VIEW_GUARD: "CREATE MATERIALIZED VIEW must use IF NOT EXISTS.",
  SUPA_CHECK_CREATE_ROUTINE_REPLACE: "FUNCTION and PROCEDURE creation must use OR REPLACE.",
  SUPA_CHECK_CREATE_SCHEMA_GUARD: "CREATE SCHEMA must use IF NOT EXISTS.",
  SUPA_CHECK_CREATE_SEQUENCE_GUARD: "CREATE SEQUENCE must use IF NOT EXISTS.",
  SUPA_CHECK_CREATE_TABLE_GUARD: "CREATE TABLE must use IF NOT EXISTS.",
  SUPA_CHECK_CREATE_TRIGGER_REPLACEMENT:
    "CREATE TRIGGER must use OR REPLACE or follow DROP TRIGGER IF EXISTS.",
  SUPA_CHECK_CREATE_TYPE_GUARD: "TYPE and DOMAIN creation must be wrapped in a catalog guard.",
  SUPA_CHECK_CREATE_VIEW_REPLACE: "VIEW creation must use OR REPLACE.",
  SUPA_CHECK_DEPARSE_MISMATCH:
    "A migration statement does not round-trip through the deparser to an identical parse tree; canonical-output normalization would alter it.",
  SUPA_CHECK_DEPARSE_UNSUPPORTED:
    "A migration statement cannot be deparsed for the round-trip proof; normalization would fall back to source text for it.",
  SUPA_CHECK_DML_REVIEW: "Data-modifying statements need explicit idempotency review.",
  SUPA_CHECK_DROP_IF_EXISTS: "DROP statements must use IF EXISTS.",
  SUPA_CHECK_ENUM_VALUE_USE_SAME_TRANSACTION:
    "An enum value added in this migration is used later in the same file; transactional runners fail.",
  SUPA_CHECK_FORWARD_REFERENCE_ORDER:
    "A migration statement references an object or column before the migration creates it.",
  SUPA_CHECK_FUNCTION_PUBLIC_EXECUTE:
    "Public-schema functions are executable by PUBLIC unless the migration explicitly revokes EXECUTE.",
  SUPA_CHECK_INSERT_ON_CONFLICT: "INSERT statements in migrations must use ON CONFLICT.",
  SUPA_CHECK_NONTRANSACTIONAL_INDEX:
    "CREATE INDEX CONCURRENTLY cannot run inside a transaction block.",
  SUPA_CHECK_NONTRANSACTIONAL_REFRESH:
    "REFRESH MATERIALIZED VIEW CONCURRENTLY cannot run inside a transaction block.",
  SUPA_CHECK_SEARCH_PATH: "Migrations must not set the session search_path.",
  SUPA_CHECK_SECURITY_DEFINER_SEARCH_PATH:
    "SECURITY DEFINER routines must satisfy the local search_path policy with proven schema-qualified relation and type references.",
  SUPA_CHECK_SET_NOT_NULL_SCAN:
    "SET NOT NULL scans the table unless a validated CHECK constraint proves it.",
  SUPA_CHECK_VOLATILE_DEFAULT_REWRITE: "ADD COLUMN with a volatile default rewrites the table.",
  SUPA_CONFIG_INVALID:
    "supaschema.config.json failed schema validation; fix the reported fields against supaschema-config.schema.json.",
  SUPA_CORPUS_RECONVERGENCE:
    "The corpus oracle did not converge: residual operations remain after applying the rendered reconciliation to the dirty corpus database, or the second apply changed the catalog.",
  SUPA_DIFF_CONFIG_DIRTY:
    "A scoped migration diff cannot prove ownership while supaschema.config.json has uncommitted changes.",
  SUPA_DIFF_EMPTY_PLAN:
    "A disk write was explicitly requested, but the schema diff planned no operations.",
  SUPA_DIFF_GENERATED_CONTRACT_DIRTY:
    "Generated TypeScript/Zod contract outputs have uncommitted changes before migration generation.",
  SUPA_DIFF_LINEAGE_BROKEN:
    "The plan's from-state does not continue the newest pending supaschema migration; regenerate from the post-migration state.",
  SUPA_DIFF_LINEAGE_DUPLICATE:
    "A pending supaschema migration already covers this exact from/to transition.",
  SUPA_DIFF_LINEAGE_GAP:
    "The newest pending supaschema migration does not chain into the next schema diff.",
  SUPA_DIFF_MIGRATIONS_DIRTY:
    "The migrations directory has uncommitted files before migration generation.",
  SUPA_DIFF_OUTPUT_EXISTS:
    "The output migration file already exists; use diff --replace only for an unapplied generated migration replacement.",
  SUPA_DIFF_REPLACE_APPLIED:
    "The replacement migration version is already recorded in a configured database history table.",
  SUPA_DIFF_REPLACE_APPLIED_STATE_UNVERIFIED:
    "No database history target was available, so replacement applied state could not be verified.",
  SUPA_DIFF_REPLACE_BASELINE_REQUIRED:
    "The replacement migration's original lineage baseline could not be proven from the selected source.",
  SUPA_DIFF_REPLACE_HAND_AUTHORED:
    "diff --replace only accepts supaschema-generated migrations with lineage metadata.",
  SUPA_DIFF_REPLACE_NOT_LATEST:
    "diff --replace targeted a generated migration older than the configured migration directory tip.",
  SUPA_DIFF_SCOPED_DIRTY_SCHEMA:
    "A scoped migration diff cannot run while schema files outside the requested schema filter are dirty.",
  SUPA_DIFF_TREE_UNCOMMITTED:
    "The to-source tree has uncommitted changes, so this migration's lineage end-state fingerprints uncommitted schema-tree state; supaschema sync stages the complete closure and uses that proven index state as the next automatic baseline.",
  SUPA_EXTRACT_DUPLICATE_OBJECT: "Two source statements declare the same object identity.",
  SUPA_EXTRACT_PARSER_REQUIRED: "AST extraction requires the libpg-query parser.",
  SUPA_EXTRACT_SIDE_EFFECT_UNSUPPORTED:
    "Side-effect statements are not schema objects; keep them in reviewed migrations.",
  SUPA_EXTRACT_UNSUPPORTED: "Unsupported or ambiguous DDL; extend support or hand-author it.",
  SUPA_GENERATED_ARTIFACT_EDIT:
    "A write targeted a generated migration or configured TypeScript/Zod contract output.",
  SUPA_GENERATED_ARTIFACT_GUARD_FAILED:
    "The generated-artifact hook could not classify a write and denied it.",
  SUPA_INTAKE_MALFORMED:
    "Customer-supplied intake payload is not a JSON object or exceeds the nesting limit; submit a well-formed object.",
  SUPA_INTAKE_MISSING_SCOPE:
    "Customer-supplied intake payload is missing a required scope field; include every required key.",
  SUPA_INTAKE_SECRET:
    "Customer-supplied intake payload contains a secret-shaped value; redact credentials before submitting.",
  SUPA_MIGRATION_BASELINE_FORMAT_DRIFT:
    "Generated migration-tree lineage was produced by a different model format, so old and current fingerprints are not directly comparable. Review the generated migration normally; same-format mismatches still block.",
  SUPA_MIGRATION_BASELINE_MISMATCH:
    "The resolved before-state source does not match the generated migration-tree baseline. Recover by regenerating from the source state that produced the baseline, using diff --replace for a generated migration replacement, or — when the pending generated migration's end-state was never committed and no target records it as applied — reviewing and deleting that pending migration, then regenerating from the current tree.",
  SUPA_MIGRATION_BASELINE_REPLAY_REQUIRED:
    "The selected snapshot cannot prove a migration corpus with no generated lineage or a hand-authored tail; replay the configured migration corpus as the before-state.",
  SUPA_MIGRATION_BASELINE_UNSUPPORTED:
    "The selected migrations: before-state does not resolve to the configured migration corpus.",
  SUPA_MIGRATION_CORPUS_PARSE_SKIPPED:
    "A historical migration could not be parsed for source-intent extraction.",
  SUPA_MIGRATIONS_GHOST_VERSIONS:
    "The target's history table records versions with no migration file on disk; the worktree cannot reproduce the target.",
  SUPA_MIGRATIONS_HISTORY_TABLE:
    "The migration history table is missing or not schema-qualified; pass --history-table for non-Supabase runners.",
  SUPA_MIGRATIONS_NO_TARGET:
    "No database URL resolved; the migrations report covers disk files only.",
  SUPA_MIGRATIONS_OUT_OF_ORDER:
    "Pending migration files are older than the target's newest applied version; a runner may skip or misorder them.",
  SUPA_MIGRATIONS_STALE_BASELINE:
    "A pending generated migration's lineage end-state matches neither the current git:HEAD schema fingerprint nor the current tree fingerprint; its baseline is unreproducible. If no target records it as applied, review and delete the pending migration, then regenerate from the current tree.",
  SUPA_MIGRATIONS_TARGET_UNAVAILABLE: "The migrations target database could not be read.",
  SUPA_NORMALIZE_FIDELITY:
    "Deparsed SQL did not reparse to the identical parse tree, so the object kept its source text.",
  SUPA_NORMALIZE_UNSUPPORTED:
    "The deparser cannot render this object, so it kept its source text under normalize mode.",
  SUPA_OBJECT_PARSE_FAILED:
    "Object SQL did not parse, so its identity hash fell back to normalized text.",
  SUPA_PARSE_ERROR: "SQL failed to parse with the PostgreSQL parser.",
  SUPA_PARSE_UNAVAILABLE: "libpg-query did not expose a parser entrypoint.",
  SUPA_PLAN_ADD_COLUMN_UNSAFE:
    "Added column can fail on populated tables because it is NOT NULL without a default.",
  SUPA_PLAN_COLUMN_ALTER_HINT_REQUIRED:
    "Column drops and type changes render data-preserving ALTERs only after a destructive-change hint.",
  SUPA_PLAN_COLUMN_DEPENDENT_REWRITE_REQUIRED:
    "Column drops or type changes require dependent objects to be removed or rewritten before the ALTER.",
  SUPA_PLAN_COLUMN_GENERATED_REVIEW:
    "A generated column expression changed; review rewrite, lock, and statistics impact before deploy.",
  SUPA_PLAN_COLUMN_TYPE_USING_REVIEW:
    "A column type change renders an identity USING cast; PostgreSQL rejects it unless an assignment cast exists. Review and replace the USING expression for non-trivial conversions.",
  SUPA_PLAN_CONCURRENT_INDEX_UNSUPPORTED:
    "CREATE INDEX CONCURRENTLY cannot run inside the transaction the migration runner uses.",
  SUPA_PLAN_DATA_TRANSITION_REQUIRED:
    "A storage-shape transition needs reviewed migration-corpus data movement intent.",
  SUPA_PLAN_DEPENDENCY_CYCLE: "Dependency ordering found a reference cycle between objects.",
  SUPA_PLAN_DEPENDENT_ROUTINE_REORDERED:
    "A dependent routine, view, policy, or trigger was ordered before a destructive column ALTER.",
  SUPA_PLAN_DESTRUCTIVE_HINT_REQUIRED:
    "Destructive change requires the object key in hints.destructive.",
  SUPA_PLAN_EMPTY_WITH_DRIFT:
    "The plan contains no operations but the model fingerprints differ; an empty migration would silently mask real drift.",
  SUPA_PLAN_RENAME_HINT_UNMATCHED: "Rename hint does not match both source and target objects.",
  SUPA_PLAN_RENAME_KIND_MISMATCH: "Rename hint changes the object kind.",
  SUPA_PLAN_RENAME_SET_SCHEMA_UNSUPPORTED: "Rename hints cannot move objects between schemas.",
  SUPA_PLAN_RENAME_UNSUPPORTED: "This object kind has no safe rename rendering yet.",
  SUPA_PLAN_RENAME_VERIFY_REQUIRED: "Rename hints must be verified against a disposable database.",
  SUPA_PLAN_ROUTINE_RETURN_TYPE_CHANGED:
    "Routine return type or OUT parameters changed; CREATE OR REPLACE cannot apply it.",
  SUPA_PLAN_VIEW_REPLACE_INCOMPATIBLE:
    "View replacement drops, renames, or reorders output columns; CREATE OR REPLACE VIEW cannot apply it.",
  SUPA_PLAN_VIEW_REPLACE_VERIFY_REQUIRED:
    "CREATE OR REPLACE VIEW only allows compatible column shapes; verify before release.",
  SUPA_REBASELINE_RETAIN_UNKNOWN:
    "A requested retained operational migration is absent from the configured migration corpus.",
  SUPA_REBASELINE_REPLACEMENT_FAILED:
    "Rebaseline could not replace migration history and generated contracts; the previous files were restored when rollback succeeded.",
  SUPA_REBASELINE_STAGE_FAILED:
    "The new baseline was written, but Git could not stage the migration deletions and generated closure.",
  SUPA_REBASELINE_TARGET_REBUILD_REQUIRED:
    "Rebaseline replaced repository history without changing applied target history; each affected target needs a separately authorized rebuild or reconciliation before sync.",
  SUPA_REBASELINE_VERIFY_REQUIRED:
    "Rebaseline --write requires a disposable database to prove the baseline before replacing migration history.",
  SUPA_REPLAY_ORDER_GAP:
    "Migration history could not be replayed in filename order; an ALTER/DROP targets an absent object or a CREATE duplicates one.",
  SUPA_REPLAY_UNSUPPORTED:
    "A migration history statement cannot be replayed into the model; the migrations: source fails closed and never introspects.",
  SUPA_ROUTINE_BODY_DEPENDENCY_UNKNOWN:
    "A routine body uses a language or form whose dependencies cannot be fully proven statically.",
  SUPA_ROUTINE_BODY_PARTIAL_DEPENDENCY:
    "A PL/pgSQL routine body was only partially parsed for dependency extraction.",
  SUPA_ROUTINE_DEPENDENCY_PROOF_REQUIRED:
    "A routine with unproven dependencies blocks relation or type changes until the dependency proof is structural.",
  SUPA_ROUTINE_DYNAMIC_SQL_DEPENDENCY_UNKNOWN:
    "A PL/pgSQL routine contains dynamic SQL whose relation and column dependencies cannot be proven statically.",
  SUPA_ROUTINE_PRIVILEGE_DRIFT:
    "diff --routine-privilege-drift found a grantee that still holds EXECUTE on a routine in the applied database although the declarative schema revokes it; the plan re-applies the declared REVOKE.",
  SUPA_RULE_DESTRUCTIVE_OP:
    "A destructive operation will run in this migration; review it for data loss and lock impact before deploy.",
  SUPA_RULE_EXPOSED_TABLE_WITHOUT_RLS:
    "An exposed-schema table grants access without an enabled RLS posture.",
  SUPA_RULE_POLICY_AUTH_ROLE_DEPRECATED:
    "An RLS policy uses Supabase auth.role(); target roles with the policy TO clause instead.",
  SUPA_RULE_POLICY_AUTH_UID_UNWRAPPED:
    "An RLS policy calls auth.uid() directly instead of wrapping it in a SELECT initPlan.",
  SUPA_RULE_POLICY_MISSING_PREDICATE:
    "An RLS policy lacks the USING or WITH CHECK predicate needed for its command class.",
  SUPA_RULE_POLICY_MISSING_REQUIRED_COLUMN:
    "An RLS policy lacks a configured table column in its effective predicate.",
  SUPA_RULE_SECDEF_SEARCH_PATH:
    "A SECURITY DEFINER routine violates the local search_path policy or cannot prove every relation and type reference safe from implicit pg_temp lookup.",
  SUPA_SCAN_CONTRACT_ASSERTION:
    "A TypeScript assertion appears in a file importing generated database contracts.",
  SUPA_SCAN_CONTRACT_IMPORT_RENAME: "A generated contract import was renamed locally.",
  SUPA_SCAN_CONTRACT_OVERRIDE_TYPES:
    "A Supabase query response override bypasses the generated database contract.",
  SUPA_SCAN_CONTRACT_RETURNS:
    "A Supabase query returns override bypasses the generated database contract.",
  SUPA_SCAN_CONTRACT_RUNTIME_COPY: "A local constant copies a generated runtime contract root.",
  SUPA_SCAN_CONTRACT_USAGE_PARSE:
    "A TypeScript file in the generated-contract usage scan could not be fully parsed.",
  SUPA_SELFCHECK_HASH_MISMATCH:
    "A catalog object hashes differently after its rendered SQL is re-extracted; cross-lane diffs would report a false change.",
  SUPA_SELFCHECK_MISSING: "A catalog object disappeared when its rendered SQL was re-extracted.",
  SUPA_SELFCHECK_UNEXPECTED: "Re-extraction produced an object the catalog model does not contain.",
  SUPA_SOURCE_BASELINE_REQUIRED:
    "Migration generation could not resolve a repository source baseline.",
  SUPA_SOURCE_MIGRATIONS_DRIFT_UNSUPPORTED:
    "Drift detection cannot use replayed migrations as a source. Use migrations only as a generation before-state.",
  SUPA_SOURCE_MIGRATIONS_TARGET_UNSUPPORTED:
    "Migration generation cannot use replayed migrations as its target. Use the matching migration corpus only as the before-state.",
  SUPA_SUPABASE_MANAGED_SCHEMA: "Configured managed schemas are not declarative source owners.",
  SUPA_SUPABASE_VIEW_SECURITY_INVOKER:
    "Views in exposed schemas should set security_invoker so RLS applies to the querying role.",
  SUPA_SYNC_DISABLED: "workflow.migration_sync is disabled, so configured apply/deploy is refused.",
  SUPA_SYNC_ENV_UNKNOWN: "The selected sync environment is not defined in config.environments.",
  SUPA_SYNC_FINAL_RECONCILE_FAILED:
    "The selected target did not reconcile after the migration runner completed.",
  SUPA_SYNC_MULTI_TARGET_APPLY_UNSUPPORTED:
    "sync selected more than one mutation target; cross-target apply is not atomic.",
  SUPA_SYNC_REMOTE_APPROVAL_REQUIRED:
    "Automatic remote sync requires the configured runtime approval environment variable.",
  SUPA_SYNC_RUNNER_FAILED:
    "The selected migration runner exited nonzero during sync; supaschema gates but the runner owns apply/deploy.",
  SUPA_SYNC_RUNNER_UNAVAILABLE:
    "The selected migration runner could not be launched or connected. supaschema gates and delegates apply to the runner.",
  SUPA_SYNC_STAGE_FAILED: "Supaschema could not stage the complete schema closure in Git.",
  SUPA_SYNC_SUPABASE_CLI_CONCURRENT_COMPANION:
    "The Supabase CLI runner cannot safely apply concurrent companion migrations because Supabase keys migration history by timestamp.",
  SUPA_SYNC_TARGET_OVERRIDE_MULTI:
    "A database URL or environment override can only be used when exactly one sync target is selected.",
  SUPA_SYNC_TARGET_UNKNOWN: "The selected sync target is not configured.",
  SUPA_SYNC_TARGET_URL_UNRESOLVED: "The selected sync target's database URL could not be resolved.",
  SUPA_SYNC_VERIFY_URL_UNRESOLVED:
    "Sync could not resolve the disposable database URL required to verify pending migrations before apply.",
  SUPA_TYPES_CONTRACT_DRIFT:
    "A generated TypeScript/Zod contract does not match regenerated output; run supaschema types to refresh it.",
  SUPA_VALIDATOR_FAILED: "A configured external validator reported diagnostics.",
  SUPA_VALIDATOR_UNAVAILABLE: "A configured external validator is not installed.",
  SUPA_VALIDATOR_UNKNOWN: "Unknown validator name in the validators config.",
  SUPA_VERIFY_CLEANUP_FAILED: "A temporary verification database could not be dropped.",
  SUPA_VERIFY_FAILED: "Verification could not complete against the database.",
  SUPA_VERIFY_FINGERPRINT_MISMATCH:
    "Catalog after from+migration+migration differs from the target catalog.",
  SUPA_VERIFY_PREEXISTING_DRIFT:
    "Verification proved the pending migration without adding drift, but unrelated target drift remains.",
  SUPA_VERIFY_RECONVERGENCE:
    "Cross-lane diff of the migrated catalog against the target model is not empty; the model declares state the catalog cannot reproduce (false drift), or lane parity is broken. A converged diff must re-diff to zero.",
  SUPA_VERIFY_ROLE_CAPABILITY:
    "The verification role cannot CREATE DATABASE; verify needs a role with CREATEDB (on local Supabase stacks prefer supabase_admin).",
  SUPA_VERIFY_STUB_REFERENCE:
    "Verify failed referencing a managed schema that --ensure-environment only stubs minimally; the failure may be a stub limitation, not a real migration defect. Confirm by applying the migration to a real disposable database that provisions the managed surface. Use --no-ensure-environment only when the verification server itself provisions the managed surface in new databases.",
};

const diagnosticDefinitionOverrides: Record<string, Omit<DiagnosticDefinition, "summary">> = {
  SUPA_BUILD_STALE_DIST: {
    cause:
      "A repository checkout ran the compiled CLI from dist while src contained newer edits, so the executed behavior did not include the latest source. This only fires in a checkout layout; installed packages ship no src directory.",
    commands: ["npm run build", "supaschema doctor"],
    docs: "docs/commands/doctor.mdx",
    expectedEvidence: [
      "doctor build identity reports a built timestamp newer than the latest src edit",
      "the warning disappears on the next CLI run after a rebuild",
    ],
    forbiddenActions: [
      "do not suppress the warning to keep testing against a stale dist",
      "do not treat stale-dist behavior as evidence of a source regression",
    ],
    recoverySteps: [
      "Run npm run build in the repository checkout.",
      "Re-run the CLI command and confirm doctor build identity reflects the rebuild.",
    ],
  },
  SUPA_TYPES_CONTRACT_DRIFT: {
    cause:
      "types --check regenerated the configured TypeScript/Zod contracts and found the on-disk outputs missing or different. Generated contracts are projections of the schema source; the header fingerprint identifies the model the file was generated from.",
    commands: ["supaschema types", "supaschema types --check"],
    docs: "docs/commands/types.mdx",
    expectedEvidence: [
      "types --check exits 0 after a refresh",
      "the reviewed generated diff contains only explained changes",
    ],
    forbiddenActions: [
      "do not manually edit generated TypeScript or Zod contracts to silence drift",
      "do not commit application casts or aliases that hide contract drift",
    ],
    recoverySteps: [
      "Confirm the schema source matches the intended state with supaschema doctor.",
      "Run supaschema types and review the generated diff.",
      "Commit the refreshed contracts together with the owning schema change.",
    ],
  },
  SUPA_CATALOG_EXTRACT_FAILED: {
    cause:
      "Catalog SQL failed before Supaschema could build a live model. Typical causes are an unreachable URL, insufficient pg_catalog visibility, or a configured schema boundary that was not applied at query time.",
    commands: [
      "supaschema doctor --database-url <local-database-url>",
      "supaschema selfcheck --database-url <local-database-url>",
    ],
    docs: "docs/concepts/sources.mdx",
    expectedEvidence: [
      "doctor reports catalog extraction with an object count and fingerprint",
      "selfcheck reports zero parity mismatches",
    ],
    forbiddenActions: [
      "do not remove excluded schema boundaries to make ACL extraction pass",
      "do not patch an empty catalog snapshot or generated contracts",
    ],
    recoverySteps: [
      "Confirm the selected URL and role with doctor.",
      "Keep schemas.include and schemas.exclude in the canonical config; catalog queries apply them before ACL expansion.",
      "Resolve the first catalog diagnostic, then run selfcheck.",
    ],
  },
  SUPA_GENERATED_ARTIFACT_EDIT: {
    cause:
      "Generated migrations and configured TypeScript/Zod outputs are projections of declarative SQL, generator configuration, and the proven migration baseline.",
    commands: ["supaschema doctor", "supaschema sync", "supaschema types"],
    docs: "docs/coding-agents/agent-bundle.mdx",
    expectedEvidence: [
      "migration replay and catalog/source checks are healthy",
      "the generator rewrites the artifact from canonical sources",
      "the reviewed generated diff contains only explained changes",
    ],
    forbiddenActions: [
      "do not manually edit generated TypeScript or Zod contracts",
      "do not manually edit a Supaschema-generated migration",
      "do not discard unexplained generated drift",
    ],
    recoverySteps: [
      "Change declarative schema SQL or generator configuration at its canonical owner.",
      "Run doctor and resolve migration replay, catalog, or selfcheck diagnostics.",
      "Run supaschema sync for the complete migration/type closure, or supaschema types only when schema sources already match the intended database state.",
      "Review the generated diff before keeping it.",
    ],
  },
  SUPA_GENERATED_ARTIFACT_GUARD_FAILED: {
    cause:
      "The hook payload was malformed, the Supaschema config could not be read or validated, or another classifier prerequisite failed before the target could be proven safe.",
    commands: ["supaschema config validate", "supaschema doctor"],
    docs: "docs/coding-agents/agent-bundle.mdx",
    expectedEvidence: [
      "config validation succeeds",
      "doctor identifies the configured generated outputs and reports healthy source/replay checks",
      "the retried hook returns an explicit allow or generated-artifact denial",
    ],
    forbiddenActions: [
      "do not bypass or unregister the generated-artifact hook",
      "do not manually edit generated migrations or TypeScript/Zod contracts",
      "do not treat a classifier failure as permission to write",
    ],
    recoverySteps: [
      "Run config validate and repair the first reported config error.",
      "Run doctor and resolve source, replay, or configured-output diagnostics.",
      "Retry the original tool operation after the hook can classify its target.",
    ],
  },
  SUPA_MIGRATION_BASELINE_REPLAY_REQUIRED: {
    cause:
      "Generated lineage is absent or a later hand-authored migration changed the state, so Git or another snapshot cannot prove the migration corpus tip.",
    commands: [
      "supaschema doctor",
      "supaschema diff --from migrations:<migrationsDir> --to dir:<schemaPath> --out stdout",
    ],
    docs: "docs/concepts/sources.mdx",
    expectedEvidence: [
      "doctor reports a successful migration replay object count and fingerprint",
      "sources.from:auto selects migrations:<migrationsDir>",
      "the next generated migration records a new format-versioned lineage edge",
    ],
    forbiddenActions: [
      "do not select empty: or an unrelated Git ref to bypass replay",
      "do not edit generated migrations or generated types to match the failing output",
      "do not apply remote DDL while repairing the local baseline",
    ],
    recoverySteps: [
      "Read the first replay diagnostic and its migration file.",
      "Make historical SQL replayable without changing already-applied intent, or supply the missing historical object/order statement.",
      "Rerun doctor; auto will select the configured migrations corpus.",
      "Generate and verify the next forward migration locally.",
    ],
  },
  SUPA_REBASELINE_RETAIN_UNKNOWN: {
    cause:
      "An explicit --retain path did not resolve to a SQL file in the configured migration directory, so Supaschema cannot prove which operational behavior to preserve.",
    commands: ["supaschema rebaseline", "supaschema rebaseline --retain <file...>"],
    docs: "docs/commands/rebaseline.mdx",
    expectedEvidence: [
      "every retained path appears in the dry-run inventory",
      "retained files and their operations are absent from the removal and discard sets",
    ],
    forbiddenActions: [
      "do not use --retain as a broad history-preservation shortcut",
      "do not retain data backfills or structural migrations that the declarative baseline replaces",
    ],
    recoverySteps: [
      "Run the dry run and select exact reviewed operational migration paths.",
      "Keep only behavior that the declarative tree cannot own, such as managed Realtime policies.",
      "Rerun with those exact --retain paths before --write.",
    ],
  },
  SUPA_REBASELINE_REPLACEMENT_FAILED: {
    cause:
      "The new baseline passed planning and verification, but history replacement or generated-contract refresh failed.",
    commands: ["supaschema rebaseline", "supaschema rebaseline --write"],
    docs: "docs/commands/rebaseline.mdx",
    expectedEvidence: [
      "the diagnostic states whether the previous history and contracts were restored",
      "a following dry run classifies the remaining files without an unreported partial replacement",
    ],
    forbiddenActions: [
      "do not hand-edit generated migrations or contracts to complete the replacement",
      "do not delete the remaining history to force a clean state",
    ],
    recoverySteps: [
      "Resolve the named filesystem or generator failure.",
      "Confirm the rollback result in the diagnostic and inspect the migration directory.",
      "Rerun the dry run before retrying --write.",
    ],
  },
  SUPA_REBASELINE_STAGE_FAILED: {
    cause:
      "The baseline and generated contracts were written, but Git rejected the selected closure paths or staging operation.",
    commands: ["git status --short", "supaschema rebaseline"],
    docs: "docs/commands/rebaseline.mdx",
    expectedEvidence: [
      "the new baseline exists and the old migration files are removed",
      "the final staged set contains every migration deletion and generated closure file",
    ],
    forbiddenActions: [
      "do not reset unrelated staged work to simplify the closure",
      "do not delete the new baseline to make staging easier",
    ],
    recoverySteps: [
      "Inspect the Git error and current staged/unstaged paths.",
      "Resolve the path or repository-state failure without discarding unrelated work.",
      "Stage the migration deletions and generated closure explicitly.",
    ],
  },
  SUPA_REBASELINE_TARGET_REBUILD_REQUIRED: {
    cause:
      "Rebaseline replaces repository files only; it does not mutate applied history or schema in any target database.",
    commands: ["supaschema migrations", "supaschema sync"],
    docs: "docs/commands/rebaseline.mdx",
    expectedEvidence: [
      "the target rebuild or reconciliation has separate authorization",
      "migrations and sync reconcile after the target operation completes",
    ],
    forbiddenActions: [
      "do not treat rebaseline as target history repair",
      "do not reset or repair a linked/production target from the rebaseline command",
    ],
    recoverySteps: [
      "Review the new baseline and discarded-operation inventory.",
      "Rebuild or reconcile each affected target through its separately authorized owner.",
      "Run migrations and sync only after that target operation completes.",
    ],
  },
  SUPA_REBASELINE_VERIFY_REQUIRED: {
    cause:
      "Replacing migration history without an apply-twice and reconvergence proof could leave an unusable sole baseline.",
    commands: ["supaschema rebaseline --write --database-url <disposable-url>"],
    docs: "docs/commands/rebaseline.mdx",
    expectedEvidence: [
      "the new baseline passes static replay checks",
      "verify applies it twice and reports no reconvergence error before any tracked file changes",
    ],
    forbiddenActions: [
      "do not bypass verification with direct file deletion",
      "do not point verification at a linked or production database",
    ],
    recoverySteps: [
      "Resolve a disposable PostgreSQL URL whose role can create and drop databases.",
      "Rerun the dry run and review the discarded-operation inventory.",
      "Run --write with that verification URL.",
    ],
  },
  SUPA_REPLAY_ORDER_GAP: {
    cause:
      "A migration ALTER or DROP references an object that the ordered migration prefix has not created, or a duplicate CREATE lacks an idempotency guard.",
    commands: ["supaschema doctor", "supaschema explain SUPA_MIGRATION_BASELINE_REPLAY_REQUIRED"],
    expectedEvidence: [
      "migration replay reaches the corpus tip without an order gap",
      "doctor reports the replay fingerprint",
    ],
    forbiddenActions: [
      "do not suppress the missing object with generated-type edits",
      "do not fall back to Git when the migration corpus is the required baseline",
    ],
    recoverySteps: [
      "Inspect the named migration and the earlier files that should establish its target.",
      "Restore the missing historical DDL or correct an unapplied migration's ordering/idempotency.",
      "Rerun doctor and the original generation command.",
    ],
  },
  SUPA_REPLAY_UNSUPPORTED: {
    cause:
      "A historical statement parses but has no lossless replay transition in the semantic model.",
    commands: ["supaschema doctor", "supaschema explain SUPA_MIGRATION_BASELINE_REPLAY_REQUIRED"],
    expectedEvidence: [
      "the statement has a parser-backed replay implementation and focused regression test",
      "migration replay and a second extraction converge",
    ],
    forbiddenActions: [
      "do not classify SQL semantics with regular expressions",
      "do not silently ignore the statement or patch generated artifacts",
    ],
    recoverySteps: [
      "Inspect the PostgreSQL AST for the named statement.",
      "Implement the transition in the shared source/replay/catalog semantic owner.",
      "Add source, replay, render, and catalog parity tests as applicable.",
      "Rerun doctor and selfcheck.",
    ],
  },
};

export const diagnosticDefinitions: Record<string, DiagnosticDefinition> = Object.fromEntries(
  Object.entries(diagnosticSummaries).map(([code, summary]) => [
    code,
    { summary, ...diagnosticDefinitionOverrides[code] },
  ])
);

export const diagnosticCatalog: Record<string, string> = Object.fromEntries(
  Object.entries(diagnosticDefinitions).map(([code, definition]) => [code, definition.summary])
);
