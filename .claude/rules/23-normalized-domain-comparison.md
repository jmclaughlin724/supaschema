---
description: Canonical comparison for normalized paths and other normalized domains.
paths:
  - "src/paths.ts"
  - "scripts/guards/code-shape/check-path-comparison.mts"
  - "tests/**/paths*.test.ts"
---

# Rule 23 - Normalized-domain comparison (paths)

## Contract

This rule owns the standard for comparing values that live in a normalized domain: filesystem paths today, and any future identifier whose canonical form is reached by normalization rather than byte equality. Path comparison must go through one canonical, version-stable primitive, and every such primitive must be proven against its normalization equivalence class.

Sources:

- Node.js `path.resolve` (normalization contract, stable since v0.3.4): <https://nodejs.org/api/path.html>: "The resulting path is normalized and trailing slashes are removed unless the path is resolved to the root directory. Zero-length path segments are ignored."
- Node.js `path.relative` trailing-separator change at v23.0.0: <https://github.com/nodejs/node/issues/55424>: `path.relative` output for paths that differ only by a trailing separator is not stable across Node versions.
- Property-based / equivalence-class testing: the `fast-check` dependency already in this repo (`tests/core/paths.test.ts`, `tests/core/property.test.ts`).

This repo supports Node 22 and Node 24. A path check that relies on `path.relative`'s trailing-separator output is correct on one and may be wrong on the other.

## Hard rules

- `src/paths.ts` is the single canonical owner for path containment and overlap. It exports `pathContainsOrEqual(parent, child)` and `pathsOverlap(a, b)`.
- Both primitives normalize inputs through `path.resolve` before computing `path.relative`. `path.resolve` strips trailing separators and resolves `./` and `..`, so the result is stable across the supported Node range. Never compare paths with raw `path.relative` for the equal/overlap case.
- Do not compare path values with `===` / `!==` on the raw strings, and do not compare `path.relative(...)` against `""`. Both miss path-equivalent inputs (trailing separator, `./`, `..`) and the latter is version-fragile.
- New path-containment or overlap checks in tracked JS/TS MUST call `pathContainsOrEqual` or `pathsOverlap`. Inline `relative(...) === ""` / `relative(...) !== ""` patterns are prohibited outside `src/paths.ts`.
- Every change to `src/paths.ts` MUST keep `tests/core/paths.test.ts` green, including the property tests that assert invariance under trailing-separator and `./`-prefix normalization.
- When a new normalized domain is introduced (for example SQL identifier folding or URL normalization), add its canonical primitive and equivalence-class test in the same change. Do not inline byte comparisons and do not generalize this rule's path primitives to the new domain by copying them.

## Enforced by

- `tests/core/paths.test.ts`: explicit overlap/containment cases plus `fast-check` property tests: symmetry, and invariance under trailing-separator and `./`-prefix normalization.
- `scripts/guards/code-shape/check-path-comparison.mts` (in `npm run guard`) — AST-scans all tracked JS/TS (`.ts`/`.mts`/`.mjs`/`.js`/`.cjs`, excluding `src/paths.ts`) and fails on any `relative(...)` compared `=== ""` / `!== ""`, directly or via a same-file variable. Emits `PATH_COMPARISON_OK`.
- Review: a path-containment or overlap change that does not route through `src/paths.ts` or does not add an equivalence-class row is incomplete.

## Verification

After touching `src/paths.ts`, any path-comparison call site, or this rule:

```bash
npx vitest run tests/core/paths.test.ts
npm run guard
```

## Failure behavior

Move the comparison into `src/paths.ts` (resolve-based) and add an equivalence-class test row. Do not silence the guard by renaming the variable, reordering the comparison, or adding a local `relative`-based helper.

## Done means

Every path comparison in `src/**` routes through `src/paths.ts`, the property tests prove invariance across the normalization equivalence class on both Node 22 and Node 24, and the AST guard prevents the byte-equality and raw-`relative` patterns from returning.
