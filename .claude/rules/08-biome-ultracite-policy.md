---
description: Biome/Ultracite JS/TS lint and format policy for the single-package npm repo.
paths:
  - "biome.jsonc"
  - "ultracite.*"
  - "package.json"
  - "package-lock.json"
  - "scripts/lint.mts"
  - "scripts/format.mts"
  - "scripts/lib/repo-files.mts"
  - "scripts/guards/toolchain/**"
---

# Rule 08 - Biome/Ultracite is the JS/TS lint policy

## Contract

This rule owns the Biome-supported lint and format policy: root `biome.jsonc` extends Ultracite presets, npm-owned runners are the only Biome/Ultracite entry points, active ignored maintainer surfaces receive a bounded second pass, and generated/dependency/cache surfaces stay excluded.

Sources:

- Biome configuration docs: <https://biomejs.dev/guides/configure-biome/>
- Biome linter docs: <https://biomejs.dev/linter/>
- Biome suppression docs: <https://biomejs.dev/analyzer/suppressions/>
- Ultracite Biome provider: <https://www.ultracite.ai/docs/provider/biome>
- Ultracite documentation: <https://www.ultracite.ai/docs>

Biome is the canonical JS/TS/JSX/TSX/JSON/JSONC/CSS/HTML/GraphQL formatter and linter. Ultracite supplies the shared preset and agent-facing docs; package scripts consume the same root policy. This rule owns the JS/TS Biome/Ultracite policy.

## Hard rules

- `biome.jsonc` is the canonical JS/TS/JSX/TSX/JSON/JSONC/CSS/HTML/GraphQL/SVG lint and format configuration. This is a single-package npm repo, so there is exactly one root `biome.jsonc` and no per-package Biome configs.
- Root `biome.jsonc` extends Ultracite's `core`, `type-aware`, and `vitest` Biome presets (`ultracite/biome/core`, `ultracite/biome/type-aware`, `ultracite/biome/vitest`), then overrides only the repo-approved low-churn defaults.
- `scripts/lint.mts` and `scripts/format.mts` are the package-owned execution layer. `npm run lint` checks the Git-visible repository and then the explicit `LOCAL_BIOME_PATHS`; `npm run lint:ci` runs the same two passes with the GitHub reporter. The read-only runner accepts only `--ci`, `--reporter=github|summary`, and `--max-diagnostics=<count>`; it must reject write, unsafe-fix, alternate-config, reporter-file, rule-skip, and arbitrary passthrough flags. `npm run format` applies fixes before chaining the non-Biome language owners, and `npm run format -- <paths...>` accepts only `--staged` or existing repository-relative targets whose real paths stay inside the repository. No package, workflow, hook, agent, or generator may bypass these wrappers with direct `biome`, `ultracite check`, or `ultracite fix` commands.
- `scripts/lib/repo-files.mts` is the canonical owner for `LOCAL_BIOME_PATHS` and the wider repository inventory policy. Keep `vcs.useIgnoreFile: true` for the normal pass; only the bounded active-local pass uses `--vcs-use-ignore-file=false`. Do not disable VCS ignores globally or replace the list with a recursive scan of ignored state.
- Do not add a duplicate `"**"` to `files.includes`; `ultracite/biome/core` already provides the catch-all, and strict Biome flags duplicate first exceptions.
- Keep `html.experimentalFullSupportEnabled` enabled so HTML receives parse/format/lint coverage. Keep `javascript.experimentalEmbeddedSnippetsEnabled` enabled so supported CSS/GraphQL tagged-template snippets are governed with their host JavaScript.
- Type-aware and project-scanner Biome rules are part of the required gate for dependency declarations, private imports, JSON import attributes, import cycles, and deprecated imports. Import-extension rewriting is enabled, not disabled: `correctness.useImportExtensions` is set to `error` with the `ts -> js` / `tsx -> js` extension mappings so relative imports carry emitted-runtime `.js` specifiers, as this NodeNext package requires. `npm run typecheck` remains the semantic TypeScript type gate.
- Complexity stays enforced by the inherited Ultracite preset. Do not add a root, file-, or folder-specific `noExcessiveCognitiveComplexity` migration cap; refactor source or change the shared rule intentionally after a fresh upstream audit.
- Active source, benchmark, bin, script, and test files must not import generated `dist` output. Package scripts may execute compiled `dist` entrypoints after `npm run build`; source modules must import source-owned modules.
- `src/index.ts` is the only approved `noBarrelFile` exception because it is the package's public API entrypoint.
- Exact Biome, Ultracite, and Vitest tool pins live in `package.json`; the root `package-lock.json` and npm-only tooling guard prove the package-manager contract.
- Keep generated contract/artifact outputs (including root `database.types.ts` and `database.zod.ts`), build output, dependency directories, virtualenvs, caches and nested hook-state `.tmp` directories, archived plans, nested `.claude/worktrees/**` checkouts, and generated agent mirrors out of the Biome surface. Canonical `.claude/skills/**`, `.claude/settings.local.json`, local worker/script code, ignored MCP/editor JSON, codemod-generated active source/docs, tracked HTML, and generated documentation SVGs remain governed. The only canonical-skill exceptions are the two exact workflow-host payloads named in `biome.jsonc`; they are byte-preserved binary extractions with injected globals and top-level returns, not standalone JavaScript. SVG-producing benchmark and diagram scripts must finish through `npm run format -- <output-path>` so regenerated assets are canonical immediately.
- Biome does not own Markdown, MDX, YAML, or SQL. Do not point Biome at those surfaces.
- Local Biome suppression comments are forbidden. Investigate the related upstream rule, fix the code, or adjust the shared `biome.jsonc` policy with a repo-wide rationale.
- Do not add a second Biome config that drifts from the root policy without first creating a deliberate shared-config design and updating this rule.
- When adding a governed root or ignored-local path, update `scripts/lib/repo-files.mts`, run `npm run format` as the only write/fix path, and then run the read-only gates. During agent work, invoke Biome/Ultracite only through the npm scripts; do not run `npm run lint fix` and do not add formatter aliases such as `npm run lint:fix`.
- Do not reintroduce ESLint as a parallel JS/TS gate.

## Enforced by

- `npm run lint` and `npm run lint:ci`, both through `scripts/lint.mts`.
- `npm run format` and its scoped/staged mode through `scripts/format.mts`.
- `npm run lint:doctor`.
- `npm run guard` (`scripts/guards/check-all.mts`).
- `scripts/guards/toolchain/check-tooling-stack.mts` plus focused runner/discovery tests. They pin tooling and assert wrapper ownership and behavior, safe argument and target handling, Lefthook and generator routing, the active-local inventory, symlink rejection, experimental language support, presets, import mappings, approved overrides, and the exact reviewed exclusion boundary.

STOP if any of these occurs:

- A second Biome config appears without a shared policy, or ESLint returns as a parallel lint surface.
- A local suppression comment is introduced.
- Generated, dependency, or cache artifacts enter the lint surface, or an active Biome-supported local path is omitted.
- VCS ignores are disabled globally.
- Lint accepts mutating or gate-bypass arguments, or scoped format can escape the repository or follow an external symlink.
- A direct Biome/Ultracite check or fix entry point bypasses the npm wrappers, or another formatter or linter competes with Biome.

## Verification

When Biome, Ultracite, lint surface, config overrides, generated exclusions, or JS/TS formatting changes, run:

```bash
npm run format
npm run lint
npm run lint:doctor
npm run guard
```

Use `npm run lint:ci` for CI-equivalent formatting and lint proof.

## Failure behavior

Fix source or shared config; do not add inline suppressions, local duplicate Biome configs, ESLint, or competing formatters. If an override is necessary, make it narrow and document the rationale.

## Done means

Biome/Ultracite config and execution are single-source, Git-visible and explicit active-local surfaces are formatted and lint-clean, generated/dependency/cache surfaces are excluded, and no competing or bypass lint surface exists.
