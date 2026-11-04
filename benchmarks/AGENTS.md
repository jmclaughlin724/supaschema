# Benchmarks

This harness compares `supaschema` against Supabase CLI schema diff engines. It writes machine-readable JSON and SVG charts.

## Run

For the complete publication run, start a disposable local PostgreSQL instance, point the harness at it, serialize all fixtures to avoid cross-fixture CPU contention, and then rebuild every tracked chart:

```bash
export SUPASCHEMA_COMPARE_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres?sslmode=disable'
SUPABASE_TELEMETRY_DISABLED=1 BENCH_ALL_SEQUENTIAL=1 bash benchmarks/tools/bench-all.sh
npm run bench:plot:docs
```

Never use a development, staging, or production database for this command. The harness creates and drops comparison databases. Publication benchmarks are dated advisory evidence, not CI gates; record the package, hardware, OS, Node, PostgreSQL server, Supabase CLI, fixtures, warmups, and measured iterations with the results. Do not rerun or replace an individual measured failure in a publication set; retain it and report the complete serialized run.

For a focused local comparison instead:

```bash
SUPASCHEMA_COMPARE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  npm run bench:compare

npm run bench:plot
```

`bench:plot` accepts any number of result JSON files plus an optional output directory and emits one artifact set per fixture (sample size), so each scale is saved and read separately. `--charts-dir <dir>` sends the SVG charts to a different directory than the data artifacts:

```bash
node benchmarks/plot.js benchmarks/results/comparison.json benchmarks/results/comparison-xl.json
```

Outputs:

- `benchmarks/results/comparison.json` — raw rows from `bench:compare` (use `SUPASCHEMA_COMPARE_OUT` to direct separate runs to separate files, e.g. `comparison-xl.json`)
- per fixture: `<fixture>-latency.svg`, `<fixture>-correctness.svg`, and `<fixture>-results.json` (that fixture's rows plus source-run metadata)
- `summary.md` — per-fixture result tables plus a cross-fixture scaling table (each tool's median and its ratio vs its own smallest fixture)

The published chart set in `docs/public/images/benchmarks/` (per-fixture latency/correctness charts plus the four head-to-head charts: the README hero bars-only xl chart, full xl, xxl, and the full-workflow lane) is rebuilt in one command from the four reference comparison JSONs:

```bash
npm run bench:plot:docs
```

## Tool Selection

By default the harness attempts `supaschema` plus every Supabase `db diff` engine available in the installed CLI. Limit the run with comma-separated filters:

```bash
SUPASCHEMA_COMPARE_TOOLS=supaschema-file,supaschema-db,supabase-pg-delta \
SUPASCHEMA_COMPARE_FIXTURES=additive \
SUPASCHEMA_COMPARE_ITERATIONS=10 \
SUPASCHEMA_COMPARE_TIMEOUT_MS=30000 \
SUPASCHEMA_COMPARE_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  npm run bench:compare
```

The harness refuses non-local database hosts by default because it creates and drops temporary databases. Set `SUPASCHEMA_COMPARE_ALLOW_REMOTE=1` only for disposable remote benchmark clusters. Use `SUPASCHEMA_COMPARE_PORT_BASE` to move the per-run Supabase temp project ports away from local conflicts.

Real-project fixtures: `node benchmarks/tools/build-project-fixture.mjs --tree <schemas dir> --out <fixture dir>` turns an actual declarative tree into a fixture (fixpoint statement ordering, Supabase auth stubs, support-surface filtering with a `dropped.log`, and a `fixture.json` carrying the schema list + supaschema adapter). Point the harness at it with `SUPASCHEMA_COMPARE_FIXTURE_DIRS=<fixture dir>` so private schemas never enter the package tree.

When the compare admin URL is `supabase_admin` (required to install most extensions on a local Supabase stack), also set `SUPASCHEMA_COMPARE_SEED_ROLE=postgres`: after seeding, the harness transfers ownership of every user-schema object to that role so Supabase diff engines compare seeded user objects consistently. Historical Supabase CLI behavior notes from the 2026-06-11 benchmark investigation live in `benchmarks/REFERENCE_RESULTS.md`.

The default is 10 measured iterations plus 1 warmup per adapter/fixture pair. A full default run across all adapters and fixtures takes tens of minutes because Supabase engines and realistic-fixture seeding dominate; use the filters above for quick local passes.

Fixtures: the on-disk pairs under `benchmarks/fixtures/` (`additive`, `functions-policies`) plus a generated `realistic` fixture — a deterministic 50-table Supabase-shaped schema (FKs, RLS policies, triggers, views, materialized views, functions, grants, comments) with a mixed change set, materialized at run time from the shared `dist/benchmark/fixtures.js` generator. Set `SUPASCHEMA_COMPARE_XL_TABLES` (for example `1000` for ~7000 objects) to add an `xl` fixture at that table count; it is opt-in because shadow-database engines take minutes per run at that scale — raise `SUPASCHEMA_COMPARE_TIMEOUT_MS` accordingly.

Adapters:

- `supaschema-file` — `diff` between two SQL dumps (diff only)
- `supaschema-db` — `diff` between two live catalogs (diff only)
- `supabase-default` / `supabase-migra` / `supabase-pg-delta` / `supabase-pg-schema` / `supabase-pgadmin` — `supabase db diff` per engine (diff only)
- `supaschema-workflow` — the full real-world step measured as one command: `sync` writes the migration and refreshes `database.types.ts` + `database.zod.ts` (TypeScript types **and** runtime Zod validators) in the same invocation
- `supabase-*-workflow` — the same real-world step for each Supabase engine: `db diff`, apply the generated migration to the database (types cannot regenerate from unapplied SQL), then `supabase gen types --lang=typescript --db-url` (TypeScript only; no validators)

Both workflow lanes are spawned through the same `tools/run-workflow.mjs` wrapper, so per-process overhead is identical on both sides. Workflow rows are charted separately (the `head-to-head-workflow-xl.svg` chart, via `plot-head-to-head.js --workflow`) and excluded from the diff-only charts; never average the two lanes together. The captured output of a workflow run is still the generated migration, so verification and accuracy scoring apply to workflow rows unchanged.

## Reading Results

Use latency charts for speed and correctness charts for whether generated output:

- applied once,
- applied twice,
- matched the target catalog fingerprint after the first and second apply.

`matchesTargetAfterFirstApply` and `matchesTargetAfterSecondApply` are recorded separately in the JSON. `matchesTargetFingerprint` is true only when first apply matches, second apply succeeds, and second apply still matches. Command failures, skips, and unsupported adapters remain visible in the correctness chart.

Timing fields: `elapsedMs` is the final command attempt only and is what the latency chart plots; `totalElapsedMs` additionally includes retry sleeps and failed environmental attempts (for example Supabase shadow-port conflicts), with `attempts` recording how many runs happened.

Accuracy fields (generated fixtures only, which carry a ground-truth change manifest): `outputRecall`, `outputPrecision`, and `outputF1` score the generated SQL's content against the manifest, with `outputMissedSample`/`outputExcessSample` naming up to 8 missed or spurious object keys. Every emitted statement is classified through the PostgreSQL parser (supaschema guard `DO` blocks are unwrapped and classified too). Precision penalizes operations beyond the manifest and destructive drop+create of data-bearing objects (tables, materialized views, sequences, schemas, types/domains); drop+create of recreateable metadata (policies, triggers, views, indexes, functions) is the standard PostgreSQL change lane and is not penalized. `summary.md` reports the per-tool mean as the Output F1 column.

Verification applies the fixture `from` state per statement, then applies the generated migration in one transaction per apply — mirroring runners like `supabase db push` — so transactional failures are not masked by autocommit.

Do not average all modes together. Source-file diff, live-catalog diff, and replay verification measure different work.

## Reference Results

Dated reference runs belong in benchmark reports, not automatic agent context. The current 2026-07-21 publication run lives in `benchmarks/REFERENCE_RESULTS.md`. Generated per-run tables live in `summary.md` under the selected benchmark output directory. `npm run benchmark` remains a separate advisory internal threshold suite.
