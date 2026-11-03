---
description: Parser/AST-first policy. AST/parser analysis is sanctioned throughout the repo wherever it applies; prefer it over regex.
paths:
  - "src/**"
  - "scripts/**"
  - "services/**"
  - "tests/**"
  - "bin/**"
  - ".claude/hooks/**"
---

# Rule 07 - Analyze structure with an AST/parser, not regex

## Contract

This rule owns the policy that structural analysis uses an AST/parser. AST/parser use is sanctioned throughout the repo wherever it applies, with no restriction by directory, language, or surface.

Guards, hooks, scripts, source, and tests use a real AST/parser for structural analysis anywhere in the repo. Wherever a parser exists for the format, it is the preferred tool for structural questions: the TypeScript compiler API for JS/TS, libpg_query for SQL, `JSON.parse` for JSON, a YAML/TOML parser for config, mdast for Markdown/MDX, the Python `ast` module, or the owned shell parsers below.

Regex cannot see structure. Quote style, whitespace, type parameters, comments, string contents, and node nesting all create bypasses and false positives; an adversarial pass found about twelve bypasses in the regex-era shape detector (single or mixed quotes, `z .enum`, `z.enum (`, a marker smuggled inside a string). A parser sees the real tree, so that whole class of holes is gone by construction. Literal string operations remain appropriate for non-structural scalar-value tests: a version prefix, a path suffix, or membership in a known set. When a Zod config field must emit a JSON Schema `pattern` keyword, inject it with `.meta({ pattern: "..." })` instead of `.regex()`. `zodTypesImportPath` in `src/config/schema.ts` is the canonical example; the emitted schema is identical and source stays free of regex literals.

Enforced by `scripts/guards/code-shape/check-canonical-surfaces.mts` (in `npm run guard` via `scripts/guards/check-all.mts`), which AST-scans every tracked JS/TS, Python, and shell file under `src/`, `scripts/`, `services/`, `tests/`, `bin/`, `benchmarks/`, `.claude/hooks/`, `.claude/skills/`, `.agents/skills/`, `cloudflare/`, plus root config scripts. It fails on regex literals, `RegExp(...)` calls, regex-shaped strings, Python `re` usage, and shell `=~`. Detection is itself AST/parser-based, so the rule dogfoods.

Guards enforce observable structure or behavior: AST shape, file existence, JSON registration, hook topology, or runtime output. They never assert that a documentation file contains a specific prose string. Test behavior, or enforce policy at its canonical owner; coupling a guard to doc wording is brittle and circular.

## Comment-free source

The comment detector and code-file classifier are owned by `scripts/lib/source-comments.mts`, consumed by two boundaries so they cannot drift. `scripts/guards/code-shape/check-change-discipline.mts` runs the invariant at push time inside `npm run guard`: tracked JS/TS source carries no comments. Line comments, block comments, and JSDoc are all violations; the only exemption is a shebang at the start of the file. The scanned set is every tracked `.cjs`, `.js`, `.jsx`, `.mjs`, `.ts`, and `.tsx` file (excluding `.d.ts`) under the roots listed above, plus root `prettier.config.mjs` and `vitest.config.ts`. Python and shell sources carry the same rule through their own detectors. `scripts/agent-hooks/comment-free-source.mts` enforces the same invariant at write time in the maintainer PreToolUse runner, denying a `Write`/`Edit`/`MultiEdit`/`apply_patch` that adds a comment to tracked JS/TS source before the tool runs; Python and shell stay push-guard-only.

Explain non-obvious intent through a surface that outlives the code:

- an intent-carrying function or variable name;
- a user-facing diagnostic `hint` string, which is where a `SUPA_*` code already states the constraint;
- a test name that reads as the specification;
- the owning rule, when the constraint is durable policy rather than local mechanics.

Do not relocate a comment into an empty block to evade detection. Do not add a suppression pragma; none exists.

## Use the right tool

| What you are analyzing | Use |
| --- | --- |
| TypeScript / JS / JSX structure | TypeScript compiler API via `scripts/guards/lib/typescript-ast.mts` (`parse`, `parseScript`, `forEachNode`) |
| Postgres schema SQL (tables, RLS, functions…) | the real Postgres parser via `scripts/guards/lib/sql-ast.mts` (libpg-query / libpg_query) |
| Python structure | the `ast` module (see `scripts/guards/code-shape/check-pattern-engine.mts` for the in-guard pattern) |
| Bash tool-command structure in agent hooks | synchronous `parse` from `unbash` through `scripts/agent-hooks/shell-command.mts` |
| Shell-file structure and multi-dialect formatting | `parse` / `print` from `sh-syntax` (mvdan/sh WASM) |
| `package.json` / `tsconfig` / JSON config | `JSON.parse` + object walks |
| YAML / TOML config | a YAML parser / `taplo` parser |
| Markdown / MDX structure | a markdown AST (mdast) |

The parser owners are `scripts/guards/lib/typescript-ast.mts`, `scripts/guards/lib/sql-ast.mts`, and `scripts/agent-hooks/shell-command.mts`. The TypeScript compiler API is sufficient for this repository's syntax and import analysis; do not add `ts-morph` unless a concrete project-model or mutation requirement exceeds that owner.

## Regex resolution sequence

When resolving a regex violation, use `ast-grep` as the first discovery or codemod pass when it is available in the active toolchain. Then use the TypeScript AST, the compiler, or the relevant parser/typecheck lane to prove exact node classes and compile safety. Replace regex behavior with the canonical scanner, parser, or model helper in the owning module. Re-run the ast-grep query plus the parser-backed guard to prove zero pattern-engine nodes remain. If `ast-grep` is unavailable, record that fact and use the canonical AST scanner as the fallback evidence.

## Decision posture

Research authoritative upstream best practice rather than guessing. Where a first-class parser exists for the format, it is the canonical choice.

STOP if regex ships for structural analysis anywhere in the repo where an AST/parser can express the check. STOP if a guard requires a documentation file to contain a specific prose string instead of testing behavior or structure; let the rule own its wording.

## Verification

Run `npm run guard` or `node scripts/guards/code-shape/check-canonical-surfaces.mts` after changing source, scripts, hooks, guards, or parser helpers. Detector changes need focused true-positive and false-positive tests.

## Failure behavior

Convert regex to the canonical parser for the format: TypeScript AST, libpg-query, Python `ast`, `unbash` for Bash hook commands, `sh-syntax` for shell files, `JSON.parse`, a YAML/TOML parser, or mdast.

## Done means

Structural analysis across the repo uses the canonical parser for its format, and the parser-backed guard plus focused tests cover the target structure.
