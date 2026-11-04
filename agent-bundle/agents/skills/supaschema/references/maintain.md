# Maintain — drift, history, and maintenance changes

Goal: restore a configured project to a **zero-drift, replay-safe, generated-contract-current** state.

Start by reading `supaschema.config.json`, the configured schema trees, and the existing migration directory. Classify drift only after you know what the configured sources actually claim.

## 1. Drift gate

```bash
supaschema --quiet diff --fail-on-diff
```

Read the exit code before continuing. Using the shared exit-code contract:

| Exit | Here it means | Next step |
| --- | --- | --- |
| `0` | no planned operations between the configured sources | contracts, history, and safety may still need attention |
| `3` | drift exists and a reviewed migration is required | generate and review it |
| `1` | runtime or argument failure | fix the invocation or environment |
| `2` | one or more diagnostics are errors | decode in [diagnostics.md](diagnostics.md) |

Exits 1 and 2 are command failures, not drift success. This same command is the CI gate.

**This compares configured sources, not the live database.** With the default `sources.from: "auto"` the before-state resolves to `git:INDEX`, `git:HEAD`, or `empty:` — never a database. A database that drifted out of band still returns exit 0. To gate against live state, pass an explicit database source:

```bash
supaschema --quiet diff --fail-on-diff --from 'database:$DATABASE_URL'
```

When drift is large or blocked, triage before editing anything:

```bash
supaschema diff --summary            # operation/diagnostic counts by kind and schema, printed even when blocked
supaschema diff --write-hints <file> # reviewable hints.destructive skeleton (no-clobber)
supaschema audit --from <source>     # modeled coverage plus statements outside the contract, by code
supaschema selfcheck                 # re-extract a live catalog and report identity divergence
```

`selfcheck` reporting zero `SUPA_SELFCHECK_*` mismatches proves cross-lane identity parity.

## 2. Reconcile migration history

```bash
supaschema migrations --json
```

This classifies on-disk migrations against a target's applied history: applied, pending, ghost, or out-of-order. Resolve every pending, ghost, out-of-order, stale-baseline, or lineage finding **in its owning source** before generating anything new.

`SUPA_MIGRATIONS_STALE_BASELINE`: when no configured target records the pending generated version as applied, review the SQL and remove it through `supaschema migrations --prune-stale` with a resolved target, or `--force` only after explicit review. Hand-deleting lineage migrations is not a routine recovery path.

**`--prune-stale` sees one target per invocation.** It classifies against the single database URL resolved for that run and deletes the resulting stale-baseline files. In a multi-target project, a version that is pending on the resolved target but already applied on another will be deleted, leaving that other target with a ghost version. Run `supaschema migrations --json` against every configured target and confirm the version is absent from all of them before pruning.

## 3. Rebaseline from the declarative tree

Use whole-history re-baselining only after explicit user approval and while one session owns schema closure.

```bash
supaschema rebaseline
supaschema rebaseline --write
```

The dry run inventories the migration-only operations that the new history will discard and plans a baseline from `empty:` to the configured declarative tree. Review that inventory before `--write`. The write lane checks and verifies the rendered baseline before replacing history, refreshes generated contracts, and stages old-migration deletions with the new baseline and contracts. It does not apply to or repair a target. Rebuild or reconcile a local target only through a separately authorized local operation; never re-baseline linked/production state from a developer machine.

Direct `git rm`, filesystem deletion, patch deletion, and editor deletion remain forbidden. `migrations --prune-stale` stays the narrow pending-generated recovery lane, not a whole-corpus replacement lane.

## 4. Re-prove safety and contracts

```bash
supaschema check
supaschema types
```

Run the full migration-directory replay check unless the owning workflow intentionally selects a narrower changed-file lane. In CI, gate with `supaschema types --check` instead: it compares regenerated contracts (including the provenance header) against on-disk outputs without writing, and fails with `SUPA_TYPES_CONTRACT_DRIFT` until `supaschema types` refreshes them. Fix unsafe SQL or stale model coverage in the canonical schema, migration, parser, or type-generation owner and regenerate — never by patching the generated file.

## 5. Review the generated deltas

Read every generated-file delta against declared schema intent, and look specifically for unexpected destructive behavior. Rendered `-- supaschema: operation ...` comments disclose destructive or drop-guard intent; that disclosure is a review aid, not a second blocker once the planner has allowed the operation.

A maintenance pass is also the natural point to re-run the safety lane, since drift often lands new tables without RLS or over-broad grants:

```bash
supaschema scan
supaschema type-contract
```

See [safety.md](safety.md) for the rule packs, grading, and the deploy-safety policy fields.

## 6. Prepare the maintenance change

Re-run the drift gate after regeneration. A maintenance change should contain only:

- the source intent that changed;
- the generated migration, when drift exists;
- refreshed TypeScript and Zod contracts;
- the command evidence needed to review them.

Keep it focused. Prepare the pull request only after the drift gate, history reconciliation, replay checks, and generated-contract review are all green.

Applying migrations and publishing the branch are separately authorized actions. Do not stage, commit, push, or open a pull request without the user's authorization.
