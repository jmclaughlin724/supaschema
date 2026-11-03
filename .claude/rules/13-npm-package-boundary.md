---
description: npm package `files` boundary, consumer agent bundle install, explicit init scaffold surface, and package-content tests.
paths:
  - "package.json"
  - "package-lock.json"
  - "bin/scaffold.mjs"
  - "agent-bundle/**"
  - "skills/**"
  - "docs/coding-agents/agent-bundle.mdx"
  - "docs/reference/package-boundary.mdx"
  - "tests/package/**"
  - "scripts/release/package-smoke.mts"
  - "scripts/guards/repo-surface/**"
---

# Rule 13 - npm package boundary

## Contract

This rule owns the published npm package boundary: `package.json#files`, tarball contents, consumer agent bundle install, explicit `supaschema init` scaffold behavior, lifecycle-script silence, and package-content tests.

Sources:

- npm package `files`: <https://docs.npmjs.com/cli/v8/configuring-npm/package-json/#files>
- npm publish contents: <https://docs.npmjs.com/cli/v8/commands/npm-publish/#files-included-in-package>
- npm developer guide: <https://docs.npmjs.com/cli/v9/using-npm/developers/#keeping-files-out-of-your-package>
- Agent Skills specification: <https://agentskills.io/specification>
- Vercel Skills CLI: <https://github.com/vercel-labs/skills>

The published package is an explicit consumer surface. The repository also contains maintainer-only tooling for developing supaschema itself. Keep those surfaces separate.

## Hard rules

- `package.json` `files` is the canonical npm package allowlist.
- Do not add a root `.npmignore` while `package.json` `files` owns the package boundary.
- Treat `npm pack --dry-run --json` as the authoritative preview of the published tarball.
- Package install downloads files only. Consumer setup is explicit through `supaschema init`; do not confuse tarball contents with files written into the consuming project.
- The downloadable consumer agent bundle is deliberately narrow and installed by default during `supaschema init`: `agent-bundle/INSTALL.md`, the ordered skills manifest, shared prompt and curated Agent skill directories, Claude rule/skill/settings variants, and Codex rule/settings variants. Generated-artifact blocking and schema-write automation remain direct `supaschema hook` CLI commands in the settings templates; do not ship wrapper scripts for them.
- `scripts/skills/sync-llm.mts#publicSkillNames` derives the ordered public-skill list from parsed `.claude/skills/**` frontmatter (`metadata.public: true`); it is not a separately maintained inventory. It currently resolves to the single consolidated `supaschema` skill. Sync projects that canonical `.claude/skills/supaschema` directory, including its `references/**`, into `skills/**`, both Agent and Claude bundle trees, and `agent-bundle/skills-manifest.json`. Workflow lanes are progressive-disclosure references inside that one skill, not sibling public skills. The public skill installs portable Agent Skill context only and must not include hooks, rules, subagents, config scaffolding, or maintainer skills.
- Do not advertise the repository root as an `npx skills` source. The Skills CLI scans standard agent directories such as `.agents/skills` and `.claude/skills`; this repository uses those locations for maintainer mirrors while developing supaschema itself.
- Consumer package install and default `supaschema init` must not run the Skills CLI or depend on the user's Skills destination choice. `supaschema init` recursively installs every manifested Agent and Claude skill directory when files are missing, merges the matching package-manager `.claude/settings.json` and `.codex/hooks.json` entries, and must not write `AGENTS.md`, `CLAUDE.md`, or any `.codex/skills/**` path.
- Rules and skills ship as raw package files under `agent-bundle/**`, not through `npx skills`. Consumer hook behavior is provided by the compiled `supaschema hook` CLI and registered through package-manager-specific settings templates. `supaschema init` copies missing consumer rule and recursive skill files and merges runtime-specific project registration from the matching `agent-bundle/**` settings templates. Existing non-identical files are preserved and reported by path, and JSON hook/config files are merged without duplicate direct hooks; non-mergeable JSON shapes must be reported as skipped setup work.
- `docs/coding-agents/agent-bundle.mdx` is the reader-facing owner for consumer agent bundle contents, installed hook commands, hook events, and schema-edit workflow trigger behavior such as `supaschema hook schema-write`. `docs/reference/package-boundary.mdx` owns package mechanics only and should link to the agent-bundle page instead of duplicating the hook contract.
- Agent-bundle setup instructions expose packaged settings templates that `supaschema init` merges automatically. Packaged Claude and Codex hook templates MUST wire only the Supaschema generated-artifact block and schema-write automation on actual edit tools. The repository's parser-backed secret, literal-DDL, and broad-deletion Bash policy is maintainer-only and MUST NOT appear in consumer templates, the tarball's raw agent bundle, or active consumer install output.
- This rule owns the package boundary: `scripts/skills/sync-llm.mts` MUST strip source-only context hooks, the source-only LLM surface sync hook, `scripts/agent-hooks/**`, source-repo hook launcher commands, `.codex/hooks/general-guard.mjs`, and raw Bash-policy modules from consumer templates and the raw agent bundle, replacing only Supaschema hook invocations with consumer package-manager commands. Source-repo runtime may be tracked in the GitHub branch, but it must never enter the published consumer bundle or active consumer install output unless the consumer contract explicitly changes.
- Maintainer Claude/Codex optimization infrastructure is repo-local by default. Do not publish or scaffold `.claude/hooks/context-*`, `.codex/hooks/context-*`, `.claude/hooks/sync-llm-on-claude-surface-change.mjs`, `.codex/hooks/sync-llm-on-claude-surface-change.mjs`, `scripts/agent-hooks/**`, optimizer skills, internal rules, generated Codex rule mirrors, `.claude/agents/**`, `.codex/agents/**`, `.codex/config.toml`, or other agent-development tooling unless the consumer contract explicitly changes and `tests/package/contents.test.ts`, `tests/config/install.test.ts`, `bin/scaffold.mjs`, docs, and this rule change together. GitHub branch tracking is not package publication; `package.json#files`, package tests, and `npm pack --dry-run --json` own the package boundary.
- Maintainer hook installation is explicit (`npx lefthook install`); do not add `prepare`, `preinstall`, or `postinstall` solely to install repository hooks. Any lifecycle script that runs during `npm pack`, `npm ci`, or `npm publish` must not write to stdout. Gates parse that stdout (the `npm pack --silent` tarball name, and `npm pack --json` consumed by `tests/package/contents.test.ts` and `tests/config/install.test.ts`), so any stray line breaks tarball-name capture and JSON parsing. Lifecycle helpers and action runners must pass argv arrays with `shell: false`; combining child-process args with `shell: true` triggers Node DEP0190 and can turn package gates noisy or unsafe.
- Consumer setup is documented in `docs/installation.mdx` and implemented by explicit `supaschema init`; do not maintain a second install-contents list in release or packaging references. Resolved setup writes `supaschema.config.json`, installs package-bundled AI enforcement surfaces, and removes `.supaschema/`. `.supaschema/install.json` is only an agent handoff for genuinely ambiguous path ownership and must include actionable `agentInstructions`. Supabase inventory or `_bootstrap` projects are resolved installs with manual schema diff and migration sync policy, not pending installs.
- `main` is a release branch, not a silent integration branch. Release preflight must publish a package version that is not yet on npm, repair a missing GitHub Release for an already published version, or exit successfully when npm and GitHub already have the current version. Do not let npm registry propagation timing block GitHub Release creation.
- Tarball smoke and registry smoke are separate package proofs. `npm run package:smoke` proves the local tarball installs and initializes through supported package managers before publish. `npm run release:registry-smoke` is an operator command for proving npm, pnpm, and Bun can download and execute `supaschema@<version>` from the npm registry after publication; it is not a release workflow gate.
- Keep package-manager smoke on current supported client behavior. pnpm coverage must include pnpm 11 behavior and must use an explicit `minimumReleaseAge` override for immediate-release smoke paths instead of accidentally accepting pnpm's default one-day fresh-version cooldown as package unavailability. Consumer installation docs and shipped prompts must keep `pnpm add supaschema` as the default so ordinary installs retain pnpm's release-age protection; document `--config.minimumReleaseAge=0` only for immediate-release troubleshooting.
- Maintainer workspace surfaces stay repo-only unless the consumer contract explicitly changes. Examples include `.vscode`, `.mcp.json`, root `lsp-soleaux.json`, Postgres Language Server config, Python/FastMCP support, tests, guards, source files, CI support, and lint config.
- Generated build artifacts stay out of every allowlisted directory except their declared package outputs. Build and typecheck configurations do not emit incremental metadata, and a `.tsbuildinfo` must never reach the published tarball.
- When adding, moving, or deleting a package or consumer install surface, update `docs/reference/package-boundary.mdx`, package tests, and tooling guards in the same change.
- When changing the public `npx skills` surface, update the single exported list, `skills/README.md`, `docs/coding-agents/index.mdx`, `docs/coding-agents/agent-bundle.mdx`, and the parity/scaffold tests in the same change. The parity guard must import the exported list instead of duplicating skill names.
- Keep consumer lifecycle proof split by phase: tarball contents, install scaffold, installed CLI use, and cross-manager package smoke. `docs/reference/package-boundary.mdx` owns the reader-facing matrix. `npm run release:verify` is the release-facing entry point and must run `npm run test:consumer-lifecycle` before `npm run package:smoke` so installed CLI use fails locally before CI.

## Enforced by

- `npm run guard`.
- `npm run guard` includes `scripts/guards/toolchain/check-tooling-stack.mts`, which AST-checks lifecycle and action-runner child-process calls for the `shell: true` plus args shape.
- `npm run check:package`.
- `npm run test:consumer-lifecycle`.
- `npm run release:verify`.
- `npm run release:registry-smoke` as a manual post-publish operator check.
- `npm pack --dry-run --json`.
- `npx vitest run tests/cli/editor.test.ts tests/config/install.test.ts tests/package/contents.test.ts tests/package/consumer.test.ts`.

STOP if any of these occurs:

- A root `.npmignore` is introduced, or `skills/` enters `package.json` `files`.
- The public skill directories differ from the exported ordered list, or a maintainer-only support surface enters `package.json` `files`.
- Required source-repo runtime is hidden behind `.gitignore` while tracked hook registration or guards depend on it.
- The raw `agent-bundle` surface is removed from the tarball.
- Default init fails to install package-bundled `.agents`, `.claude`, or `.codex` enforcement surfaces when missing, or default init writes `AGENTS.md`, `CLAUDE.md`, or `.codex/skills/**`.
- `.claude/hooks/context-*`, `.codex/hooks/context-*`, `.claude/hooks/sync-llm-on-claude-surface-change.mjs`, `.codex/hooks/sync-llm-on-claude-surface-change.mjs`, `.codex/hooks/general-guard.mjs`, raw Bash-policy modules, `scripts/agent-hooks/**`, optimizer skills, internal rules, generated rule mirrors, or repo-local context infrastructure enters the tarball or consumer scaffold without an explicit consumer-contract change.
- A consumer hook template wires anything beyond the Supaschema generated-artifact and schema-write hooks.
- A `.tsbuildinfo` or other build cache appears in the dry-run tarball.
- A lifecycle script (`prepare`, `preinstall`, `postinstall`) writes to stdout and breaks `npm pack` tarball-name or `--json` parsing, or a lifecycle helper or action runner passes child-process args with `shell: true`.

## Verification

After package files, scaffold, docs, published agent bundle, or release surface changes, run:

```bash
npm run check:package
npm run test:consumer-lifecycle
npm run release:verify
npm run pack:dry
npm pack --dry-run --json
npx vitest run tests/cli/editor.test.ts tests/config/install.test.ts tests/package/contents.test.ts tests/package/consumer.test.ts
```

## Failure behavior

Fix the allowlist, scaffold, docs, or tests. Do not add `.npmignore`, ship maintainer-only tooling in the package, let lifecycle scripts print stdout, or edit generated package artifacts to satisfy tests.

## Done means

The dry-run tarball contains only the intended consumer surface, default init installs config plus package-bundled AI enforcement, agent-bundle scaffold parity holds, consumer lifecycle tests pass, and docs match the published package boundary.
