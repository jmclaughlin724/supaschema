---
description: Multi-language LSP coverage, formatter/linter ownership, import/key sorting, and npm-only toolchain.
paths:
  - "lsp-soleaux.json"
  - "biome.jsonc"
  - ".prettier*"
  - "lefthook.yml"
  - "scripts/cclsp-*.mjs"
  - "scripts/guards/toolchain/**"
  - "package.json"
---

# Rule 06 - Multi-language LSP coverage and formatting/lint standards

## Contract

This rule owns multi-language code intelligence and tool ownership: every tracked code extension has lsp-soleaux coverage, every language has one formatter/linter owner, and `npm run format` is the single repo-wide write/fix command.

This rule also owns the package-manager invariant: npm is the JavaScript package manager. Preserve `package-lock.json` and do not introduce pnpm, Yarn, Bun, Turborepo, or an alternate package-manager lockfile. The repo publishes one package: a TypeScript CLI/library under `src/` built to `dist`. It also carries a private nested npm package at `docs/` for the Blume docs site, with its own `package.json` and tracked `package-lock.json`, plus a Python uv workspace at `services/agent-mcp`. `docs/` is a separate install root, not an npm workspace; root `package.json` declares no `workspaces`. There are no `apps/` and no SQL formatter lane.

Every language used in this repo is a governed surface. It gets a language server under lsp-soleaux for code intelligence, and a formatter/linter gate where one exists. Each language with a text formatter has exactly one formatting owner: Biome (JS/TS/JSX/TSX/JSON/JSONC/CSS/HTML/GraphQL), Prettier (Astro/MDX/Markdown/YAML), ruff (Python), taplo (TOML), and shfmt (shell). SQL is governed by supaschema's parser/deparser/model semantics plus `postgres-language-server`, not by a standalone formatter. Import and key sorting follow the same one-owner rule (see [Import and key sorting](#import-and-key-sorting)). Coverage is enforced by `scripts/guards/toolchain/check-lsp-coverage.mts` (`npm run guard:lsp-coverage`) and the lint gate `npm run lint` (Ultracite/Biome).

## All used languages live under lsp-soleaux

Root `lsp-soleaux.json` maps every tracked source/config extension to an stdio LSP:

| Language | Extensions | Server |
| --- | --- | --- |
| Python | py, pyi | `uv run pylsp` (+ plugins) |
| TypeScript/JS | ts, tsx, js, jsx, mjs, cjs | `typescript-language-server` (via `scripts/cclsp-language-id-proxy.mts`) |
| Astro | astro | `astro-ls` |
| SQL (Postgres) | sql | `postgres-language-server lsp-proxy` (libpg_query, no DB) |
| JSON | json, jsonc | `vscode-json-language-server` |
| CSS family | css, scss, less | `vscode-css-language-server` |
| HTML | html | `vscode-html-language-server` |
| YAML | yaml, yml | `yaml-language-server` |
| Bash | sh, bash | `bash-language-server` |
| TOML | toml | `taplo lsp stdio` |
| Markdown/docs | md, markdown, mdx, rules | `vscode-markdown-language-server` |
| Dockerfile | dockerfile | `docker-langserver` |

Tracked root `lsp-soleaux.json` is source-repository tooling that is never published or scaffolded. Its Node language servers run repository-installed, manifest-pinned binaries through `npx --no-install`; Python stays in the locked uv workspace. `check-lsp-coverage.mjs` walks `git ls-files` and hard-blocks if any tracked code extension is neither mapped in `lsp-soleaux.json` nor in the guard's `NON_CODE` allowlist. Adding a new language requires an lsp-soleaux server first. lsp-soleaux keys one server per extension, so a shared extension (for example `.css` or `.tsx`) routes to a single server.

The TypeScript/JavaScript entry uses `scripts/cclsp-language-id-proxy.mts` as its only compatibility adapter. The proxy injects the absolute TypeScript 6 `tsserver.js` path during `initialize`, preserves other initialization options, and normalizes only MJS/CJS `didOpen` language IDs. Do not put a static tsserver path or package version in `lsp-soleaux.json`.

The Astro entry passes the repository-relative `node_modules/typescript/lib` SDK through `initializationOptions.typescript.tsdk`, as required by `astro-ls`. Its `rootDir` keeps that path portable across checkouts.

Root `action.yml` and `action.yaml` are GitHub Action metadata files, not workflow files. `.vscode/settings.json` must keep them associated with the generic `yaml` language plus the `github-action.json` schema so Red Hat YAML owns action metadata validation. The GitHub workflow schema and `github-actions-workflow` language mode belong only to `.github/workflows/*.yml` and `.github/workflows/*.yaml`.

## Repository discovery

Use the nearest repository instructions and manifests to identify likely owners. Use `git ls-files` and `scripts/lib/repo-files.mts` for repository inventory. When the active client exposes the configured lsp-soleaux capabilities, use them for definitions, references, implementations, call hierarchy, and diagnostics; configuration and coverage alone do not prove those tools are callable in the current session. Otherwise use the manifest-pinned compiler, AST, and parser owners for structural queries. Direct source reads, exact `rg -F` searches, and focused tests or guards provide final behavior and removal proof. There is no separate repo-wide graph owner.

## One owner per concern

| Language | Format | Lint | Types |
| --- | --- | --- | --- |
| JS/TS/JSX/TSX | **Biome/Ultracite** | **Biome/Ultracite** | tsc (`npm run typecheck`) |
| JSON/JSONC/CSS/HTML/GraphQL/SVG | **Biome/Ultracite** | **Biome/Ultracite** | — |
| Astro/MDX/Markdown/YAML | **Prettier** | docs gate for Astro/MDX (`npm run docs:check`) | Blume/Astro check for Astro; — otherwise |
| Python | **ruff format** | **ruff** | **mypy** |
| SQL | — | supaschema semantic guards + `postgres-language-server` LSP | — |
| TOML | **taplo** | `taplo` LSP | — |
| Shell (sh/bash) | **shfmt** (via `sh-syntax`) | `bash-language-server` LSP | — |

- **Biome via Ultracite** owns JavaScript, TypeScript, JSX, TSX, JSON, JSONC, CSS, HTML, GraphQL, and SVG formatting and linting through `biome.jsonc`. Invoke Biome/Ultracite only through the npm scripts.
- **`npm run format` is the single repo-wide write command.** With no targets it chains every writer with no `check` step: `format:json` (sort-package-json), Git-visible Biome/Ultracite, active-local Biome/Ultracite, `format:md` (Prettier), `format:toml` (taplo), `format:sh` (shfmt), then `py:fix` (ruff `--fix` then `ruff format`). One command formats, lint-fixes, import-sorts, and key-sorts every language that has a write formatter. `npm run format -- <paths...>` is the same canonical entry point for a bounded Biome/Ultracite fix, including generated SVG normalization and Lefthook's `--staged` mode. Reserve the `check`/`lint`/`*:check` commands for read-only gates.
- **Prettier** owns Astro, MDX, Markdown, and YAML formatting through `prettier.config.mjs` and `.prettierignore`; apply it with `npm run format:md` (`prettier --write "**/*.{astro,md,mdx,yml,yaml}"`), which `npm run format` chains after Biome. Biome does not format these types. `docs/` Astro and MDX are additionally validated, not formatted, by `npm run docs:check` (repo docs lint plus Blume doctor and validate): Prettier owns layout, Blume owns page correctness. Generated agent-surface mirrors (`.agents/**`, `.codex/**`, `agent-bundle/**`) are excluded from Prettier via `.prettierignore` and from Biome via `biome.jsonc` negations; format the `.claude/**` source and run the idempotent `npm run sync:llm` writer.
- **Python** format/lint is ruff and types are mypy: `python-lsp-ruff` owns pylsp/editor formatting and diagnostics, while `npm run py:format:check`, `npm run py:lint`, and `npm run py:typecheck` own CLI/CI through `uv run --package supaschema-agent-mcp`. Black and standalone isort formatter plugins are not used.
- **SQL has no standalone text formatter.** Supaschema renders migrations deterministically and is the source of truth for SQL safety via AST/model semantic guards, fidelity-gated `normalize: "deparse"`, `checkMigrationSql`, and the `postgres-language-server` LSP. Do not add pgformatter or another SQL formatter lane to `npm run format`. Formatting-only rewrites must not touch generated migrations, fixtures, corpus, or benchmark evidence.
- **taplo** owns TOML formatting; apply it with `npm run format:toml` (`scripts/format-toml.mts`, bare `taplo format` with no config file). `reorder_keys` and `reorder_arrays` stay at their `false` defaults because TOML order is semantic here (`pyproject.toml` sections, `wrangler.toml`, `.codex/config.toml`). taplo also provides the editor LSP.
- **shfmt** owns shell formatting via the maintained `sh-syntax` WASM port of `mvdan/sh`; apply it with `npm run format:sh` (`scripts/format-sh.mts`, two-space indent). It only formats; shell has no key or import sort. `bash-language-server` provides the editor LSP.
- `scripts/lib/repo-files.mts` is the shared owner for repository file inventory, active local paths, and deny segments. Git-discovered formatter candidates must be regular files whose real paths stay inside the repository; symlink candidates are never writable formatter inputs.
- Custom repository-wide formatter scripts must discover tracked and unignored files through Git (`git ls-files --cached --others --exclude-standard`) and then scope that set to their owned roots. They must not recursively enter ignored directories, private state, nested worktrees, dependency trees, or build output.

## Import and key sorting

Sorting has one owner per language too, and is deliberately conservative: blanket key sorting breaks semantic and conventional order, so it is opt-in everywhere it could harm intent.

- **Import sorting** is owned by the language formatter/linter and is already enforced. Biome `organizeImports` (a recommended, default-on assist) sorts imports and exports in JS/TS/JSX/TSX through `npm run format` and the lint gates. Ruff `I` rules (in `[tool.ruff.lint] select`) sort Python imports through pylsp formatting and `npm run py:lint`. No separate import-sort tool is added.
- **Key sorting is opt-in.** Biome's `useSortedKeys` assist stays off (Biome's own default) because JS object literals and config files (`tsconfig`, `biome.jsonc`, docs navigation) carry semantic or conventional order. The one keyed file with a canonical non-alphabetical order, `package.json`, is sorted by `sort-package-json` via `npm run format:json`, which `npm run format` runs first so Biome formats `package.json` last.
- **Other languages do not sort.** Prettier (Astro/MDX/Markdown/YAML), taplo (TOML, `reorder_keys` off), and shfmt (shell) format only. None reorder keys or content, since order there is semantic.

## Hard blockers

- `npm run guard` (via `check-all.mjs`) runs `check-tooling-stack` and `check-lsp-coverage`: the npm-only contract holds and every language stays mapped.
- Run `npm run format` to move formatting, lint-fix, import-sort, and key-sort work forward. Do not use `npm run lint` as a fixer, do not append `fix` to `npm run lint`, and do not add or run formatter aliases such as `npm run lint:fix`.
- `npm run lint` is the required Biome-supported JS/TS/JSON/JSONC/CSS/HTML/GraphQL/SVG gate; `npm run typecheck` (tsc over `tsconfig.src.json` + `tsconfig.tools.json`) is the TS type gate.
- Lefthook `pre-commit` is `piped`: jobs run sequentially and stop at the first failure, and lefthook chains no stdio between jobs. The formatter jobs cover every language owner with `stage_fixed: true` (fixes are re-staged): `npm run format -- --staged` routes the Biome-supported staged surface through Ultracite, the pinned local Prettier binary (`npx --no-install`) owns MD/MDX/YAML, taplo owns TOML, and the `sh-syntax` port owns shell. The final `sync-agent-surfaces` job then regenerates generated mirrors from the post-format sources via `npm run sync:llm` and stages only generator-owned output trees. It refuses to run while agent-surface source paths carry unstaged or untracked edits, so a commit can never pair stale canonical sources with fresh mirrors. `check-tooling-stack.mjs` asserts the piped mode, the trailing sync job, and its staging shape. `pre-push` runs `npm run typecheck` and `npm run guard`.
- The PostToolUse hook gives in-loop feedback for schema-SQL edits through the supaschema auto-diff/check lane; Biome-supported verification is owned by `npm run lint`.
- Tooling is pinned to exact versions in root `devDependencies` (`@biomejs/biome`, `ultracite`, `vitest`, `@vitest/coverage-v8`, `prettier`, the LSP servers) and in the `uv` dev group (`ruff`, `mypy`, the pylsp plugins). `package.json` owns the version values. `check-tooling-stack.mjs` asserts exact pinning by name for `@biomejs/biome`, `ultracite`, `vitest`, `@vitest/coverage-v8`, `prettier`, and derives the expected `biome.jsonc` `$schema` from the installed pin; the LSP servers stay exact-pinned in `package.json` without a dedicated per-tool guard assertion. The private `docs/` package pins `blume` and `@astrojs/cloudflare` exactly in `docs/package.json`, because `blume build` is a `docs:check` gate; no per-tool guard asserts them. Do not name a tool version in this rule or any other prose surface.

STOP if any of these occurs:

- A new language ships without an lsp-soleaux mapping.
- A Biome-supported active repository surface is committed unformatted, or Python fails ruff or mypy.
- Schema SQL bypasses the supaschema semantic guards.
- A second formatter competes with the one owner for a language, or pgformatter or another SQL formatter lane is introduced.
- Blanket key sorting is enabled over semantic or conventional order (Biome `useSortedKeys` on globally, or taplo `reorder_keys` on).
- pnpm, Yarn, Bun, Turborepo, an npm `workspaces` field, or an alternate package-manager lockfile is introduced.

## Verification

When adding a file type, formatter, linter, LSP, language config, or format script, run:

```bash
npm run guard:lsp-coverage
npm run guard
npm run lint
npm run typecheck
```

Use `npm run format` for write/fix remediation. Every source checkout includes and validates `lsp-soleaux.json`; package and scaffold tests keep it out of consumer surfaces.

## Failure behavior

Add missing LSP coverage before adding a language. Remove competing formatters and linters and align with the one-owner map. Do not use `npm run lint` as a fixer, do not add formatter aliases, and do not introduce a second package manager or a SQL formatter lane.

## Done means

Every touched language surface is mapped, formatted by its canonical owner, checked by its gate, and free of competing tooling.
