---
enforcement:
  type: judgment-only
description: Canonical owner and sync matrix for Claude, Codex, Agents, skills, rules, hooks, MCP config, and package-bundled consumer surfaces.
paths:
  - "AGENTS.md"
  - "CLAUDE.md"
  - ".claude/**"
  - ".codex/**"
  - ".agents/**"
  - ".mcp.json"
  - "fastmcp.json"
  - "scripts/skills/**"
  - "scripts/agent-hooks/**"
  - "bin/scaffold.mjs"
  - "package.json"
---

# Rule 18 - Context surface sync

## Contract

This rule owns the canonical-owner and generated-mirror sync matrix for agent-facing context surfaces, plus the root-brief and tracked-runtime boundaries. Edit the owner first, then run the narrow sync that target requires; do not leave an owner stale while its mirror moves.

## Owner matrix

| Surface | Canonical owner | Targets | Sync / validation |
| --- | --- | --- | --- |
| Root Codex runtime brief | root `AGENTS.md` | loaded directly by Codex; imported by `CLAUDE.md` | no generated sync; preserve the user-owned brief |
| Nested Codex briefs | `<subfolder>/AGENTS.md` | loaded hierarchically by Codex for matching subtrees | no generated sync; validate scoped routes with `npm run guard` |
| Claude runtime entrypoint | `CLAUDE.md` | Claude Code | keep as a runtime entrypoint for Claude Code only; unique durable policy belongs in `AGENTS.md` or scoped rules |
| Rules | `.claude/rules/**` | Codex rule pointers/mirrors when packaged | `npm run sync:llm`; rule guard if available |
| Skills | `.claude/skills/**`; parsed `metadata.public` frontmatter marks public skills | `.agents/skills/**`; public `skills/**`; Agent/Claude bundle skill trees and manifest | `npm run sync:llm` |
| Hooks | `.claude/hooks/**` | `.codex/hooks/**` mirrors or native adapters where supported | edit Claude/shared owner, then sync or update native adapter |
| Native Codex hook registration | `scripts/skills/sync-llm.mts` plus `.claude/settings.json` | `.codex/hooks.json` and packaged consumer registration | idempotent `npm run sync:llm`, hook/package guards |
| MCP registry | `.mcp.json`, `fastmcp.json` | local MCP clients and package docs | `npm run guard:fastmcp`, `npm run guard:agent` |
| Consumer agent bundle | curated `.claude/skills/**`, `.claude/rules/supaschema.md`, consumer hook sources, `agent-bundle/INSTALL.md`, `package.json#files`, `bin/scaffold.mjs`, `scripts/skills/sync-llm.mts` | raw npm tarball bundle, ordered skills manifest, and default installed project scaffold | `npm run sync:llm`, `npm run check:package`, `npm pack --dry-run --json`, lifecycle tests |

## Rules

- `.claude/**` is the canonical authoring surface for maintainer Claude rules, skills, hooks, and agents.
- The root `AGENTS.md` is the canonical, user-owned Codex project brief because Codex loads it directly and does not load `.claude/rules/**` prose automatically. This rule does not constrain the root brief to a route map, concise projection, rule index, or any prescribed content shape.
- Route-map, concision, section-order, and content-placement guidance applies only to nested `<subfolder>/AGENTS.md` files. Any owner pointer in a nested brief must resolve to a live owner.
- `CLAUDE.md` MUST import `@AGENTS.md` when maintainer hooks are enabled, so Claude sessions receive the same root operating contract that Codex receives.
- `.codex/**` and `.agents/**` are generated or native runtime targets only where this rule names them as owners. Generated `.codex/rules/**` contain command policy or owner pointers, not the Markdown rule prose, so they do not replace the root or nested `AGENTS.md` chain.
- `scripts/skills/sync-llm.mts` is the writer for generated LLM mirrors and generated source-repo `.codex/hooks.json`. It MUST validate Claude hook registration and the `CLAUDE.md` root-contract import before rendering Codex hook registration. Do not hand-edit synced copies.
- `skills/supaschema` is a generated public mirror of `.claude/skills/supaschema`. It is the only supported `npx skills` source in this repository.
- Source-repo hook runtime, Claude rules, generated Codex rule mirrors, and `.claude/settings.json` are public branch surfaces when tracked `.codex/hooks.json`, guards, or `AGENTS.md` route to them. Keep personal overlays, optimizer skills, maintainer-only agents, `.codex/config.toml`, MCP/deployment configs, private services, and generated state gitignored.
- Do not use `.gitignore` or Git index flags to hide a file required by tracked hook registration, tracked guards, or tracked rule routing. Track the required runtime file or remove the tracked reference.
- `README.md` and `docs/**` are public product surfaces. They may reference agent setup, but they do not own operator policy.
- Generated mirrors are not live reloads. Restart the CLI/session or reload the extension before expecting new runtime behavior.

## Sync selection

| Change | Minimum sync/check |
| --- | --- |
| Supaschema consumer skill/rule/hook | `npm run sync:llm`, package checks when bundled |
| Maintainer skill only | `npm run sync:llm` for mirrored skills |
| Hook source | `npm run guard:agent`, focused hook tests, `npm run sync:llm` if mirrored |
| Shared runtime adapter | `npm run sync:llm`, `npm run guard:agent`, focused hook/sync tests |
| Generated Codex hook registration or package hook templates | `npm run sync:llm`, `npm run guard:agent`, focused sync/hook tests |
| Public/private agent-surface boundary | `npm run guard:public-surface`, `npm run check:package`, focused editor/package tests |
| MCP surface | `npm run guard:fastmcp`, `npm run guard:agent` |
| Package bundle | `npm run check:package`, `npm pack --dry-run --json`, lifecycle tests |

## Verification

Run the narrowest sync/check that matches the edited surface. For full context-surface changes, run:

```bash
npm run sync:llm
npm run guard
```

For package-bundled consumer surfaces, also run `npm run check:package` and `npm pack --dry-run --json`.

## Failure behavior

If sync or public/private boundary validation fails:

1. Identify whether the failure is in the canonical owner, sync script, generated target, native runtime config, or parsed public-skill metadata.
2. Fix the canonical owner or sync script first.
3. Re-run the actual narrow sync and applicable guard.
4. Do not hide required source-repo runtime behind `.gitignore`; add or repair tracked guard and test enforcement and keep package output narrow instead.

## Done means

- Canonical owner and generated targets agree.
- Required source-repo runtime and rules are tracked branch surfaces; personal DX and generated state remain gitignored.
- Runtime registrations match the hook/MCP surfaces they expose.
- Source-repo Claude and Codex shell tools match one context `PreToolUse` hook command, and consumer hook templates contain only Supaschema product hooks.
- No generated mirror carries unique policy.
