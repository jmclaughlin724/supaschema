---
description: Python uv workspace, ruff, mypy, pytest, pip-audit, and pylsp standards for services/agent-mcp.
paths:
  - "services/agent-mcp/**"
  - "pyproject.toml"
  - "uv.lock"
  - ".python-version"
  - "lsp-soleaux.json"
  - ".github/workflows/python.yml"
  - "scripts/guards/fastmcp/**"
---

# Rule 04 - Python toolchain (uv + ruff + mypy) and pylsp

## Contract

This rule owns the Python developer toolchain for `services/agent-mcp`: uv workspace layout, ruff formatting and linting, mypy strict typing, pytest, pip-audit, and pylsp/lsp-soleaux integration.

The Python side of this repo is a single uv workspace member: `services/agent-mcp` (`supaschema-agent-mcp`), the read-only local supaschema FastMCP side service. There is no FastAPI, no `services/api`, no `services/workers`, and no web HTTP API here. The server is FastMCP (`fastmcp` plus `pydantic`). This rule owns only the Python developer toolchain: format, lint, types, tests, supply chain, and the pylsp language server. The `py:*` commands are npm scripts that shell out to `uv`.

## Layout

- Root `pyproject.toml` is the uv workspace root: `[tool.uv] package = false`, `[tool.uv.workspace] members = ["services/agent-mcp"]`, and `requires-python = ">=3.14,<3.15"`. It owns the shared `[dependency-groups] dev` tools, the `[tool.ruff]`, `[tool.mypy]`, and `[tool.pytest.ini_options]` config, and the pylsp plugin config tables.
- `services/agent-mcp/pyproject.toml` owns the runtime package (`fastmcp`, `pydantic`, `pytest-asyncio`) and its `[project.scripts] supaschema-agent-mcp` entrypoint. Application code lives in `services/agent-mcp/supaschema_agent_mcp/`; tests live in `services/agent-mcp/tests/`.
- `uv.lock` is the single workspace lockfile. After changing any dependency or dev tool, run `uv lock` and commit `uv.lock`. CI runs `uv sync --locked`, which fails on drift.

## Skill routing

- Use `$python` for Python app and library work: server/CLI entry points, `pyproject.toml`/uv/dependency groups, tests, packaging, supply-chain provenance, async/concurrency, logging, debugging, profiling, and typing boundaries. This rule's repo-owned commands and gates stay authoritative over generic skill defaults.

## Language server (lsp-soleaux + pylsp)

- Code navigation and refactors for agents go through the lsp-soleaux MCP server. Tracked root `lsp-soleaux.json` maps `.py`/`.pyi` to `uv run pylsp` so it reads the locked workspace `.venv` and root config. The file is source-repository tooling and is never published or scaffolded.
- Root `lsp-soleaux.json` passes plugin configuration directly as `initializationOptions.pylsp`, not `initializationOptions.settings.pylsp`: lsp-soleaux forwards the object unchanged and pylsp reads the top-level `pylsp` key. Its `restartInterval: 5` applies only to pylsp and restarts the same `uv run pylsp` command every five minutes.
- The Python LSP is python-lsp-server (pylsp), pinned in the root dev group, with the editor plugins `python-lsp-ruff`, `pylsp-rope`, and `pyls-memestra`. All three live in `[dependency-groups] dev`. Install or refresh with `uv sync`, never a global pip: the plugins must share the workspace `.venv` or `uv run pylsp` cannot see them.
- Root `lsp-soleaux.json` and local `.vscode/settings.json` configure `python-lsp-ruff` as the sole formatter/linter plugin: `formatEnabled: true` runs Ruff formatting, `format: ["I"]` applies Ruff import-sorting fixes, and `signature.formatter: "ruff"` uses Ruff for signature rendering. Rope provides refactors, memestra flags deprecations, and pylsp's redundant built-ins (pycodestyle, pyflakes, mccabe, autopep8, yapf, flake8, pylint, pydocstyle) are disabled.

## One owner per concern

- **ruff owns formatting and linting** in pylsp, local editor settings, and CLI/CI. `ruff format` is the formatter and `ruff check` is the linter. Line length is set once in `[tool.ruff] line-length = 100`, with `[tool.ruff.lint] select` for the enabled rule families.
- **mypy owns types**, in strict mode: `[tool.mypy] strict = true`, `files = ["services/agent-mcp/supaschema_agent_mcp"]`. Pyright is not used in this repo.
- **pytest owns tests**, with `pytest-asyncio` and `asyncio_mode = "auto"`; `[tool.pytest.ini_options] testpaths` points at `services/agent-mcp/tests`.
- **pip-audit owns the Python supply-chain scan** in CI.

Do not add direct `python-lsp-black` or `python-lsp-isort` dependencies, `[tool.black]` or `[tool.isort]` tables, or matching pylsp formatter plugins. Ruff's formatter and `I` rules are the single formatting and import-sorting owners.

## Commands

Run from the repo root (these are real npm scripts in `package.json`):

```bash
npm run py:format:check   # uv run --package supaschema-agent-mcp ruff format --check services/agent-mcp
npm run py:lint           # uv run --package supaschema-agent-mcp ruff check services/agent-mcp
npm run py:fix            # uv run ... ruff check --fix && ruff format — the Python write lane (lint-fix + import sort + format)
npm run py:typecheck      # uv run --package supaschema-agent-mcp mypy services/agent-mcp/supaschema_agent_mcp
npm run py:test           # uv run --package supaschema-agent-mcp pytest services/agent-mcp/tests
```

Apply Python fixes locally with `npm run py:fix`, which runs `ruff check --fix` for lint and import sorting, then `ruff format`. The repo-wide write command `npm run format` chains it. The `py:format:check` and `py:lint` variants are the read-only CI gates.

## Gates

- `.github/workflows/python.yml` is tracked with `services/agent-mcp`: the Python CI lane runs on every checkout and requires the tracked FastMCP service files. The focused local lane remains the `py:*` command set above.
- The `--package supaschema-agent-mcp` selector is mandatory. The workspace root has no runtime deps (`dependencies = []`, `package = false`) and does not depend on the member, so a bare `uv run mypy` or `uv run pytest` resolves in the root env that lacks `fastmcp`/`mcp`/`pydantic` and fails with `import-not-found`.
- `npm run guard:lsp-coverage` (`scripts/guards/toolchain/check-lsp-coverage.mts`, part of `npm run guard`) hard-blocks if any tracked code extension, including `.py`/`.pyi`, is not mapped in tracked root `lsp-soleaux.json`.
- `npm run guard:fastmcp` (`scripts/guards/fastmcp/check-fastmcp-agent.mts`) keeps the FastMCP server surface aligned.
- After changing any dev tool or runtime dependency, run `uv lock` and commit `uv.lock`. The `uv sync --locked` step fails the PR on drift.

STOP if any of these occurs:

- A Python file ships unformatted (`ruff format --check` fails), fails ruff lint, or fails strict `mypy`.
- `uv.lock` drifts from `pyproject.toml` (`uv sync --locked` would fail).
- Ruff's line length diverges from `100`.
- The `.py`/`.pyi` lsp-soleaux mapping, the direct `initializationOptions.pylsp` envelope, the five-minute restart, or a required `python-lsp-ruff`, `pylsp-rope`, or `pyls-memestra` plugin is removed.
- Black or standalone isort formatting returns, or a competing Python formatter, linter, or type checker is added.
- A `python.yml` step or any script runs a bare `uv run <tool>` that needs the member environment (`mypy`/`pytest`) without `--package supaschema-agent-mcp`, diverging from the canonical `py:*` invocations.
- FastAPI, `services/api`, pnpm, or any HTTP-API-only construct is reintroduced into this FastMCP-only Python surface.

## Verification

When Python code, Python dependencies, pylsp config, or Python CI changes, run the focused Python lane:

```bash
npm run py:format:check
npm run py:lint
npm run py:typecheck
npm run py:test
```

After dependency or tool changes, run `uv lock` and verify `uv sync --locked` semantics.

## Failure behavior

Fix ruff, mypy, pytest, uv lock drift, and package selector errors in the Python owner. Do not replace ruff/mypy/pytest with competing tools or run bare `uv run` commands that miss the `supaschema-agent-mcp` member environment.

## Done means

Python code is formatted, linted, typed, and tested; `uv.lock` is current when dependencies changed; and FastMCP-specific behavior passes its relevant checks.
