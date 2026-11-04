# supaschema

<p align="center">
  <img src="docs/public/images/brand/supaschema-logo-readme.png" alt="supaschema logo" width="720">
</p>

[![CI](https://github.com/jmclaughlin724/supaschema/actions/workflows/ci.yml/badge.svg)](https://github.com/jmclaughlin724/supaschema/actions/workflows/ci.yml) [![npm version](https://img.shields.io/npm/v/supaschema)](https://www.npmjs.com/package/supaschema) [![npm downloads](https://img.shields.io/npm/dm/supaschema)](https://www.npmjs.com/package/supaschema) [![node](https://img.shields.io/node/v/supaschema)](https://github.com/jmclaughlin724/supaschema/blob/main/package.json) [![license](https://img.shields.io/npm/l/supaschema)](https://github.com/jmclaughlin724/supaschema/blob/main/LICENSE) [![codecov](https://codecov.io/gh/jmclaughlin724/supaschema/branch/main/graph/badge.svg)](https://codecov.io/gh/jmclaughlin724/supaschema) [![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/jmclaughlin724/supaschema/badge)](https://scorecard.dev/viewer/?uri=github.com/jmclaughlin724/supaschema) [![install size](https://packagephobia.com/badge?p=supaschema)](https://packagephobia.com/result?p=supaschema)

[Documentation](https://supaschema.com/docs) | [Install](https://supaschema.com/docs/installation) | [Quickstart](https://supaschema.com/docs/quickstart) | [Commands](https://supaschema.com/docs/commands) | [Benchmarks](https://supaschema.com/docs/benchmarks) | [Coding agents](https://supaschema.com/docs/coding-agents)

**Declarative PostgreSQL schema management: fast, AI-ready, and zero-config. Generate replay-safe migrations, TypeScript types, and Zod validators from SQL files with no ORM schema layer, Docker, or shadow database.**

Use it with plain PostgreSQL or hosted providers such as Supabase, Neon, RDS/Aurora, Cloud SQL, AlloyDB, and Azure PostgreSQL.

Free and open source under MIT. Install the package, run `supaschema init`, and use zero-flag commands from the project that owns the schema.

```bash
supaschema sync  # diff, check, types, stage, safety, apply/dry-run, reconcile
supaschema rebaseline  # dry-run a whole-history baseline replacement
```

![supaschema vs diff engines at 1,000 tables: median diff latency bars](docs/public/images/benchmarks/head-to-head-xl-bars.svg)

## Why supaschema

Declarative database workflows usually make the database part of the edit loop: replay a schema into a Docker shadow database, diff that database, apply the result, then introspect again to regenerate application types.

supaschema keeps the schema workflow inside the repository. It ships PostgreSQL's parser in the package, parses SQL files into a structural model, mines existing migrations for source intent, diffs object definitions, renders guarded migration SQL, and regenerates TypeScript and Zod outputs from the same tree.

- **Fast feedback:** generating a diff does not require Docker or a shadow database; the measured large-schema results are shown directly above and detailed in the benchmark docs.
- **One schema owner:** PostgreSQL SQL remains the source of truth; generated migrations, TypeScript types, and Zod validators follow from it.
- **Replay safety:** generated SQL uses guarded operations and is checked statically before apply.
- **Reviewable risk:** destructive changes and renames fail closed until exact object-level hints approve them.
- **AI-ready workflow:** `supaschema init` installs or merges package-owned Claude, Codex, and AGENTS-compatible surfaces so teams can block generated migration edits and run schema-write checks.

## Proof

The benchmark harness applies every generated migration once, applies it again, and compares the resulting catalog with the target schema.

- At 1,000 tables, the 2026-07-21 run measured supaschema at `2.08-2.53s` versus `38.7-57.7s` for the five Supabase CLI diff engines.
- At 2,500 tables, supaschema measured `4.71-5.80s` versus `268-352s` for those engines.
- supaschema scores F1 `1.000` on every manifest-carrying fixture in source-file, live-catalog, and full-workflow modes.
- Successful Supabase direct and workflow output scores `0.800-1.000`; on the realistic, XL, and XXL fixtures it misses the same RLS policy body change, and on additive, realistic, XL, and XXL it fails the second-apply check.

The publication set retains four measured Supabase command failures (three on the smallest fixtures and one at XL) rather than replacing individual rows. There were no supaschema failures, timeouts, skips, or unsupported rows.

Read the [benchmark methodology](https://supaschema.com/docs/benchmarks), the [Supabase CLI comparison](https://supaschema.com/docs/comparisons/supaschema-vs-supabase-cli), and the [anilize case study](https://supaschema.com/docs/case-study-anilize). Reproduce the local benchmark harness with:

```bash
export SUPASCHEMA_COMPARE_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable'
SUPABASE_TELEMETRY_DISABLED=1 BENCH_ALL_SEQUENTIAL=1 bash benchmarks/tools/bench-all.sh
npm run bench:plot:docs
```

Use only a disposable local PostgreSQL instance. Publication results are advisory evidence, not a CI gate.

## How it fits

supaschema replaces the PostgreSQL schema-management lane: schema diff, migration generation, safety checks, generated contracts, drift gates, staging, and guarded apply. Individual commands stay available for each action, including explicit runtime verification when a disposable database is intentionally available. Keep another tool when its distinct runtime, platform runner, query API, hosted dashboard, or cross-database scope is the part you intentionally want.

- Use it beside Supabase when you want Supabase project resources but do not want Docker-backed `db diff` as the migration generator.
- Use it beside Prisma or Drizzle when you want their query or client APIs but do not want an ORM schema DSL to own PostgreSQL intent.
- Use it beside Flyway or Liquibase when those tools own operational rollout but supaschema owns generated PostgreSQL migration SQL and checks.
- Use it beside Squawk or pgfence when you still need generation from declarative SQL, generated contracts, and apply-twice verification.

Detailed comparisons: [Supabase CLI](https://supaschema.com/docs/comparisons/supaschema-vs-supabase-cli), [Atlas](https://supaschema.com/docs/comparisons/supaschema-vs-atlas), [Prisma](https://supaschema.com/docs/comparisons/supaschema-vs-prisma), [Drizzle](https://supaschema.com/docs/comparisons/supaschema-vs-drizzle), [Squawk](https://supaschema.com/docs/comparisons/supaschema-vs-squawk), [pgfence](https://supaschema.com/docs/comparisons/supaschema-vs-pgfence), [Flyway](https://supaschema.com/docs/comparisons/supaschema-vs-flyway), and [Liquibase](https://supaschema.com/docs/comparisons/supaschema-vs-liquibase).

## Install

Install from the package or workspace directory that owns the schema workflow.

| Manager | Install command | Setup command | Run command |
| --- | --- | --- | --- |
| npm | `npm install supaschema` | `npm exec -- supaschema init` | `npm exec -- supaschema <cmd>` |
| pnpm | `pnpm add supaschema` | `pnpm exec supaschema init` | `pnpm exec supaschema <cmd>` |
| Yarn | `yarn add supaschema` | `yarn exec supaschema init` | `yarn exec supaschema <cmd>` |
| Bun | `bun add supaschema` | `./node_modules/.bin/supaschema init` | `./node_modules/.bin/supaschema <cmd>` |

Requires Node 22.12+. Commands that inspect, apply, or verify against a database expect PostgreSQL 15+.

Run both install and setup from the package or workspace directory that owns the schema workflow. `supaschema init` is idempotent. It reads the consuming repo's package manager, workspace owner, provider markers, schema paths, and migration paths, then writes the config, directories, generated-output paths, package-owned AI-agent enforcement, and path-confirmation state when needed. Raw AI-agent rules, hooks, skills, prompts, and settings also ship under `node_modules/supaschema/agent-bundle/` for audit and skipped-file repair. Workspace caveats live in the [installation guide](https://supaschema.com/docs/installation).

## Workflow

Edit the configured schema SQL files, then run the full workflow:

```bash
supaschema sync
```

Use `diff`, `check`, `types`, `stage`, or `apply` only when you need one focused lane. `sync` refreshes generated contracts even when no migration is pending and refuses multiple automatic targets because cross-target apply is not atomic.

Zero-flag commands read `supaschema.config.json`. Diff sources can be schema directories, Git refs, live read-only catalogs, SQL dumps, saved catalog snapshots, an empty baseline, or the configured migration corpus as a before-state. Full flags, defaults, and exit codes live in the [commands reference](https://supaschema.com/docs/commands) and [sources guide](https://supaschema.com/docs/concepts/sources).

Read config as four decisions: `schemaPaths` and `migrationsDir` define the recursive target tree, migration output, and migration-derived source-intent corpus; `sources.from` defines the baseline while explicit alternates use `--from` or `--to`; `typesFile` / `zodFile` plus workflow type policies define generated contracts; and `workflow.migration_sync` plus `sync.targets` defines apply behavior.

## What ships

| Surface | What it gives you |
| --- | --- |
| CLI | `diff`, `stage`, `apply`, `types`, `check`, `verify`, `sync`, `rebaseline`, `scan`, `migrations`, `config validate`, inspection commands, diagnostics, and shell completion. |
| Library | Typed ESM exports for the same core pipeline, including extraction, planning, rendering, checking, verification, apply/sync, type generation, and config loading. |
| Agent bundle | A public-safe prompt, rules, skills, and hooks for Claude, Codex, and AGENTS-compatible tools working in a consuming repository. |
| Docs site | Task guides, command pages, configuration references, comparison pages, support matrix, diagnostics, and support guidance. |

See [what's included](https://supaschema.com/docs/whats-included), [library API](https://supaschema.com/docs/reference/library-api), and [coding agents](https://supaschema.com/docs/coding-agents).

## Safety model

supaschema is fail-closed. Unsupported DDL blocks instead of passing through. Destructive changes and renames require explicit object-level hints. `CASCADE` is never emitted. Data statements stay outside the declarative schema shape, but existing reviewed migrations are source intent that must be modeled or preserved before blocking. Diagnostics redact credential-shaped values.

The support matrix covers schemas, extensions, types, domains, tables, foreign data wrappers, foreign servers, foreign tables, constraints, indexes, sequences, functions, procedures, views, materialized views, triggers, RLS, policies, grants, default privileges, comments, and intentionally unsupported boundaries.

Read [hints and recovery](https://supaschema.com/docs/configuration/hints), [diagnostics](https://supaschema.com/docs/reference/diagnostics), and the [support matrix](https://supaschema.com/docs/reference/support-matrix).

## Development

```bash
npm run check           # build, lint, typecheck, and tests
npm run fixture:verify  # render a fixture migration, apply twice, compare catalogs
npm run corpus:check    # replay a dirty-real corpus and require reconvergence
npm run benchmark       # threshold-enforced benchmarks
```

## Project

Public bugs and feature requests belong in [GitHub issues](https://github.com/jmclaughlin724/supaschema/issues). Do not put secrets, database URLs, customer data, or private schema dumps in public issues.

supaschema is an independent open-source project and is not affiliated with or endorsed by Supabase.

## License and support

supaschema is free and open source under the [MIT License](LICENSE).

Use [GitHub issues](https://github.com/jmclaughlin724/supaschema/issues) for public bugs and feature requests, and read the [support guide](https://supaschema.com/docs/reference/support) before sharing project details.
