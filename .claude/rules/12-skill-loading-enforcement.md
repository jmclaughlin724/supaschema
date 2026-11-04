---
description: Narrow parser-backed hook enforcement boundaries.
enforcement:
  type: enforced
paths:
  - ".claude/agents/**"
  - ".claude/hooks/**"
  - ".claude/settings*.json"
  - ".claude/skills/**"
  - ".agents/skills/**"
  - ".codex/agents/**"
  - ".codex/hooks*"
  - "scripts/agent-hooks/**"
  - "scripts/guards/agent-surface/**"
  - "tests/agent-hooks/**"
---

# Rule 12 - Hook enforcement boundaries

## Contract

Repository hooks are guardrails. They do not prove user authorization, confine filesystem access, establish complete command comprehension, or replace the platform permission model.

Hook denials require a positive classification owned by this rule: a parser-confirmed Bash safety conflict, a generated-artifact edit conflict, a schema-workflow conflict, a comment-introducing edit to tracked JS/TS source, or a success claim contradicted by unresolved structured verification failure evidence. Unexpected parser, state, or hook failures emit a visible warning and make no blocking decision.

`PreToolUse` fires on the `Skill` tool itself and carries the invoked name in `tool_input.skill`, so a hook can observe a skill load by recording it from its own stdin. Claude Code still has no native file-trigger mechanism (verified against https://code.claude.com/docs/en/hooks). Repository hooks here nonetheless do not gate tool use on skill presence, and do not consume skill `metadata.file-triggers` or `metadata.keywords`. That is a choice, not a platform limit. Skills deliver context on demand through normal platform matching; durable agent-surface policy lives in rules and in native `PreToolUse` hooks. The prior custom skill-loading gate (pending/loaded session state, observable-load detection, force-load denials) was removed because it reconstructed session state instead of reading the invoked name from the hook payload, which made its `Skill` recognition unreliable.

## Event behavior

- When `.codex/config.toml` sets `features.hooks = false`, already-loaded Codex hook entrypoints return no decision, context, or state mutation; Claude hooks are unaffected.
- `SessionStart` and `SessionEnd` validate their payloads and remain silent on success.
- `UserPromptSubmit` only begins the turn; it does not match skills or persist prompt text.
- Context `PreToolUse` is registered for `Agent|Bash|Edit|Glob|Grep|MultiEdit|NotebookEdit|Read|Task|WebFetch|WebSearch|Write|apply_patch` in both source Claude settings and the generated Codex configuration. The runner applies the parser-backed Bash safety boundary and the comment-free source boundary; it does not gate edits on skill loads.
- Context `PostToolUse` is limited to `Bash|Read|Skill`. Claude `PostToolUseFailure` is limited to `Bash` and records only failed verification outcomes.
- Verification outcomes are recorded only when parsed shell control flow and CLI semantics make the structured outer tool status evidence for that domain. State stores the domain and outcome, never the command.
- `Stop` and `SubagentStop` block only a current explicit successful verification claim contradicted by the latest recorded outcome for that domain. No evidence is unknown and allowed; a later matching success resolves the conflict.

## Parser-backed Bash boundary

`scripts/agent-hooks/shell-command.mts` parses shell source with `unbash`; option structure is interpreted with Node's `parseArgs`. PostgreSQL literals are classified by the repository's libpg-query parser in `scripts/agent-hooks/postgres-ddl.mts`. Do not replace these owners with regular-expression scanning or command-text allowlists.

The Bash hook blocks only:

- literal secret values in argv or direct `cat` display of known secret-bearing files, excluding example, sample, default, and template files;
- recursive forced deletion whose parsed target is dynamic or resolves to `/`, the user home, the repository root, or an ancestor of the repository; and
- literal raw-DDL arguments passed directly to a known PostgreSQL command interface.

Git, branch, reset, push, merge, and worktree commands are outside hook enforcement. SQL files, stdin, and heredocs are outside the literal-DDL classifier. Unknown or unparseable shell shapes are allowed. Policy and platform permissions still apply to every allowed command.

## Comment-free source boundary

`scripts/agent-hooks/comment-free-source.mts` denies a `Write`/`Edit`/`MultiEdit`/`apply_patch` that adds a `//` or block comment to a tracked JS/TS source file. Comment detection and the code-file classifier are owned by `scripts/lib/source-comments.mts`, which parses proposed content with the TypeScript compiler API (`scripts/guards/lib/typescript-ast.mts`); this is the same detector the push-time guard uses, so the two boundaries cannot drift. Parsing is structural, which is why `//` inside a string literal is not flagged where a regex would false-positive.

The check denies only on a net-added comment: for `Edit`/`MultiEdit` it reconstructs the post-edit text and compares the comment multiset against the file's current comments, so edits to already-commented files and edits that re-touch a line near an existing comment are allowed. `Write` and `apply_patch` add-file scans treat the whole proposed content. An `apply_patch` update scans its `+`-prefixed added lines best-effort. Python (`.py`) and shell (`.sh`) comments stay push-guard-only because their detectors need a `python3` spawn or async WASM parse, unsuited to a synchronous hook. A crash in the check is a visible warning with no blocking decision.

## State

- Repository hook and MCP configurations do not synthesize or persist session state; each hook process uses only event-local in-memory state.

## Verification

```bash
npm run guard:agent
npm test -- tests/agent-hooks/agent-hook-core.test.ts tests/agent-hooks/agent-hooks.test.ts
```

## Failure behavior

Fix the canonical owner for the misbehaving check, then rerun the narrow hook test or `npm run guard:agent`. Do not weaken, skip, or hand-approve around a gate to close it out.

- Wrong Bash allow or deny: fix the parser-backed classification in `scripts/agent-hooks/shell-command.mts` or the PostgreSQL literal classifier in `scripts/agent-hooks/postgres-ddl.mts`. Do not add a text allowlist or regex carve-out.
- Wrong verification-domain evidence or a false completion conflict: fix `scripts/agent-hooks/command-evidence.mts` or `scripts/agent-hooks/response-claims.mts`.
- Wrong comment-free allow or deny: fix the classification in `scripts/agent-hooks/comment-free-source.mts` or the shared detector in `scripts/lib/source-comments.mts`. Do not add a text allowlist or regex carve-out.
- An unexpected parser, state, or hook crash: fix the reported source location. The event stays a visible warning with no policy decision, never a silent pass and never a hard denial.

## Done means

- Bash denials come from the parser-backed positive classifications above; Git and unparseable shapes are not denied.
- Comment-free denials come only from net-added comments in tracked JS/TS source; `//` inside string literals, Python, and shell are not denied at write time.
- Verification conflicts use only parser-attributed domains and outcomes.
- Lifecycle hooks are silent, unexpected failures are visible and non-blocking, and generated registrations match the event contract.
- No hook denies a tool based on skill-loading state, and no skill `file-triggers`/`keywords` metadata is consumed by hooks.
