# scripts/ — repo tooling

Maintainer scripts: guards, agent-hook runtime, agent-surface sync, docs linting, release/github helpers, and local-only Stripe tooling.

## Subfolders

- `guards/` — `check-*.mjs` invariant guards (`npm run guard`)
- `agent-hooks/` — shared Claude/Codex hook runtime
- `skills/` — `sync-llm.mjs` agent-surface sync writer
- `docs-lint/` — canonical docs-standard CLI and its internal inspectors
- `lib/` — shared Git-visible file discovery for formatter adapters
- `stripe/` — local-only (gitignored)

## Top-level scripts

- `cclsp-language-id-proxy.mjs` — TypeScript language-ID normalization adapter
- `clean-dist.mjs`, `ensure-bin-executable.mjs` — build lifecycle helpers
- `format-sh.mjs`, `format-toml.mjs` — per-language formatter adapters

## Owners

- Operating rules and gates: `.claude/rules/01-operating-rules.md`
- Toolchain and formatters: `.claude/rules/06-multi-language-toolchain.md`
