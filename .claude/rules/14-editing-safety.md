---
enforcement:
  type: judgment-only
description: Editing safety, generated-artifact discipline, concurrent-change preservation, and source deletion sweeps.
codexExecPolicy: |
  [
    {
      "pattern": [["mktemp", "tempfile"]],
      "decision": "forbidden",
      "justification": "Temporary and scratch working-state commands are forbidden.",
      "match": ["mktemp -d", "tempfile"],
      "not_match": ["mkdir src/new-feature", "npm run sync:llm", "git status --short"]
    },
    {
      "pattern": ["git", "clone"],
      "decision": "forbidden",
      "justification": "Reviewable-work invariant.",
      "match": ["git clone . ../demo", "git clone https://example.com/repo.git demo"],
      "not_match": ["git status --short", "git show main:package.json"]
    }
  ]
paths:
  - "src/**"
  - "tests/**"
  - "docs/**"
  - "scripts/**"
  - "bin/**"
  - "services/agent-mcp/**"
  - ".claude/**"
  - ".codex/**"
  - ".agents/**"
  - "AGENTS.md"
  - "CLAUDE.md"
---

# Rule 14 - Editing safety

## Contract

This rule owns file-edit safety, reviewable in-place work, generated-artifact discipline, concurrent-change preservation, and deletion/rename sweeps.

## Reviewable-work invariant

Agent-authored task work must be performed directly on intended canonical files in the active checkout and remain visible to Git. Do not create or use intermediate, disposable, copied, alternate, temporary, scratch, cache, ignored, or hidden working state anywhere, and do not redirect work to evade a permission, hook, guard, status, diff, or review boundary. If a validation path requires such state, skip it and report the check as unrun.

## Editing rules

- Keep changes owner-scoped and use the canonical owner that satisfies the requested end state.
- Prefer structured edits (`apply_patch`, editor tool, AST/LSP rename, or repo codemod) over shell write tricks for source changes.
- Treat edit-tool success as transport evidence only. Inspect the resulting file or diff and run the narrow owner check before claiming the patch worked; an `apply_patch` success or `Done` message does not prove the intended content landed.
- Do not use broad replacement on substrings of wider identifiers. Verify uniqueness or use AST/LSP rename.
- Do not hand-edit generated artifacts such as `dist/**`, generated config contract outputs, generated migrations, generated docs output, or LLM mirrors.
- For generated surfaces, edit the canonical owner and run the generator or sync command.

## Concurrent changes

- Preserve edits and files not intentionally authored in the current task.
- If a file changed since it was read, re-read it, preserve unrelated hunks, and continue.
- Treat watcher, dev-server, hook, subagent, and parallel-agent output as user-owned unless the current task started that process.
- If another session owns overlapping generated output, preserve unrelated hunks and rerun the canonical sync or generator.
- If a path disappears between inspection and mutation, or its owner becomes uncertain, stop the affected mutation, re-resolve the live path and owner, and continue only independent in-scope work until that boundary is clear.
- Treat a denied or blocked command as an enforced boundary. Do not retry the same destructive effect through another command, tool, script, or file operation.

## Delete, rename, and export-shape sweeps

Before deleting, renaming, privatizing, or changing a public export/package surface:

1. Establish owners and consumers from repository instructions, manifests, and the applicable AST/LSP tooling.
2. Use exact fixed-string search for docs, fixtures, generated-surface references, package manifests, examples, and prose.
3. Update or retire consumers in the same change.
4. Update tests, docs, package boundary expectations, and generated mirrors if the public surface changed.

## Verification

Review every touched file and run its owner checks.

## Failure behavior

Fix failures caused by the current change and rerun the failed owner check. Do not overwrite unrelated work to reach a simpler diff.

## Done means

- Only task-owned hunks were changed.
- Unrelated concurrent work was preserved.
- Generated mirrors were synced from their owners, not patched directly.
- Delete, rename, and export changes include consumer-sweep evidence.
