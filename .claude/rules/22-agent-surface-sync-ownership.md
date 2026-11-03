---
description: Generated agent-surface ownership, synchronization, and hook-registration projections.
enforcement:
  type: enforced
paths:
  - ".claude/agents/**"
  - ".claude/hooks/**"
  - ".claude/rules/**"
  - ".claude/settings.json"
  - ".claude/skills/**"
  - ".agents/skills/**"
  - ".codex/agents/**"
  - ".codex/hooks/**"
  - ".codex/hooks.json"
  - ".codex/rules/**"
  - "agent-bundle/**"
  - "scripts/guards/agent-surface/**"
  - "scripts/skills/agent-surface-manifest.mts"
  - "scripts/skills/sync-llm.mts"
---

# Rule 22 - Generated agent-surface sync ownership

## Contract

`scripts/skills/sync-llm.mts` is the single idempotent writer for generated Claude-to-Codex, Claude-to-Agents, public-skill, and consumer-bundle outputs. Generated surfaces are never independent inputs.

Synchronization is always the actual write operation. There is no check-only sync command or read-only parity mode. Run `npm run sync:llm`; content-identical writes are skipped.

Synchronization is explicit. No hook, lifecycle event, or Git hook runs the writer automatically. Run `npm run sync:llm` after editing a canonical source, or let `npm run guard:agent` run it for you; `scripts/guards/check-all.mts` fails when the writer changes a tracked generated surface, so drift is caught before merge rather than repaired mid-edit.

## Ownership

- `.claude/settings.json` owns source Claude hook registration.
- `.claude/hooks/**`, `.claude/rules/**`, `.claude/skills/**`, and `.claude/agents/**` own their generated projections.
- `scripts/skills/agent-surface-manifest.mts` owns canonical source roots, exact source files where ownership is singular, applicable source file types, and targets. The only agent prompt input is `.agents/prompts/supaschema-install.md`; sibling prompt files are unrelated.
- Parsed skill frontmatter with `metadata.public: true` owns public skill publication; no separate skill-name list exists.
- `.codex/config.toml` remains a direct runtime owner and is not generated.
- Consumer templates contain only the Supaschema generated-artifact protection and schema-write workflow hooks.

## Hook registration projection

- Source Claude and generated Codex register silent `SessionStart` and `SessionEnd`, prompt matching, subagent advisory context, and Stop verification-conflict checks.
- Context `PreToolUse` uses `Agent|Bash|Edit|Glob|Grep|MultiEdit|NotebookEdit|Read|Task|WebFetch|WebSearch|Write|apply_patch` in both runtimes.
- Context `PostToolUse` uses `Bash|Read|Skill`. Claude alone registers `PostToolUseFailure` for `Bash`.
- Claude product hooks use `Write|Edit|MultiEdit|apply_patch`; Codex product hooks use `apply_patch`.
- `WorktreeCreate` is not registered. No event registers agent-surface synchronization; a hook MUST NOT run `sync:llm`.
- Codex commands resolve the repository with `git rev-parse --show-toplevel` and provide a Windows equivalent; they do not depend on undocumented project-root injection.

## Enforcement chain

- `npm run guard:agent` runs the actual sync writer before topology and import-closure guards.
- `scripts/guards/check-all.mts` runs the writer and fails when a tracked generated surface changes, so drift blocks the umbrella gate.
- `scripts/guards/agent-surface/check-agent-hooks.mts` owns exact registration and consumer-template topology, and rejects any hook that runs surface sync.
- `scripts/guards/toolchain/check-tooling-stack.mts` rejects a lefthook pre-commit job that runs `sync:llm`.
- `scripts/guards/agent-surface/check-hook-import-graph.mts` owns runtime import closure.
- Focused tests under `tests/agent-hooks/**` own writer idempotence, runtime decisions, and consumer projections.

## Verification

```bash
npm run sync:llm
npm run guard:agent
npm test -- tests/agent-hooks/sync-llm.test.ts tests/agent-hooks/agent-hook-core.test.ts tests/agent-hooks/agent-surfaces.test.ts tests/agent-hooks/agent-hooks.test.ts
```

For consumer-boundary changes, also run `npm run guard:public-surface` and `npm run check:package`.

## Failure behavior

If sync, writer, or registration validation fails:

1. Identify whether the failure is in a canonical source (`.claude/hooks/**`, `.claude/rules/**`, `.claude/skills/**`, `.claude/agents/**`, `.claude/settings.json`), the manifest (`scripts/skills/agent-surface-manifest.mts`), or the writer (`scripts/skills/sync-llm.mts`).
2. Fix the canonical source or the manifest's source roots and exact files first. Never hand-edit `.codex/hooks.json`, `.codex/hooks/**`, `.codex/rules/**`, `.codex/agents/**`, `.agents/skills/**`, public `skills/**`, or `agent-bundle/**`.
3. Re-run `npm run sync:llm`. A content-identical write is a no-op, so a persistent diff after rerunning means the source or manifest fix was incomplete.
4. Re-run `npm run guard:agent` so the topology and import-closure guards prove the projection against the regenerated targets.
5. If a generated surface is stale in CI, run the writer and commit its output. Do not add a hook, Git hook, digest state, or a second sync path to regenerate it automatically.
6. If a consumer-boundary check fails, fix the stripping or rendering logic in `sync-llm.mjs` (source-only hook removal, package-manager command materialization); do not patch the generated `agent-bundle/**` output directly.

## Done means

- The actual writer has run after the final canonical edit.
- Generated Codex, Agents, public-skill, and consumer surfaces reflect parsed canonical inputs.
- Maintainer registrations implement the exact event and matcher contract above.
- Consumer templates contain exactly the two product hooks with runtime-correct edit matchers.
- No hook or Git hook runs the writer, and no check-only sync command, digest state, or duplicate publication list remains.
