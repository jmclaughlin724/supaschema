# scripts/agent-hooks/ — shared hook runtime

Shared Claude and Codex hook runtime, imported by both `.claude/hooks/**` and `.codex/hooks/**`. Bare imports must be declared repository dependencies; the isolated session-lifecycle closure remains limited to its explicit `node:` builtin set and relative runtime files (enforced by `check-hook-import-graph.mjs`).

## Contents

- `hook-entrypoint.mjs` — shared stdin, runtime, output, and input-error handling
- `hook-runtime.mjs` — shared runtime identity and disabled-Codex short circuit
- `session-lifecycle.mjs` — silent SessionStart state refresh and SessionEnd cleanup
- `runner.mjs` — non-lifecycle event dispatcher (parser-backed Bash safety, comment-free source, and verification conflicts)
- `command-evidence.mjs` — shell-AST outcome attribution and domain-only verification evidence recording
- `comment-free-source.mjs` — write-time JS/TS comment classifier wired into the PreToolUse runner; shares `scripts/lib/source-comments.mts` with the push guard
- `response-evidence.mjs` — structured tool-outcome parsing only
- `response-claims.mjs` — parser-driven success claims checked only against unresolved structured failure evidence
- `state.mjs` — hook event-state model
- `hook-output.mjs` — event output shaping and failure diagnostics

## Dependency topology

- `.claude/settings.json` registers canonical `.claude/hooks/context-*.mjs` entrypoints. Session lifecycle entrypoints delegate only to `session-lifecycle.mjs`; all other context entrypoints delegate to `runner.mjs`.
- `runner.mjs` owns source-repo dispatch and composes the shared runtime modules above plus `.claude/hooks/guards/bash-policy-checks.mts` and `comment-free-source.mjs`, which imports the shared comment detector and code-file classifier from `scripts/lib/source-comments.mts` (the same owner the push-time `check-change-discipline.mjs` guard uses).
- `scripts/skills/sync-llm.mts` byte-mirrors canonical hook sources into `.codex/hooks/**`, renders `.codex/hooks.json`, and generates the package-manager-specific consumer configs under `agent-bundle/**`.
- `.claude/hooks/supaschema-source-hook.mts` bootstraps `dist/cli.js`, whose canonical source hook workflow is `src/hooks/**`.
- No hook runs `npm run sync:llm`. Agent-surface synchronization is an explicit command owned by `npm run guard:agent` and the `scripts/guards/check-all.mts` drift gate.
- Consumer hook templates invoke only the compiled Supaschema generated-artifact and schema-write hooks on actual edit tools; the source-repository Bash policy remains private to `runner.mjs`.
- `check-hook-import-graph.mjs` parses static import, re-export, and literal dynamic-import edges with the TypeScript AST and resolves every relative target. The two command/runtime edges above are intentionally non-import edges and are enforced by the hook registration, sync, package, and focused runtime tests.

## Owners

- Deterministic hook enforcement boundaries: `.claude/rules/12-skill-loading-enforcement.md`
- Generated agent-surface sync ownership: `.claude/rules/22-agent-surface-sync-ownership.md`
- Verify: `npm run guard:agent`, focused tests in `tests/agent-hooks/agent-hook-core.test.ts` and `tests/agent-hooks/agent-hooks.test.ts`
