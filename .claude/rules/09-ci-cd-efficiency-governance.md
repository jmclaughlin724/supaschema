---
description: GitHub Actions CI/CD efficiency, release governance, supply-chain hardening, and npm trusted publishing.
paths:
  - ".github/**"
  - "action.yml"
  - "package.json"
  - "package-lock.json"
  - "scripts/actions/**"
  - "scripts/github/**"
  - "scripts/release/**"
  - "scripts/guards/ci-release/**"
  - "tests/release/**"
---

# Rule 09 - CI/CD efficiency and release governance

## Contract

This rule owns workflow posture for CI, release, docs, Python, supply-chain checks, Scorecard, dependency review, release provenance, and npm trusted publishing.

Sources:

- GitHub Actions workflow syntax: <https://docs.github.com/en/actions/writing-workflows/workflow-syntax-for-github-actions>
- GitHub Actions environments: <https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment>
- GitHub Actions secure use (security hardening): <https://docs.github.com/en/actions/reference/security/secure-use>
- GitHub Actions security hardening for OIDC: <https://docs.github.com/en/actions/concepts/security/openid-connect>
- Artifact attestations / build provenance: <https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations>
- npm trusted publishing (OIDC): <https://docs.npmjs.com/trusted-publishers>
- GitHub CLI release creation: <https://cli.github.com/manual/gh_release_create>
- OpenSSF Scorecard checks: <https://github.com/ossf/scorecard/blob/main/docs/checks.md>
- step-security/harden-runner: <https://github.com/step-security/harden-runner>
- actions/dependency-review-action: <https://github.com/actions/dependency-review-action>
- astral-sh/setup-uv: <https://github.com/astral-sh/setup-uv>

This repo is a single-package npm TypeScript CLI/library with repo-local Python/FastMCP maintainer tooling (`services/agent-mcp`) and a Blume docs site (`docs/`). There is no public Python service, Turborepo, repo workspace, `apps/`, or Vercel/Render deployment. CI may use alternate package managers only inside the isolated package-smoke lane. CI must stay high-signal and supply-chain-hardened: least-privilege tokens, immutable action pins, matrix coverage for every supported public runtime, and a release path that publishes via OIDC trusted publishing with build provenance. Runtime and library command behavior and the canonical script list live in `AGENTS.md`; this rule owns the CI/CD posture, not the package scripts.

## Workflow map

The complete public CI surface is the tracked workflows under `.github/workflows/`:

- `ci.yml`: the pull-request and `main`-push gate. Four jobs:
  - `quality` (matrix `node-version: [22, 24]`, no database): `npm ci`, `npm audit signatures`, `npm run build`, `npm run lint:ci` (the npm-owned Ultracite/Biome visible + active-local runner), `npm run format:md:check` (read-only Prettier), `npm run typecheck`, `npm run guard`, `npm run check:schema`, `npm run check:package`, then packs the tarball and smoke-tests `npx supaschema --version|diff|check`. On Node 22 only, CI prepares the alternate consumer package managers, runs `npm run package:smoke`, and runs the shipped `examples/` render+check plus `npm run test:examples`.
  - `check` (matrix `postgres: [15, 16, 17]` via a `postgres` service container): `npm run test:matrix`, coverage + Codecov upload through `npm run test:matrix:coverage` on `postgres == 17`, `npm run fixture:diff`, `npm run fixture:verify`, and `npm run corpus:check`: the replay-safety and reconvergence proofs that need a live database. `test:matrix*` excludes the examples lane owned by `quality`.
  - `check-os` (matrix `os: [macos-latest, windows-latest]`, no database): cross-platform path/git handling via `npm run test:matrix`; DB-gated test cases skip when no database is present, and example failures stay in `quality`.
  - `required` (`name: CI required`): one stable required-check context that succeeds only when every matrix-owning job succeeds.
- `release.yml`: triggered directly by protected `main`, with a main-only `workflow_dispatch` recovery path. A read-only preflight job decides whether npm, GitHub Packages, or GitHub Release work remains; only then can the `release` environment start the privileged publish job. It queues publishes with `concurrency.group: release-npm` + `queue: max`, runs on GitHub-hosted Ubuntu Node 24 with no database service, checks out `github.sha`, reruns preflight inside the privileged boundary, builds and package-checks only when publication is needed, packs and smokes the exact tarball, prepares CHANGELOG-owned release notes before external publication, publishes with OIDC provenance, attests immediately with `actions/attest@v4`, and creates or repairs the GitHub Release/tag. Already-complete versions stop after read-only preflight. Registry smoke remains an operator command, not a stable-release workflow gate. A second privileged `publish-next` job owns snapshot publishing on every eligible `main` push (never on `workflow_dispatch`). It depends on both `preflight` and `publish`, requires preflight success and either stable-publish success or the intentional no-release-work skip, and fails closed after dependency failure or cancellation. It stamps an immutable `X.Y.(Z+1)-dev.<sha>` snapshot version (an idempotent `npm view` probe skips republish), rebuilds so `dist/build-info.json` carries the snapshot version, prepares pinned pnpm and Bun 1.3.14 before any external publication, packs and smokes the exact tarball, publishes to the `next` dist-tag with OIDC provenance, attests immediately with `actions/attest@v4`, and registry-smokes the exact emitted version. It never touches `latest`, GitHub Releases, tags, or the GitHub Packages mirror, and snapshots carry no changelog entry. The package's configured npm trusted publisher names the calling workflow `release.yml`; reusable workflows do not change that calling-workflow identity, but this repository keeps both direct publish jobs in that single owner instead of adding another publication surface.
- `consumer-canary.yml`: operator-dispatched (`workflow_dispatch` only) dogfooding lane. Clones a consumer repo (default `jmclaughlin724/anilize`) at a chosen ref, injecting `CONSUMER_CANARY_TOKEN` only for the exact `github.com` HTTPS host and removing it before consumer commands. It installs a chosen supaschema spec (exact snapshot version, resolved `next` tag, or local tarball) without committing manifest changes and runs the consumer's supaschema gates (`config validate`, `types --check`, `check`). Read-only token, no OIDC, no publish; it never gates releases.
- `dependency-review.yml`: pull-request supply-chain gate (`actions/dependency-review-action`): blocks high-severity vulnerable deps. License allow-listing was retired 2026-07-30 as metadata noise; the lane is vulnerability-only.
- `python.yml`: path-filtered (`services/**`, `pyproject.toml`, `uv.lock`, the workflow itself) FastMCP service lane on pull requests and `main` push: `uv sync --locked` lock-freshness check, ruff lint and format check, mypy strict types, pytest, and a `pip-audit` vulnerability scan for `services/agent-mcp`.
- `scorecard.yml`: OpenSSF Scorecard on `main` push + weekly schedule, publishing results to the Scorecard API.
- `docs.yml`: path-filtered (`docs/**`, `package.json`, `package-lock.json`, the workflow itself) docs validation. It installs both roots (`npm ci`, then `npm ci --prefix docs` for the private Blume package), caching on both lockfiles, then runs `npm run docs:check`, which lints the docs standard and runs `blume doctor`, `blume validate`, and a full `blume build`.

## Hard rules

- Every workflow declares a top-level least-privilege `permissions:` block, defaulting to `contents: read` (or `read-all`). A job elevates only the exact scopes it needs: `release.yml`'s `publish` job adds `contents: write` for GitHub Release/tag creation plus `id-token: write` and `attestations: write` for trusted publishing/provenance; `scorecard.yml` adds `id-token: write`. Never grant write at the top level.
- All `uses:` refs are pinned to full-length commit SHAs with an adjacent version comment (for example `# v6.0.3`) for Dependabot readability. The executable ref must be immutable, never a tag or branch. This is the OpenSSF Scorecard "Pinned-Dependencies" check and a STOP condition if violated.
- `actions/checkout` uses `persist-credentials: false` on every tracked workflow's checkout (`ci.yml`, `consumer-canary.yml`, `dependency-review.yml`, `docs.yml`, `python.yml`, `release.yml`, `scorecard.yml`); release re-supplies an explicit `GH_TOKEN`/`registry-url` only where a step needs it.
- Every job declares a `timeout-minutes` ceiling so no lane can hang at the 360-minute default, least of all the privileged release job (`ci.yml` 20/30/20/5, `consumer-canary.yml` 30, `dependency-review.yml` 10, `docs.yml` 15, `python.yml` 15, release preflight/publish/publish-next 5/30/30, `scorecard.yml` 20).
- The privileged `release.yml` jobs run `step-security/harden-runner` with `egress-policy: block` and least-purpose endpoint lists. Both keep GitHub Actions OIDC/results, GitHub API/git, npm, and Sigstore Fulcio/Rekor/TUF endpoints explicit. Stable `publish` alone adds `npm.pkg.github.com` for the GitHub Packages mirror. `publish-next` excludes that unused registry and adds only the GitHub release-asset CDN hosts (`objects.githubusercontent.com`, `release-assets.githubusercontent.com`) needed by the pinned `setup-bun` download. Write `allowed-endpoints` as a folded YAML scalar (`>`) so Harden-Runner receives the space-separated endpoint tokens its agent requires; a literal scalar (`|`) preserves newlines and blocks every configured domain. Do not weaken either publish job back to audit-only egress.
- Releases publish through npm OIDC trusted publishing, not a stored npm token: the job runs on a GitHub-hosted runner with Node 24, asserts `npm >= 11.5.1`, sets `registry-url: https://registry.npmjs.org`, disables package-manager caching on the privileged publish path, and runs `npm publish "$SUPASCHEMA_TARBALL" --access public --provenance`. npm trusted publishing already generates provenance; `--provenance` remains explicit repo policy. Tarball provenance is attested with `actions/attest@v4`. Do not reintroduce a long-lived `NPM_TOKEN`/`NODE_AUTH_TOKEN` secret.
- Treat each publish lane as a fail-closed transaction. Prepare every fallible input or smoke dependency before the first registry write: stable release notes before stable npm publication, and pinned pnpm plus Bun 1.3.14 before snapshot publication. Keep each npm publish step immediately adjacent to its provenance attestation. Snapshot publication may follow stable-publish success or an intentional stable-publish skip only; it must not run after preflight failure, stable-publish failure, or cancellation.
- `main` is the npm and GitHub release source and is protected by mandatory PR plus current-main required checks. `release.yml` must not publish from GitHub Release events or `workflow_run`; it publishes after the protected merge push, with manual repair limited to `refs/heads/main`. The read-only preflight must gate entry into the write/OIDC job. Preflight fails closed when version surfaces disagree, a GitHub Release or tag already exists without its npm publish, or an existing tag points away from the release commit. Same-version reruns are idempotent.
- Runtime matrices match the support contract and must not silently narrow. `ci.yml` `quality` covers Node `[22, 24]` (the engines floor through the release major); `ci.yml` `check` covers PostgreSQL `[15, 16, 17]`; `check-os` covers macOS and Windows. Removing a supported Node major, Postgres major, or OS lane is a STOP condition.
- DB-independent gates and DB-dependent gates stay split. `quality` runs lint/typecheck/build/guard/package/pack-smoke with no `postgres` service and owns the single examples lane on Node 22. `check` owns the database-backed replay-safety proofs (`test:matrix`, `test:matrix:coverage`, `fixture:verify`, `corpus:check`) behind the `postgres` service matrix. Do not move database-backed steps into the no-DB lane or duplicate example tests across DB/OS matrix axes.
- Consumer package-manager smoke is allowed only inside `npm run package:smoke` and the matching Node 22 `quality` workflow steps. It may create throwaway consumer projects under temporary directories, but it must not introduce repo-root alternate lockfiles, workspaces, or maintainer install commands.
- Benchmarks are advisory, not CI or release gates. Keep `npm run benchmark` available for local or manual performance investigation, but do not run it from `ci.yml`, `release.yml`, or another required workflow path.
- The `check-os` matrix runs `npm run test:matrix` on Windows and macOS, so any test or script in that lane that spawns npm tooling must resolve the executable cross-platform: prefer `process.env.npm_execpath` executed through `process.execPath`, then fall back to `npm.cmd` on Windows and `npm` elsewhere when that env var is absent (the helper shape used by `scripts/guards/docs-config/check-schema.mts`, `tests/package/contents.test.ts`, and `tests/config/install.test.ts`). Do not call a hard-coded bare `npm` with `shell: false`, which raises `ENOENT` on Windows. Bash-only constructs (`$(mktemp -d)`, `&&` chains, `out=$VAR`) belong only in `run:` steps and npm scripts the `check-os` lane does not invoke (it runs `npm ci`, `npm run build`, `npm run test:matrix`, `npm run fixture:diff`). Tests that spawn processes, hook entrypoints, or git fixtures must declare explicit vitest timeouts (the repo pattern is an options-object `{ timeout: 15_000 }`–`{ timeout: 20_000 }` or a named fixture-timeout constant): the 5s default flakes under parallel CI load, and on timeout vitest aborts mid-test so teardown races the still-running child and poisons following tests.
- Each `supaschema diff --out` render in a workflow writes to its own output subdirectory. supaschema treats the `--out` file's parent directory as the migrations dir for the lineage chain gate. Two renders sharing one directory (for example the `quality` lane's tarball smoke and examples smoke both writing into `$RUNNER_TEMP`) make the first render look like a pending migration the second must continue, a false `SUPA_DIFF_LINEAGE_BROKEN`. Give each render an isolated `--out` directory; supaschema auto-creates the parent.
- Concurrency is declared in each PR-facing workflow (`ci.yml`, `dependency-review.yml`, `docs.yml`) as `group: "${{ github.workflow }}-${{ github.ref }}"` with `cancel-in-progress: true`, so superseded PR runs are cancelled. `release.yml` queues every release transaction and never cancels an in-flight publish.
- Path-filtered workflows (`docs.yml`, `python.yml`) gate on their owned trees plus their own workflow file and the lockfile inputs that affect them. These are independent advisory workflows, not required checks short-circuited by `paths-ignore`; do not convert a required gate (`ci.yml`) into a path-skipped check.
- CI/docs Node lanes use `actions/setup-node` with npm caching where appropriate; the privileged release job disables package-manager caching to avoid unnecessary package-manager side effects on the OIDC publish path. There is no external or remote build cache in this repo.
- Supply-chain verification is layered and must stay wired: `npm audit signatures` (registry signature check) in `quality` and `release`, `actions/dependency-review-action` on PRs, and OpenSSF Scorecard. Do not remove a public check to make a run green.
- Commit signoff enforcement MUST NOT be wired into CI quality jobs.
- Dependency Review remains read-only and vulnerability-only: report through the check summary, do not re-enable license allow/deny lists, and do not enable PR comments that require `pull-requests: write`. Dependabot (`.github/dependabot.yml`) keeps weekly updates across `npm` and `github-actions` so SHA pins stay current.
- Repository Actions policy allows GitHub-owned actions plus the exact reviewed third-party action repositories used by the tracked workflows; full-SHA pinning remains mandatory. Do not restore `allowed_actions: all`.
- GitHub Actions and OIDC concepts that do not exist here must not be invented into the rule: there is no `turbo.json`, no `--affected` graph, no remote-cache token wiring, no scope-detection script, no `ci_monitor`, and no Render/Vercel deploy workflow. CI is the plain workflow set above.

## Enforced by

- `npm run guard` (`scripts/guards/check-all.mts`) — repository invariants (tooling stack, canonical surfaces, agent surfaces, dependency catalog, and LSP coverage), run inside `ci.yml`'s `quality` job. Public guard scans over agents, skills, rules, and policy files MUST derive their file lists from `git ls-files --cached`, not raw filesystem directory walks, so ignored local DX cannot satisfy or break CI-only requirements. It MUST run a second targeted public-checkout pass for local-only maintainer surfaces with `SUPASCHEMA_PUBLIC_CHECKOUT=1` and emit `PUBLIC_CHECKOUT_GUARDS_OK`, so ignored local files cannot mask clean GitHub checkout failures.
- `npm run guard:ci` (`scripts/guards/ci-release/check-ci-governance.mts`, part of `npm run guard`) — parses every tracked workflow with the `yaml` dependency and asserts this rule's STOP invariants deterministically: top-level least privilege, SHA pins, credential handling, PR concurrency, the stable `CI required` aggregation job, read-only vulnerability-only Dependency Review with no license allow/deny lists and no PR-comment writes, release queueing, read-only release preflight, conditional write/OIDC entry, exact fail-closed snapshot dependency results, least-purpose block-mode egress, pre-publication tool preparation, pinned Bun, exact tarball smoke/publish, immediately adjacent provenance attestation, changelog-owned GitHub Release creation, supported runtime matrices, single-owner examples, and `python.yml` staying tracked with the agent MCP service.
- `npm run lint:ci` (the package-owned Ultracite/Biome runner with GitHub diagnostics), `npm run format:md:check` (read-only Prettier), `npm run typecheck`, `npm run build`, `npm run check:schema`, `npm run check:package`, and `npm run package:smoke`: the static and packaging gates the `quality` matrix runs.
- `npm run test:matrix`, `npm run test:matrix:coverage`, `npm run fixture:verify`, and `npm run corpus:check`: the database-backed replay-safety proofs the `check` matrix runs.
- The seven workflow files themselves under `.github/workflows/` (`ci.yml`, `consumer-canary.yml`, `dependency-review.yml`, `docs.yml`, `python.yml`, `release.yml`, `scorecard.yml`), plus `.github/dependabot.yml`.
- `lefthook.yml` for local pre-commit hooks that mirror the lint/format gates before code reaches CI.

STOP if a tracked workflow does any of these:

- Grants top-level write permissions, unpins an action, restores unrestricted action admission, or drops `persist-credentials: false`.
- Permits direct `main` updates without the stable CI and dependency checks, or lets a no-op release enter the write/OIDC job.
- Weakens Harden-Runner from block mode, replaces OIDC with a stored npm token, drops release provenance or version gates, or publishes from an unprotected source.
- Lets a snapshot run after a failed or cancelled dependency, prepares a required release input after publication, leaves a post-publish smoke tool unpinned, or grants a publish lane unused egress.
- Removes a supported runtime matrix, drops a required check, or removes stale-run cancellation from a PR workflow.
- Shares one migration output directory across independent renders.

STOP if anyone reintroduces Turborepo, remote-cache, `--affected`, maintainer pnpm/Yarn/Bun install workflows, or Vercel/Render deploy machinery into the CI surface or into this rule. The isolated package-smoke lane is the only CI exception for alternate package managers.

## Verification

After workflow, release, supply-chain, matrix, package, or CI guard changes, run:

```bash
npm run guard:ci
npm run guard
```

For package-release changes, also run `npm run release:verify`.

## Failure behavior

Fix the workflow or guard. Do not remove scanners, narrow required matrices, unpin actions, introduce stored npm tokens, weaken OIDC/provenance, or move database proofs into release to make CI faster.

## Done means

Workflow permissions are least-privilege, actions are full-SHA pinned, release remains main/OIDC/provenance based, matrices match support, and CI guards prove the posture.
