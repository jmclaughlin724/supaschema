# src/hooks - supaschema CLI hook runtime

## Contract

This directory implements the product hook commands used by editor and agent workflows. It is included so schema-write automation, generated-artifact blocking, and hook output stay in the CLI package rather than maintainer-only agent hook infrastructure.

## Contents

- `config.ts` resolves schema path state and automatic sync plans.
- `targets.ts` identifies changed hook targets.
- `checks.ts` runs configured migration check gates and verify suggestions.
- `commands.ts` resolves and runs the supaschema binary.
- `output.ts` renders agent/editor hook responses.

## Dependency topology

- `src/cli.ts` owns the hidden `supaschema hook schema-write` and `supaschema hook generated-artifact-edit` commands and delegates their payloads to `output.ts`.
- `output.ts` is the workflow composition owner: it consumes `config.ts`, `targets.ts`, `checks.ts`, and `commands.ts`.
- `config.ts` consumes canonical config, database URL, and schema-path resolution; `checks.ts` consumes command execution and target rendering.
- `commands.ts` owns process execution and consumes `redaction.ts`, which owns secret redaction; `targets.ts` owns path containment, bounded write-command target extraction, configured contract targets, and generated-migration lineage inspection.
- `.claude/hooks/supaschema-source-hook.mts` reaches this runtime through built `dist/cli.js`; generated package-consumer registrations invoke the installed `supaschema` binary directly.
- `tests/hooks/workflow.test.ts` owns product workflow behavior. Agent registration and packaged consumer edges are covered by `tests/agent-hooks/**`, `tests/cli/editor.test.ts`, and `tests/package/contents.test.ts`.

## Working Rules

- Keep this package-safe hook runtime separate from `scripts/agent-hooks/**`.
- Keep each module on the dependency edge documented above; do not introduce a second workflow, process, path, config, or output owner.
- Hook output must be deterministic, concise, and actionable for the calling editor or agent.
- Do not weaken generated-artifact protection without updating config ownership, policy, tests, and consumer docs. Only a delete-only `apply_patch` target may use generated-migration recovery; Bash deletion and configured TypeScript/Zod contract deletion are blocked. `mv` classifies its sources as deletes and its destination as a write; plain and `export`-ed shell assignments feed variable expansion before target resolution; backslashes survive as path separators except before shell-special characters, so Windows drive paths classify like POSIX paths. Classification failures must return a runtime-specific denial, never silently fail open.

## Verification

Run focused hook tests and `npm run typecheck`; for package-facing hook changes also run `npm run check:package`.
