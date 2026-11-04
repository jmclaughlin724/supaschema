---
description: Repo-local FastMCP agent server contract, read-only tool surface, deny-list, and alignment checks.
paths:
  - "services/agent-mcp/**"
  - "fastmcp.json"
  - ".mcp.json"
  - ".codex/config.toml"
  - ".claude/settings.json"
  - "scripts/guards/fastmcp/**"
---

# Rule 11 - Agent MCP FastMCP

## Contract

This rule owns the repo-local FastMCP agent server surface: local stdio, read-only, no credential reads, no shell or mutation authority, and alignment across MCP config, server code, tests, and guards. Repo-local agent MCP servers are governed surfaces, not throwaway helpers.

## Server scope and capabilities

- `supaschema` is the canonical supaschema FastMCP server (`services/agent-mcp`, package `supaschema-agent-mcp`) for local repo-agent context. It stays read-only and local stdio.
- `supaschema` may expose whatever local read-only tools the server owns. The guard does not freeze the tool count or require a hard-coded catalog. Current core capabilities include `server_status`, repo context reads and search, a local safety scan, and session-state status.
- Repo context tools must read and search non-secret repo files on a deny-list model (AGENTS instructions, rules, skills, source, schemas, tooling config) and return the nearest agent instructions when supported.
- Safety-scan tools must run read-only `supaschema scan` through fixed argv (`node dist/cli.js scan --reporter json`): input-validated, no database, no mutation. Caller sources are limited to repo-contained forms: repo-relative `dir:`, `dump:`, `catalog:`, and `migrations:` payloads resolved inside the repository with the same deny-list, plus `empty:`, `git:HEAD`, and `git:INDEX`. A missing `dist/cli.js` returns an actionable build instruction instead of a raw subprocess error.
- The session-state tool validates the supplied identifier and returns `state: null` without filesystem or subprocess access.
- Secrets and credentials stay blocked: `.env*`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `.npmrc`, `.netrc`, `.pgpass`, `.pypirc`, `.dev.vars*`, and `secrets/`, plus `.git`, caches and build output, and archived `plans/`.
- No tool may expose live-database SQL, SQL mutation, a generic SQL engine, arbitrary shell execution, DB or API mutation, credential reads, external LLM calls, or proxy calls to other MCP servers.
- The detailed implementation and verification owner is `.claude/skills/fastmcp/SKILL.md` and `services/agent-mcp/supaschema_agent_mcp/server.py`.

## Registry and Codex wiring

- `fastmcp.json`, `.mcp.json`, `.codex/config.toml`, `services/agent-mcp/supaschema_agent_mcp/server.py`, `services/agent-mcp/tests/`, and `scripts/guards/fastmcp/check-fastmcp-agent.mts` must stay aligned. `supaschema-docs` remains the separate remote public docs MCP.
- `.mcp.json` is the exact local server registry. `.codex/config.toml` is the exact checked-in Codex activation and wiring owner: every configured server must exist in the registry, shared transport and auth fields must agree, and registry-only entries must be explicitly disabled.
- The guard pins registry transport and auth fields, the Cloudflare input prompt and Codex bearer-token environment variable, local command/argv/env, remote URLs, approved Codex server keys, and fail-closed Codex approval settings.
- Claude discovers project servers from `.mcp.json`. `enableAllProjectMcpServers`, `enabledMcpjsonServers`, and `disabledMcpjsonServers` in `.claude/settings.json` are optional user or project approval preferences, not required repository invariants. When those preferences are absent, Claude uses its normal project-server approval flow. The guard must not add, require, or compare those optional Claude keys.

## Repo tooling and evidence posture

- `services/agent-mcp/**` is tracked maintainer tooling: the server, its config, and the guard ship in the repo so agents can see and verify them. `npm run guard:fastmcp` runs the full alignment check unconditionally.
- Use the FastMCP client CLI for local smoke checks: `npm run fastmcp:inspect`, `npm run fastmcp:list`, and `npm run fastmcp:status`. Use `fastmcp discover` only for local operator diagnostics because it can read user-level MCP client configs.
- Do not treat MCP output as final proof for repo decisions. `supaschema` shortens context gathering; repo guards, focused tests, configured language-server tooling, and source reads remain the reproducible evidence.

## Guardrail boundary

STOP if any of these occurs:

- `supaschema` gains write authority, live-database or mutating SQL, a generic SQL engine, raw command execution, secret or credential reads, reads outside the repository root, or proxy access to another MCP.
- The approved registry or Codex activation set, transport, authentication, command wiring, or approval posture drifts.
- A guard starts owning optional Claude project-server approval preferences.
- Canonical skill changes are not followed by `npm run sync:llm`.
- A FastMCP change ships without `npm run guard:fastmcp`, `npm run guard:agent`, and the relevant Python checks.

## Verification

After FastMCP server, MCP config, capability index, deny-list, or client CLI changes, run:

```bash
npm run guard:fastmcp
npm run guard:agent
npm run py:typecheck
npm run py:test
npm run fastmcp:status
```

Use `npm run fastmcp:list` or `npm run fastmcp:inspect` for smoke checks. Wiring verification is `npm run guard:fastmcp` returning `FASTMCP_AGENT_OK`.

## Failure behavior

Restore read-only, repo-root-contained behavior. Do not expose writes, live-database or mutating SQL, a generic SQL engine, shell execution, credential reads, external LLM calls, or proxy calls to other MCP servers.

## Done means

FastMCP surfaces, config, capability index, tests, and guards agree; `supaschema` stays read-only and non-secret; and the registry and Codex wiring remain deterministic without overriding Claude's optional project-server approval preferences.
