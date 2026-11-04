# Changelog

## 0.6.0 (2026-11-04)

### Minor Changes

- ccd237f: Add `supaschema rebaseline` and the typed `rebaselineMigrations` API for dry-run-first whole-history replacement. The workflow inventories discarded migration-only operations, optionally retains exact reviewed operational migrations, verifies a new declarative baseline before writing, restores the previous files on replacement failure, refreshes generated contracts, and stages migration deletions with the closure without mutating target databases.

### Patch Changes

- 9f0994f: Update runtime dependencies to their latest stable releases. With `pgsql-deparser` 18.4, `normalize: "deparse"` renders a sequence increment change as `SET INCREMENT 5` instead of `SET INCREMENT BY 5`; both forms parse to the same PostgreSQL tree.

## 0.5.7 (2026-08-08)

### Patch Changes

- 5797738: Upgrade the SQL parser to PostgreSQL 18: align `libpg-query` (17.7.4 → 18.1.4) with `pgsql-deparser` (18.x) so `CHECK … ENFORCED` / `NOT ENFORCED` round-trips natively instead of failing `SUPA_OBJECT_PARSE_FAILED` on the deparse→reparse validation. PG18 shifts statement `stmt_location` past leading comments and omits the `comment` field for empty-string and `NULL` comments, so statement text now preserves leading comments. That omission is safe because PostgreSQL treats `COMMENT … IS NULL` and `COMMENT … IS ''` identically — both remove the comment — so an absent `comment` field is modeled as comment deletion with no distinct empty-string comment. Table hashes now preserve PG18 `NOT NULL` enforcement and generated-column storage (`STORED` or `VIRTUAL`). PG18 also changes several canonical AST shapes (including new `rexpr_list_*` positions on `IN` predicates and `is_enforced` on checks), so canonical hashes shift and `MODEL_FORMAT_VERSION` bumps 6 → 7; baselines recorded by an older format warn with `SUPA_MIGRATION_BASELINE_FORMAT_DRIFT` and re-establish on the next generated migration rather than hard-blocking.

- Fix destructive relation replacement planning and forward-reference checks. Equivalent `IN` / `= ANY` and `NOT IN` / `<> ALL` predicates now hash identically without collapsing non-equivalent quantifiers, nested arrays, or semantic casts. Relation replacements suppress redundant owned grant drops and their diagnostics, restore unchanged grants and dependents for foreign tables, and preserve dependency-safe routine and trigger ordering. Migration checks now distinguish baseline columns from columns introduced by recreated tables, foreign tables, `CREATE TABLE AS`, materialized views, inherited tables, or a prior cascading schema drop.

- Normalize `GRANT` and `REVOKE` transitions per privilege across the complete ordered history. Alternating partial revoke/regrant sequences and later revokes after an intermediate regrant now converge to the same final model for `dir:` and `migrations:` sources, preventing divergent fingerprints, phantom restore grants, and incorrect destructive grant drops.

## 0.5.6 (2026-08-02)

### Patch Changes

- Make `sources.from: auto` prove lineage contiguity before selecting `git:HEAD`. When a generated baseline exists but no committed tree reproduces its fingerprint — the state left behind when a schema tree keeps moving after a migration is generated but before it is committed — `auto` now replays `migrations:<migrationsDir>` instead of selecting a `git:HEAD` it can already tell will fail the baseline gate. This matches the documented contract that `auto` "uses git:HEAD only for contiguous lineage" and mirrors the proof the staged `git:INDEX` lane already performs.

  Previously that state raised `SUPA_MIGRATION_BASELINE_MISMATCH` with no reachable recovery: the baseline was unreproducible from any commit, `diff --replace` only accepts unapplied generated migrations, and delete-and-regenerate requires that no target records the migration as applied. The mismatch hint now names the replay lane and defers the delete-and-regenerate remedy to a confirmed `supaschema migrations` applied-history check, and `migrations:<dir>` is listed in the `sources.from` schema examples.

- 5b9f2f1: Make the bundled Claude rule consumer-safe: point source-boundary guidance at the packaged offline `agent-bundle/docs/concepts/sources.mdx` instead of implementation-repo paths, and scope the `src/sql/support.ts` wiring and `npm run typecheck` verification requirements to developing supaschema itself, with consumer projects directed to the packaged docs, `supaschema explain`, and their own package scripts.
- 9a2611f: Fix unbalanced parenthesized column DEFAULT expressions in extraction: PostgreSQL reports the expression location after the opening paren, so rendered ALTER COLUMN ... SET DEFAULT statements kept the closing paren but dropped the opening one, producing SQL that failed replay checks with a syntax error (SUPA_PARSE_ERROR). The slice now re-extends across enclosing parens.
- 7fda852: Stamp generated TypeScript and Zod contracts with a provenance header (generator version, schema model fingerprint, regeneration command; unreleased builds also record their commit) and add `supaschema types --check`, a no-write drift gate that compares regenerated contracts against on-disk outputs and fails with `SUPA_TYPES_CONTRACT_DRIFT` (exit 2) when a contract is missing or would change.
- Harden release and agent boundaries: make session-state locks atomic and owner-aware, keep skill discovery outside the shared lock, recognize GNU and BSD in-place `sed` writes, redact secrets across arbitrary command whitespace, restrict consumer-canary credentials to the exact GitHub HTTPS host, smoke immutable snapshot versions, and recover numeric snapshot commit identifiers deterministically.

  Separate OAuth state from entitlement tokens with purpose-bound signed-token types, random nonces, and browser-bound callback cookies. Use GitHub App installation permissions for private repositories without requesting the broad classic OAuth `repo` scope, and derive subscription token expiry from Stripe Basil paid-through timestamps with price matching, monotonic renewal, and invoice replay protection.

- 7fda852: Embed build identity (version, commit, build time, tree state) in the published package as `dist/build-info.json`, report it in `supaschema doctor`, and warn on stderr when the CLI runs as an unreleased build or from a checkout whose compiled `dist` is older than `src` (`SUPA_BUILD_STALE_DIST`). `--version` output is unchanged; the warnings never fail the command and can be suppressed with `--quiet` or `SUPASCHEMA_SUPPRESS_BUILD_WARNING=1`.
- 7fda852: Publish immutable `X.Y.(Z+1)-dev.<sha>` snapshot builds to the npm `next` dist-tag on every protected `main` push via a new `snapshot.yml` workflow (OIDC trusted publishing, provenance attestation, post-publish registry smoke). Stable releases on `latest` are unchanged. Consumers can now dogfood the current main build as an exact version pin instead of linking a local checkout. Requires a one-time npm trusted publisher entry for `snapshot.yml`; see the release docs. Superseded: snapshot publishing now runs in the `publish-next` job in `release.yml`; npm trusted publisher setup names `release.yml`, and `snapshot.yml` no longer exists.

## 0.5.5 (2026-07-28)

### Breaking Changes

- Consolidate the three published Agent Skills into a single `supaschema` skill. `skills/supaschema-migrate` and `skills/supaschema-maintain` no longer exist as `npx skills` sources, and `supaschema init` now installs one skill directory instead of three. Existing installed copies are preserved by init and are no longer updated; install `skills/supaschema` to receive the consolidated workflows.

### Changes

- Reshape the published skill around progressive disclosure. `SKILL.md` is now a short routing surface — orientation commands, the shared exit-code contract, and a lane table — with `references/setup.md`, `references/migrate.md`, `references/maintain.md`, `references/safety.md`, and `references/diagnostics.md` loaded only when a lane needs them.
- Document the safety lane for the first time: the `scan` rule packs for schema hygiene, migration lock risk, RLS coverage, and grant exposure; `scan --contract-usage` detection of application code that works around generated contracts; the `type-contract` breaking-change gate; and the `workflow.rls_safety` and `workflow.type_safety` deploy policies.

### Patch Changes

- Add the `doctor`, `plan`, `inspect`, `fingerprint`, and `contracts` commands and the `text`/`json`/`github`/`sarif` reporter formats to the published skill, and route it to the support matrix, the full diagnostic catalog, and the library API.
- Document `workflow.schema_diff` and `workflow.migration_check` policy values, including `required_before_complete`, in the skill's configuration reference.

## 0.5.4 (2026-07-27)

### Patch Changes

- Limit installed Claude and Codex hooks to Supaschema's generated-migration protection and schema-write automation. The npm bundle no longer publishes or scaffolds the repository's generic Bash and Git guard.
- Remove legacy package-owned generic guard registrations when `supaschema init` upgrades an existing project, while preserving unrelated consumer hooks and leaving historical script files inert.

## 0.5.3 (2026-07-27)

### Changes

- Fix migration-history replay so dropping tables, foreign tables, views, and materialized views also removes their owned objects, grants, and comments, and treat the configured `migrations:` history as complete baseline proof even when hand-authored migrations follow generated lineage.
- Extend advisory `SECURITY DEFINER` checks to detect unqualified sequence references through `regclass`, relation targets in `TRUNCATE`, `LOCK`, and `ANALYZE`, and DML targets shadowed by CTE names.

### Patch Changes

- Harden the packaged Claude and Codex agent bundle by blocking checkout-creating or Git-metadata-mutating `git submodule` commands while retaining read-only `git submodule status`.

## 0.5.2 (2026-07-25)

### Changes

- Let migration-history replay recognize role-membership grants, apply `ALTER VIEW ... SET/RESET (security_invoker)`, and apply reviewed `ALTER POLICY` definition changes for `TO`, `USING`, and `WITH CHECK` while preserving omitted clauses; policy renames remain unsupported.
- Extend advisory `SECURITY DEFINER` checks to detect unqualified relation and type references with an empty `search_path`, including CTE-aware SQL, PL/pgSQL statements, and PL/pgSQL declaration types, while keeping the finding report-only.

### Patch Changes

- Validate the complete agent-hook import graph across transitive helpers, dynamic imports with options, dependency cycles, and real Node.js builtins.
- Root source and synchronization hooks at their installed entrypoints, preserve payload working directories for relative tool targets, generate compatible Claude command shapes, and record command-not-found incidents across POSIX shells, `cmd.exe`, and PowerShell.
- Preserve a frozen retired-hook fixture for installer upgrades so current hook improvements do not invalidate historical checksum behavior.

## 0.5.1 (2026-07-25)

### Changes

- Let `diff`, `plan`, and `sync` use the configured `migrations:` history as the generation before-state for migration-first adoption, while rejecting migration replay as a target or drift source.
- Add advisory scan and migration-check warnings for `SECURITY DEFINER` routines that do not pin `search_path = ''`, without adding a new deploy-blocking RLS gate in this patch.

### Patch Changes

- Stop reporting normal `EXECUTE` and other single-privilege grants as over-broad `ALL` privileges.
- Make `diff --replace` exclude both the replaced migration and its concurrent companion from replay and source-intent context, including canonicalized paths and an empty post-exclusion history.
- Upgrade the packaged agent bundle by removing retired package-owned sync-hook registrations, deleting only byte-identical retired scripts, preserving customized files, and recognizing quoted pnpm build approvals.
- Align Claude and Codex hook handling with current failure and session events, fail closed on malformed input or corrupted state, resolve hooks from the repository root, label every registered handler, validate the complete static hook dependency graph, and exercise native Windows hook commands and schema-write workflows in CI.

## 0.5.0 (2026-07-23)

### Breaking Changes

- Remove the hosted contract-registry commands `contracts push` and `contracts pull`. Use `contracts export` and `contracts diff` with repository or artifact storage instead.
- Remove license-token gating from `type-contract --enforce`. The flag now exits `2` whenever it finds a breaking generated contract; omit `--enforce` for report-only behavior.

### Changes

- Re-license supaschema under MIT and retire the commercial entitlement and hosted registry implementation.
- Generate Zod refinements from sound PostgreSQL `CHECK` constraints, including supported numeric bounds, `BETWEEN`, equality, character-length, membership, boolean, domain, and null-aware column comparisons while skipping unsafe coercions.
- Expand the packaged offline agent bundle with complete documentation, three curated Supaschema skills, and safer Claude and Codex setup that preserves existing customized files.

### Patch Changes

- Correct schema replay for unnamed `USING INDEX` constraints, table-scoped generated constraint names, same-schema domains, and type-generation-only migration sources.
- Preserve numeric constraint soundness for bigint and numeric pairs, inherited domains, non-strict bounds, and `NOT VALID` checks.
- Match PostgreSQL privilege behavior when restoring `PUBLIC` defaults and revoking table or column grants.
- Restore the full documentation lint path and Git-based cross-platform file discovery used by repository checks.

## 0.4.3 (2026-07-15)

### Patch Changes

- Allow generated Zod contracts to use an explicit type-only database import specifier while preserving the relative `.js` default.

## 0.4.2 (2026-07-15)

### Patch Changes

- Preserve concrete generated Zod schema inference while validating the database contract topology.

## 0.4.1 (2026-07-11)

### Patch Changes

- Match official postgres-meta RPC metadata for argument ordering and visibility, named variadics, computed fields, inline relation-row returns, multi-OUT records, `SetofOptions`, and structured conflict signatures.
- Correct packaged Supabase type-generation guidance and agent workflow surfaces following the 0.4.0 release.

## 0.4.0 (2026-07-11)

### Breaking Changes

- Align generated TypeScript with the current Supabase/postgres-meta contract. `supaschema types` no longer emits direct schema-qualified aliases such as `AppAccountsRow`, `AppAccountsInsert`, `AppAccountsUpdate`, or enum/composite aliases. Use the generated `Database`, `Tables`, `TablesInsert`, `TablesUpdate`, `Enums`, `CompositeTypes`, and `Constants` exports instead.
- Replace generated `App*Schema` Zod exports with the Supaschema runtime extension `SupaschemaZod`, organized by schema, tables, views, enums, and composites.
- Keep the removed `source.to` config shape and `types --source` CLI flag removed. Use `sources.from` and `types --from`.

### Changes

- Add `DatabaseWithoutInternals`, `DefaultSchema`, optional `__InternalSupabase.PostgrestVersion`, schema-keyed runtime enum `Constants`, and upstream empty collection shapes for tables, views, functions, enums, and composites.
- Correct scalar mappings to match upstream behavior, including `vector` as `string`, `void` as `undefined`, `record` as `Record<string, unknown>`, and unsupported PostgreSQL-only scalar names as `unknown`.
- Expand view and RPC generation with writable view `Insert`/`Update` shapes, non-writable column `never` contracts, unnamed JSON/text/relation-row arguments, complete correlated RPC signature unions, `SetofOptions`, computed relationship fields, relation-row returns, and structured function metadata.

## 0.3.17 (2026-07-10)

### Patch Changes

- Allow sequential schema changes without intermediate commits by recognizing a complete staged schema closure as the next `git:INDEX` baseline. Sync now guards target history before artifact generation, stages the full closure, reports staging failures, distinguishes applied from pending generated lineage, and allocates collision-free migration versions.
- Accept normalized `changed_files` hook payloads and command-wrapped patches so host integrations can route every schema mutation through the same automatic sync pipeline.
- Keep the agent loop blocked when the automatic schema-write fallback diff fails, including the actionable `SUPA_*` diagnostics needed to repair the lineage or schema source.
- Make verification match managed Supabase environments with Auth, Vault, and cron bootstrapping, an auto-discovered admin verification lane, and catalog-aware exclusions for provider-owned objects.
- Permit migrations that strictly reduce pre-existing target drift without introducing new drift, while preserving the remaining drift as a warning for later reconciliation.
- Extract routine dependencies consistently from file and live-catalog models, bump the lineage model format, and support explicit `sync` and `apply` source ranges.
- Tighten nullable columns with a replay-safe validated `CHECK` proof before `SET NOT NULL`, avoiding the ordinary full-table scan on PostgreSQL 17.

## 0.3.16 (2026-07-06)

### Patch Changes

- Adds `migrations:` as a type-generation source for projects whose reviewed migration history is the schema source of truth. `supaschema types --source migrations:supabase/migrations` reconstructs table and enum contracts without a database connection, while unsupported replay gaps emit named `SUPA_REPLAY_*` diagnostics instead of falling through to introspection or `unknown` types.

  Adds git-based migration selection to `supaschema check`: `--changed`, `--staged`, `--base <ref>`, and `--since <ref>` restrict checks to changed `.sql` files under `config.migrationsDir` while excluding deletions.

## 0.3.15 (2026-07-06)

### Patch Changes

- Fixes the workspace preflight for `diff --replace`: replacing a pending generated migration no longer fails with `SUPA_DIFF_MIGRATIONS_DIRTY` when other uncommitted files exist in the migrations directory, matching the documented recovery path where replace closes an open migration unit.

  Fixes preflight path normalization across symlinked working directories (such as macOS `/var` → `/private/var`): absolute paths are resolved through their real paths and repo-escaping pathspecs are dropped, so `git status` cannot spuriously fail and silently disable the dirty-workspace preflight.

## 0.3.14 (2026-07-06)

### Patch Changes

- Blocks migration generation on dirty workspace closures: `diff` now fails with `SUPA_DIFF_MIGRATIONS_DIRTY` or `SUPA_DIFF_GENERATED_CONTRACT_DIRTY` when the migrations directory or generated TypeScript/Zod contracts have uncommitted changes, scoped `--schema` diffs fail with `SUPA_DIFF_CONFIG_DIRTY` or `SUPA_DIFF_SCOPED_DIRTY_SCHEMA` when config or out-of-scope schema files are dirty, and an uncommitted to-source tree warns with `SUPA_DIFF_TREE_UNCOMMITTED` before it can strand the lineage chain.

  Detects unreproducible pending baselines and adds a reviewed recovery lane: `supaschema migrations` classifies pending generated migrations whose lineage end-state matches neither `git:HEAD` nor the current tree (`SUPA_MIGRATIONS_STALE_BASELINE`), and `supaschema migrations --prune-stale` removes them after a target history check (`--force` for explicitly reviewed no-target recovery). `SUPA_MIGRATION_BASELINE_MISMATCH` now names its recovery paths.

  Bumps generated lineage markers to model format v3. Baselines recorded by an older model format warn with `SUPA_MIGRATION_BASELINE_FORMAT_DRIFT` instead of hard-blocking, while same-format mismatches still block; the next generated migration re-establishes versioned chain proof.

  Removes the `hints.routineDependencies` config allowlist and makes the `hints` schema strict. Routine dependency proof is now parser/model-owned: static SQL and PL/pgSQL bodies feed proven dependencies into planning, dynamic `EXECUTE` statements with provable string-literal or `format()` templates are statically extracted, and remaining unproven routines fail closed with `SUPA_ROUTINE_DEPENDENCY_PROOF_REQUIRED` when the same plan changes relations or types.

  Fixes catalog extraction for extension-owned objects, partitioned tables, materialized views, grants and default ACLs, comments, sequences, and composite types so live-database sources match declarative-tree extraction.

  Plans dependent-object rebuilds structurally: views, routines, partial indexes, composite/type replacements, and destructive column alters now order and rebuild their dependents from model-proven references.

## 0.3.13 (2026-06-25)

### Patch Changes

- Fixes generated migration replacement from a Git lineage baseline so `diff --replace` excludes the target migration from the source-intent corpus and does not compare against its own replacement output.
- Narrows routine dependency blocking to routines that actually overlap the changed relation or type, while allowing routines created or replaced in the same plan to carry their own dependency proof.
- Keeps partial PL/pgSQL dependency diagnostics actionable without leaking parser diagnostics as unrelated top-level parse errors.

## 0.3.12 (2026-06-25)

### Patch Changes

- Adds parser-backed routine dependency proof for SQL and PL/pgSQL routines, including fail-closed diagnostics for dynamic SQL.
- Uses the existing migration corpus as source intent for storage transitions, so destructive table-shape changes require reviewed DML or `DO` evidence instead of relying on destructive hints alone.
- Tightens generated migration safety with baseline, replacement, empty-plan, column-dependent rewrite, and Supabase security diagnostics across `diff`, `check`, rules, docs, and packaged agent guidance.

## 0.3.11 (2026-06-25)

### Patch Changes

- Extends parser-backed type generation for Supabase-shaped contracts, including set-operation CTE views, JSONB concat expressions, alias-preserving view columns, computed fields, and cross-schema relationship metadata.
- Restores target sync verification before migration handoff, so configured apply targets run disposable migration verification before the selected runner mutates the target database.
- Keeps generated TypeScript and Zod contract behavior aligned with the source schema model after the 0.3.10 release branch merge.

## 0.3.10 (2026-06-24)

### Patch Changes

- Fixes configured local Supabase CLI apply targets so they resolve the local `supabase/config.toml` database URL for history, safety, verification, and reconciliation instead of falling back to no-target disk-only status.
- Changes default type-safety and RLS-safety apply policies to `report_only`, keeping safety diagnostics visible without blocking normal apply unless a project explicitly opts into `deploy_blocking`.
- Fixes `verify` model materialization so disposable databases apply schema objects through the planner's dependency ordering rather than raw schema-file order.
- Improves AST reference collection and migration rendering for composite row-type dependencies, partition parents, and owned sequences so generated schema diffs replay in dependency order.

## 0.3.9 (2026-06-24)

### Patch Changes

- Aligns generated TypeScript helpers with Supabase-shaped table, insert, update, enum, and composite type contracts, including schema-qualified non-public schema usage.
- Replaces the legacy generated Zod helper surface with direct `Tables`, `TablesInsert`, `TablesUpdate`, `Enums`, and `CompositeTypes` runtime owners plus inferred helper types, including view row validators under `Tables`.
- Improves parser-backed view type inference for nested sources, CTEs, joins, qualified stars, positional column aliases, schema-qualified relation references, visible function overloads, predicate sublinks, JSON operators, arrays, booleans, and conservative unknown fallbacks.
- Updates type-generation docs and tests so generated contracts no longer reference retired compatibility helpers.

## 0.3.8 (2026-06-24)

### Patch Changes

- Adds an executable PostgreSQL support contract for parser-backed statement coverage, known `pgsql-deparser` gaps, and support-matrix/audit diagnostics.
- Preserves reviewed migration intent for routine drops and column drops, so destructive migration output is disclosed without adding redundant blockers after explicit review.
- Improves replay-safe rendering for owned dependents, reverse privilege changes, SQL routine catalog typecheck rewriting, and compatible view replacement ordering.
- Extends generated types for explicitly cast view targets and updates docs, rules, skills, packaged agent mirrors, and tests to match the implemented behavior.

## 0.3.7 (2026-06-24)

### Patch Changes

- Moves GitHub Release creation ahead of registry smoke in the main release workflow, so npm propagation lag cannot leave a package published without the matching GitHub release/tag.
- Updates release governance guards, rules, and docs so CI enforces the publish, attest, release, then registry-smoke order for fresh publishes and repair reruns.

## 0.3.6 (2026-06-23)

### Patch Changes

- Installs the packaged AI enforcement bundle during `supaschema init`, merging Claude and Codex hook configuration while preserving consumer-owned agent files.
- Expands setup detection so Supabase inventory schema trees use manual diff and migration-sync policy, and normal `init` preserves existing JSON config unless `--repair` is requested.
- Extends declarative source extraction, planning, rendering, and tests for more PostgreSQL table changes, including column identity, generated expressions, partition attachment, policies, indexes, and related SQL shape helpers.
- Adds generated Zod coverage for composite types and fixes the Stop-hook response evidence scanner so negative verification disclaimers are not treated as positive remote-check claims.

## 0.3.5 (2026-06-23)

### Patch Changes

- Makes `main` release runs fail closed when the current package version is already published, so release automation cannot silently skip creating a downloadable npm package.
- Adds post-publish registry smoke coverage that installs `supaschema@<version>` through npm, pnpm 11, and Bun after `npm publish`.
- Updates pnpm install guidance and package-manager smoke paths to use `--config.minimumReleaseAge=0` when a freshly published supaschema version must be available immediately.
- Fixes setup and agent guidance so pending `.supaschema/install.json` path confirmation is handled before `supaschema.config.json` validation or schema diffing.

## 0.3.4 (2026-06-19)

### Patch Changes

- Refactors `supaschema sync` into explicit ordered lanes for apply policy, source resolution, diff/output refresh, target selection, migration-history reconciliation, pending checks, deploy safety, runner apply, and final reconciliation or dry-run reporting.
- Preserves accumulated sync lane output when configured target resolution fails, so operators can see generated diff/output work before the refusal.
- Updates rule, skill, README, docs, CLI help, tests, and packaged agent-bundle mirrors so `sync` is documented as the composed apply workflow while individual commands remain available for each action lane.
- Keep default `supaschema init` from installing active AI-agent surfaces, leave the packaged agent bundle as reviewed manual-install files, and remove stale removed-flag documentation.

## 0.3.3 (2026-06-19)

### Patch Changes

- Restores full local Claude-to-Codex/.agents sync for maintainer rules, agents, hooks, and skills while keeping the public npm and GitHub agent surface limited to the supaschema-owned bundle.
- Tightens public repository guards and `.gitignore` so non-supaschema `.agents`, `.claude`, and `.codex` files stay local-only instead of being deleted to satisfy exposure checks.
- Updates GitHub process guidance, hook wiring, and scaffold hook merging so direct-main policy, DCO-safe pushes, and generated surface sync stay consistent across local and installed agent bundles.

## 0.3.2 (2026-06-18)

### Patch Changes

- `sources.from: "auto"` now resolves the previous Git schema tree before database URL fallbacks, so schema diffs work from committed declarative SQL without requiring a running database.
- `diff --schema` now filters managed-schema and unsupported-object diagnostics to the requested schema while keeping generated TypeScript and Zod outputs full-tree only.
- Config schema, docs, and agent guidance now match the 0.3.x migration-sync modes and route schema changes through the declarative SQL owner.
- `supaschema init` now reuses existing database URL environment variable names from consumer `.env*` files for generic PostgreSQL sync targets, defaults Supabase sync targets to the Supabase CLI runner, and no longer scaffolds local/production database credential placeholders.

## 0.3.1 (2026-06-18)

### Patch Changes

- Remove consumer install lifecycle scripts and make `supaschema init` write a concrete pnpm `allowBuilds.supaschema: true` approval in existing pnpm workspaces.

## 0.3.0 (2026-06-18)

- `supaschema sync` now runs the config-owned full pipeline: optional diff generation, migration safety checks, generated TypeScript/Zod refresh, type-safety and RLS-safety gates, independent target reconciliation, and guarded apply through direct PostgreSQL or Supabase CLI runners.
- The GitHub Action now consumes `scan --reporter json` and publishes the Postgres safety score to the job summary, a `supaschema scan` check run, and one updated pull-request comment when workflow permissions allow it.
- Repository distribution metadata is aligned for the package and GitHub policy: npm description/keywords now match the ORM-free, Docker-free, guarded-sync value proposition, and repository topics are owned by `.github/repo-policy.json`.
- The license Worker now also exposes authenticated `/contracts` storage for cross-repo schema contracts, while drift comparison remains in the package library through `contractDrift`.
- Canonical surface guards now reject legacy paths, duplicate owners, code/script comments, regex usage in active code roots, and deferred placeholder markers through one enforcement owner.

## 0.2.4 (2026-06-16)

- First-run setup now has a safe empty baseline: `sources.from: "auto"` resolves `git:HEAD`, then a database URL, then `empty:`, while pending `.supaschema/install.json` path confirmation blocks `config validate`, `doctor`, and zero-source `diff` until `schemaPaths`, `sources.to`, and `migrationsDir` are explicit.
- GitHub Action execution now accepts a structured `argv` JSON array instead of raw shell `args`, runs through a Node action runner with `shell: false`, and keeps the action pinned to an exact package version.
- Consumer install and package verification are tightened: `postinstall` delegates silently to the shared scaffolder, `supaschema init` remains the recovery path when lifecycle scripts are blocked, and `package:smoke` owns npm, pnpm, Yarn, and Bun install/init proof.
- Agent surfaces no longer carry the old skill-router hook system; Claude, Codex, and `.agents` mirrors now sync from the canonical owners without stale router scripts or post-edit consistency paths.
- Release and support surfaces now use `CHANGELOG.md` as the GitHub Release body source, add commercial/support intake docs and an issue template, and clarify unsupported boundaries such as publications/subscriptions, partitioning, event triggers, collations, and Supabase-managed storage/auth/realtime internals.
- Package lifecycle and action-runner guards now reject child-process args with `shell: true`, preventing Node DEP0190 warnings from leaking into package gates.

## 0.2.3 (2026-06-16)

- Consumer install behavior: npm install now writes the complete supaschema skill bundle directly to `.agents/skills/supaschema` and `.claude/skills/supaschema`, with the portable `npx skills supaschema` context kept as install guidance rather than an automatic install step.
- `.supaschema` state is now only used for pending install decisions such as ambiguous schema or migration paths; resolved installs no longer create an otherwise-empty project folder, and `install.json` remains the only durable state file when confirmation is needed.
- Package boundary and agent surfaces now ship whole skill directories for future `references/`, `scripts/`, and asset files, while Codex-specific packaged `.codex/skills` output is removed in favor of the `.agents` skill plus Codex rules and hooks.
- Agent hook recovery now turns `supaschema check` failures into loop-continuation feedback so Claude or Codex investigates the root source, searches for correlated migration failures, fixes the canonical owner, and reruns `supaschema check`.
- Formatting policy is tightened around `npm run format` as the only write/fix command; stale `lint:fix`, direct Ultracite, and direct Biome fix instructions were removed from rules, skills, docs, and guards.
- The pgformatter lane is removed: SQL formatting is governed by supaschema's renderer, deparse normalization, semantic checks, and PostgreSQL language tooling, and the shipped examples are restored after a local formatter failure had overwritten them.

## 0.2.1 (2026-06-16)

- Package boundary and release guidance: the npm allowlist is tightened around runtime code, generated config artifacts, README/license files, and the agent bundle needed by consumers; release/package docs and guards now make that boundary easier to audit before publish.
- Agent setup clarity: install/scaffold guidance now includes the consumer-facing agent prompt surface, keeps Claude/Codex/.agents mirrors aligned, and expands durable operator rules for worktree safety, security, file-size composition, prompt/context authoring, and context-surface synchronization.
- ADHD-first Mintlify documentation pass: navigation now follows reader jobs, entry and guide pages lead with the action to take, command reference pages use a shared compact template, and the former utility-command catch-all is split into one page per command.
- Docs component enforcement: `CardGroup` is the canonical docs card grid, cards must be iconed and short, oversized grids/callout stacks/title-case headings are linted, and the docs-standard test suite now includes adversarial malformed-component fixtures.

## 0.2.0 (2026-06-15)

- One-step consumer install: package install now prepares missing config, schema and migrations directories, Claude/Codex-compatible rule and skill files, hook scripts, hook wiring, and tagged `AGENTS.md` / `CLAUDE.md` addenda. `supaschema init` remains available as a no-clobber recovery command rather than a required second setup step.
- Provider-aware setup paths: install scans for existing schema and migration folders, detects Supabase, Neon, AWS RDS/Aurora PostgreSQL, Google Cloud SQL, AlloyDB, and Azure PostgreSQL markers, and records ambiguous candidates in `.supaschema/install.json` so agents or humans confirm paths before the first diff.
- Agent bundle hardening: generated-migration protection and schema-tree auto-diff/check hooks now respect configured paths, skip unsafe auto-diff while path confirmation is pending, and keep Claude and Codex policy surfaces aligned around `adapter: "auto"` and AST-first SQL handling.
- Documentation consolidation: Mintlify navigation is reduced to seven task-oriented groups; install/package contents are documented in one canonical place; installation examples now default to `npm install supaschema`; provider path defaults are centralized in Setup; quickstart schema examples no longer look like baseline migration filenames.

## 0.1.1 (2026-06-14)

- Documentation site at `supaschema.com/docs`: the Mintlify site moves to monorepo mode with the content root at `docs/`, served under the `/docs` subpath, with an expanded information architecture (per-command reference pages, concept deep-dives, environments/database-URL resolution, Supabase integration guide, library API reference) and redirects for renamed pages.
- Agent auto-run diff hooks: a PostToolUse hook for Claude Code and Codex senses a write to a schema-tree `.sql` file, runs `supaschema diff` then `supaschema check` to completion, and returns the generated migration name — or the blocking `SUPA_*` diagnostic — back to the agent as context. Wired in `.claude/settings.json` and `.codex/hooks.json`; the rules, skills, and `AGENTS.md` bundle describes the behavior.
- Benchmarks refreshed from the 2026-06-12 reference run (Supabase CLI 2.106.0, 13 adapters): head-to-head bar charts (median latency, accuracy F1, replay-safe chips) replace the scaling and workflow line charts, including a new full-workflow head-to-head — migration plus regenerated types in one command vs `db diff` + apply + `gen types` per engine.
- Example schemas drop the migration-style `001_` prefix (`examples/**/schemas/app.sql`) to read as declarative trees.

## 0.1.0 (2026-06-12)

Initial release.

- Pre-publish hardening: function-overload type generation unions every overload instead of silently keeping the first; `verify --ensure-environment` widens the `auth.users` stub to the full GoTrue column set and emits `SUPA_VERIFY_STUB_REFERENCE` when a failure references a still-minimally-stubbed managed schema; every benchmark fixture (including the hand-authored `additive`/`functions-policies`) carries a ground-truth manifest so accuracy is scored on all of them; the README accuracy section separates object-key F1 from the catalog-fingerprint objective oracle; a real-world case study (`docs/case-study-anilize.md`) measures the engine against a production ~8,300-object Supabase tree; and the install step no longer writes into the consumer project — it prints a `supaschema init` hint instead.
- Developer-experience batch: config JSON Schema generated from the Zod schema at build (`supaschema-config.schema.json`, `$schema` scaffolded into new configs for editor autocomplete); `check --reporter github|sarif|json` for PR annotations and code scanning plus `check -` stdin; `supaschema doctor` one-report environment triage (Node, parser, config, URL-resolution lane, reachability, `CREATEDB`, migrations history, tree); `diff --watch` editor loop (dry-run summary re-printed on `dir:` source changes); `verify --keep-databases` to preserve failed-run evidence; `supaschema fingerprint` one-line schema equality; `supaschema completion bash|zsh|fish`; NO_COLOR-aware colored drift summaries; committed composite `action.yml` (`uses: jmclaughlin724/supaschema@<tag>`); `dump:-` stdin source for piping `pg_dump`; named `environments` in config with a global `--env` flag; `--timing` extract/plan/render phase breakdown; husky pre-commit and bring-your-own-corpus recipes in docs; `typedoc` API reference via `npm run docs:api`.
- Dual licensing: AGPL-3.0-only for open-source use (`LICENSE`), with a commercial license required to embed supaschema in proprietary products or services without releasing source (`LICENSE-COMMERCIAL.md`).
- Diff-output accuracy scoring in the comparison harness: generated fixtures carry a ground-truth change manifest, every emitted statement is classified through the PostgreSQL parser (guard `DO` blocks unwrapped), and each run records recall, precision, and F1 (`outputRecall`/`outputPrecision`/`outputF1`), surfaced as the Output F1 column in the generated `summary.md`. Precision penalizes operations beyond the intent and destructive drop+create of data-bearing objects (tables, materialized views, sequences, schemas, types) — drop+create of recreateable metadata (policies, triggers, views, indexes, functions) is the standard change lane and is not penalized.
- Real-schema hardening (from benchmarking an 8,300-statement production Supabase tree): split GRANT/REVOKE statements for one object/grantee aggregate into a single canonical privilege-set identity at model assembly (matching the catalog lane's effective-ACL view, eliminating false `SUPA_EXTRACT_DUPLICATE_OBJECT` on real trees); standalone `ALTER TABLE ... ALTER COLUMN ... SET/DROP DEFAULT` (the pg_dump serial decomposition) folds into the owning table's canonical shape so inline-declared and ALTER-declared defaults hash identically.
- Empty-plan drift invariant: a plan with zero operations whose model fingerprints differ is a hard error (`SUPA_PLAN_EMPTY_WITH_DRIFT`, with differing keys named) — the "silently empty diff over real drift" failure mode observed in every Supabase CLI engine is structurally impossible.
- `supaschema audit --from <source> [--json]`: support-matrix coverage report — objects modeled by kind/schema plus every statement outside the contract grouped by diagnostic code; exit 2 when any exist.
- Verify environment pack: a capability preflight fails fast with `SUPA_VERIFY_ROLE_CAPABILITY` when the role lacks `CREATEDB`; `--ensure-environment` (default under adapter `auto`) stubs `auth.uid()`-family helpers, `auth.users`, and the cron schema in both temporary databases so Supabase trees verify against bare PostgreSQL (pg_cron can only install into one database per cluster).
- Foreign data wrapper tier: `CREATE FOREIGN DATA WRAPPER` (DO-guarded; no IF NOT EXISTS form upstream), `CREATE SERVER IF NOT EXISTS`, and `CREATE FOREIGN TABLE IF NOT EXISTS` are modeled as whole-object identities on both lanes (catalog via `pg_foreign_data_wrapper`/`pg_foreign_server`/`pg_foreign_table`, extension-owned wrappers excluded); drops and replaces are destructive-gated; user mappings stay excluded (credentials).
- Corpus oracle (`supaschema corpus`, `npm run corpus:check`, CI-wired): replays a committed dirty-real migrations corpus (`corpus/supabase-style/`) into a disposable database, cross-lane diffs against its declarative tree, applies the reconciliation twice, and requires reconvergence to zero (`SUPA_CORPUS_RECONVERGENCE`). Its maiden run drove three further parity fixes: `ALTER TABLE ONLY` normalization in RLS hashing, regclass cast unwrapping in canonical defaults (cast-vs-bare spelling), and suppression of grants implied by in-model `ALTER DEFAULT PRIVILEGES` on both lanes. DB-admin helpers consolidated into `src/database/admin.ts` (public API) along the way.
- Reconvergence gate in `verify` (`SUPA_VERIFY_RECONVERGENCE`): after apply-twice and fingerprint comparison, the migrated catalog is cross-lane diffed against the target _model_ and must produce zero operations — the structural detector for false drift, since fingerprints compare two databases built from the same models and cannot see modeling errors. Environment-pack stubs are subtracted by extracted key. On its first runs the gate surfaced and drove fixes for: initdb-baseline comments (`public` schema, `plpgsql`), `pg_init_privs` ACL subtraction on all four grant lanes (pg_dump's delta convention), grant/revoke statement-order netting, executor-role-independent default-privilege identity (FOR ROLE excluded from identity/hash), `TO PUBLIC` policy role reconstruction, catalog extraction under pinned empty `search_path` (qualified `pg_get_expr` output), and analyzed-expression normalization in policy hashing (auto-aliases, implicit constant casts).
- `supaschema sync`: opt-in repo/local/remote auto-sync orchestration — status reconciliation, ghost/out-of-order refusal, replay-safety gate on every pending migration, then explicit `--local` (`supabase migration up`) / `--remote` (`supabase db push`) runner execution with prompts intact; dry run by default. The runner keeps sole ownership of the history table.
- acldefault delta on both lanes (matching pg_dump): grants restating PostgreSQL's built-in defaults (PUBLIC EXECUTE on routines, PUBLIC USAGE on types) are suppressed; explicit revocations of those defaults are modeled on both lanes (catalog emits the revoke when a non-null ACL lacks the default entry); no-op revokes aimed at grantees with neither a default nor a model grant are suppressed; type/domain ACLs are now collected; default-ACL owner self-entries are skipped. On a real production schema this removed ~525 false-drift operations (707 → 182).
- Built-in `public` schema is never modeled as droppable; regclass cast literals canonicalize their identifier quoting so serial-style defaults hash identically across lanes.
- `supaschema migrations`: reconciles migration files on disk against a target's applied history table (Supabase's `supabase_migrations.schema_migrations` by default, `--history-table` for other runners) — applied/pending/ghost/out-of-order classification with supaschema lineage annotation on pending files; ghosts and out-of-order pending are errors. Run once per target to compare worktree, local, and remote states.
- Canonical-output normalization (`normalize: "deparse"`, default off): object SQL is deparsed back through PostgreSQL's grammar via `pgsql-deparser` (pure TypeScript, same parser lineage as `libpg-query`), making rendered migrations formatting-independent — differently formatted equivalent trees render byte-identical output. Fidelity-gated per object (canonical text accepted only when it reparses to the identical location-stripped tree; otherwise the source text is kept with a `SUPA_NORMALIZE_*` warning), and hashes never change because identity is AST-based. `check` always runs a deparse→reparse round-trip proof over migration SQL (`SUPA_CHECK_DEPARSE_MISMATCH`/`SUPA_CHECK_DEPARSE_UNSUPPORTED` warnings) so normalization is provably safe exactly where it is used.
- Benchmark harness: template-database cloning (seed once per fixture, `CREATE DATABASE ... TEMPLATE` per run), external fixture dirs (`SUPASCHEMA_COMPARE_FIXTURE_DIRS`), per-fixture `fixture.json` (schema list + supaschema adapter), `build-project-fixture.mjs` to turn a real declarative tree into a fixture, and `SUPASCHEMA_COMPARE_SEED_ROLE` ownership transfer working around the Supabase CLI silently omitting `supabase_admin`-owned objects from diffs (see benchmarks/README.md for the bisected CLI findings).

- AST-only extraction and rendering: every statement is classified through the PostgreSQL parser (`libpg-query`); no regex statement classification or rewriting. Statement text is sliced from parser-reported offsets, and replay guards are spliced at AST-located offsets carried in extraction metadata.
- AST identity hashing: objects hash a location-stripped parse tree (guard flags excluded), with canonical structural shapes for tables (typmod-aware column types, hoisted inline constraints, column-type-cast-unwrapped defaults) and sequences (default-normalized options), so `dir:` sources and `database:` catalogs hash the same definition identically across keyword case, identifier folding, type aliases, constraint placement, option ordering, and guard spellings — verified by a hard-case parity fixture and a seeded round-trip fuzz suite against live PostgreSQL.
- Column-level ALTER lane: when only columns change, hinted plans render data-preserving `DROP COLUMN IF EXISTS` and `ALTER COLUMN ... TYPE ... USING` statements (NOT NULL/DEFAULT changes need no hint) instead of replacing the table; identity/generated changes still fall back to the hint-gated replace lane.
- Decomposition-independent constraint identity: every table constraint — inline, in-CREATE, ALTER-declared, or read from `pg_constraint` — is its own `constraint:` object with a canonical shape hash, table identity carries columns only (PK-implied NOT NULL preserved), unnamed in-CREATE constraints get PostgreSQL default names, constraint-backed indexes are excluded from catalog index objects, and routine identity uses argument types only (`oidvectortypes`) on every lane. Verified end to end by `supaschema selfcheck`, which re-extracts a live catalog's rendered SQL and reports any object whose identity diverges (`SUPA_SELFCHECK_*`).
- Drift triage ergonomics: `diff --summary` prints operation/diagnostic counts grouped by kind and schema even when the plan is blocked; `diff --write-hints <file>` writes the gated destructive object keys as a reviewable `hints.destructive` skeleton; gated table replaces name the differing columns; `SUPA_EXTRACT_UNSUPPORTED` names the parse-tree tag and statement head; `SUPA_SUPABASE_MANAGED_SCHEMA` suggests the `schemas.exclude` config fix.
- Structured verify failures: `SUPA_VERIFY_FINGERPRINT_MISMATCH` names the objects that are missing, unexpected, or definition-different instead of printing two opaque hashes; model snapshots carry a `formatVersion` and stale `catalog:` snapshots warn (`SUPA_CATALOG_SNAPSHOT_VERSION`).
- `verify --ensure-roles` pre-creates missing NOLOGIN roles referenced by grants, default privileges, and policies (cluster-level, never dropped) so verification servers without Supabase roles can run fixture verifies.
- Non-transactional split output: under `adapter: "postgres"`, `diff --out <file>` writes `CREATE INDEX CONCURRENTLY` statements to a `<file>.concurrent.sql` companion so the main migration stays transaction-safe.
- Grant normalization: enumerated privilege sets that cover the full PostgreSQL 15 baseline for an object kind collapse to `ALL` in both lanes, keeping `GRANT ALL` comparable against catalog-enumerated ACLs across PostgreSQL majors.
- Batched catalog extraction: table columns and constraints load in one query each across all tables (was two queries per table), and object finalization parses in bounded-concurrency batches.
- Migration lineage and write safety: rendered migrations embed a machine-readable `-- supaschema: lineage from=... to=...` marker; `diff` writes are no-clobber (`SUPA_DIFF_OUTPUT_EXISTS`); and a chain gate blocks broken lineage (`SUPA_DIFF_LINEAGE_BROKEN`) and duplicate transitions (`SUPA_DIFF_LINEAGE_DUPLICATE`) against pending supaschema migrations in the output directory, bypassable with `--no-check-chain`.
- Generated-output standards suite: every fixture-rendered migration is asserted to parse through the PostgreSQL parser, pass supaschema's own replay checker, carry the timeout preamble, qualify catalog references, never emit CASCADE, and (env-gated) survive apply-twice verification.
- Zero-config setup: `supaschema init` scaffolds `supaschema.config.json` in the consumer project (no-clobber; the install step prints a one-line hint to run it), and database URLs auto-resolve — explicit flag, then `SUPASCHEMA_DATABASE_URL`, then the local Supabase stack discovered from the nearest `supabase/config.toml` (`[db] port`, Supabase default 54322 when omitted). `verify --database-url` is now optional, tests/benchmarks auto-resolve or skip, and CI sets one job-level `SUPASCHEMA_DATABASE_URL`; `resolveDatabaseUrl`/`resolveSupabaseLocalDatabaseUrl` are exported library API.
- AI agent surfaces ship in the package: `AGENTS.md` operator brief, a Claude Code rule + workflow skill + PreToolUse hook, a Codex rules file + native PreToolUse hook, and a runtime-neutral `.agents` skill mirror. Both hooks block hand-edits to generated migrations (the `-- supaschema: lineage` marker) and are covered by focused tests.
- Transaction fidelity: `transactionMode: "per-migration"` (default) makes `verify` apply the migration inside one transaction, mirroring `supabase db push`; enum add-then-use in the same file and `CREATE INDEX CONCURRENTLY` are surfaced as errors instead of passing a per-statement verify.
- Replace-compatibility gates: view replacements that drop/rename/reorder output columns and routine replacements that change the return type or OUT parameters become destructive-gated drop+create instead of failing `CREATE OR REPLACE` at apply time.
- Catalog-qualified guards: all `DO`-block existence checks reference `pg_catalog.*` so search_path cannot redirect them.
- Supabase posture: public views without `security_invoker` warn under `adapter: "auto"`; `excludedGrantRoles` and config-level `schemas.include`/`schemas.exclude` filters; `diff --json` and `diff --fail-on-diff` (exit 3) for CI drift gates.
- Typed object model for schemas, extensions, enums (with values), domains, composite types, sequences, tables (with structured column facts), constraints, indexes, functions/procedures (identity signatures from parameter ASTs), views, materialized views, triggers, RLS, policies, structured grants, default privileges, and comments keyed by structured descriptors.
- Deterministic diff planner: object identity + definition hash, AST-collected dependency edges (including SQL function bodies), topological ordering with traced cycle diagnostics, hint-gated destructive changes, hint-gated guarded renames, safe additive column alters, and append-only enum widening rendered as `ALTER TYPE ... ADD VALUE IF NOT EXISTS`.
- Replay-safe renderer: `IF NOT EXISTS` / `DROP IF EXISTS` / `CREATE OR REPLACE` templates, catalog-guard `DO` blocks for types and constraints, structured `REVOKE` rendering for dropped grants and default privileges, configurable `lock_timeout`/`statement_timeout` preamble, version-stamped header with an operation summary, and a transaction note for concurrent indexes.
- AST-based migration checks: replay-safety guards, `CASCADE` ban, session `search_path` ban, `SECURITY DEFINER` search-path warning, non-transactional statement warnings (concurrent index/refresh), lock-hazard warnings (`ALTER COLUMN TYPE`, `SET NOT NULL`, volatile-default `ADD COLUMN`), and replay guards for data statements (`INSERT ... ON CONFLICT` required; `UPDATE`/`DELETE` flagged for review).
- Live catalog extraction over parallelized read-only `pg_catalog` queries, including enums, domains, composite types, sequences (with ownership), generated/identity columns, comments, ACL-derived grants, and default privileges; partition children are excluded.
- Apply-twice verification against disposable databases with catalog fingerprint comparison.
- CLI: `init`, `inspect`, `plan`, `diff` (`--name` timestamped output, `--dry-run`, `--schema` filter), `check`, `verify`, `explain`, global `--config`/`--quiet`, documented exit codes, and a version sourced from `package.json`.
- Config: strict schema, JSON or ESM module config files, configurable timeouts, hints for destructive changes and renames, optional external validators (`squawk`, `postgres-language-server`, external SQLFluff/pgFormatter).
- Diagnostics catalog with `supaschema explain`, and secret redaction in diagnostic output.
- Threshold-enforced benchmark suite (`npm run benchmark`) covering every diff/proof path: a deterministic Supabase-shaped realistic fixture generator (tables with FKs, RLS, triggers, views, materialized views, functions, grants, comments, and a mixed change set) backing tree/live-catalog/shadow lanes, a no-drift lane asserting an empty plan on identical sources, and end-to-end benchmarks (small and 250-table large) from source extraction through planning and rendering to the migration applied transactionally with a catalog-fingerprint assertion; cross-tool comparison harness (`npm run bench:compare`, 10-iteration default) sharing the realistic fixture, with per-attempt latency timing and transactional apply verification.
