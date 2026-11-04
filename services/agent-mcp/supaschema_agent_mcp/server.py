import json
import subprocess
from pathlib import Path, PurePosixPath
from typing import Annotated, Any, Literal

from fastmcp import FastMCP
from fastmcp.exceptions import PromptError, ToolError
from mcp.types import ToolAnnotations
from pydantic import Field

PROJECT_ROOT = Path(__file__).resolve().parents[3]
REPO_ROOT = PROJECT_ROOT
MAX_READ_BYTES = 120_000
PRIVATE_PATHS_FILE = REPO_ROOT / "scripts" / "guards" / "repo-surface" / "private-paths.json"


def _load_private_roots() -> tuple[str, ...]:
    data = json.loads(PRIVATE_PATHS_FILE.read_text(encoding="utf8"))
    prefixes = data["heldPrivate"] + data["agentPrivate"]
    return tuple(p.removesuffix("/") for p in prefixes if isinstance(p, str) and p.endswith("/"))


PRIVATE_ROOTS = _load_private_roots()
PRIVATE_ROOTS_CASEFOLDED = tuple(root.casefold() for root in PRIVATE_ROOTS)

DENIED_PARTS = {
    ".git",
    ".tmp",
    ".venv",
    "__pycache__",
    "dist",
    "build",
    "coverage",
    "node_modules",
    "plans",
    "secrets",
    "venv",
}
SECRET_SUFFIXES = (".key", ".pem", ".p12", ".pfx")
SECRET_NAMES = {".dev.vars", ".netrc", ".npmrc", ".pgpass", ".pypirc"}
SEARCH_PREFIXES = (
    "src/",
    "tests/",
    "scripts/",
    "docs/",
    "examples/",
    "corpus/",
    "benchmarks/",
    "bin/",
    "cloudflare/",
    "services/",
    ".github/workflows/",
    ".claude/rules/",
    ".claude/skills/",
    ".codex/rules/",
    ".agents/skills/",
)
SEARCH_FILES = {
    "AGENTS.md",
    "CLAUDE.md",
    "package.json",
    "pyproject.toml",
    "fastmcp.json",
    ".mcp.json",
    "cclsp.json",
    ".claude/settings.json",
    ".codex/config.toml",
}


def _denied(p: Path) -> bool:
    n = p.name.casefold()
    if n.startswith(".env") or n.endswith(SECRET_SUFFIXES):
        return True
    if n in SECRET_NAMES or n.startswith(".dev.vars."):
        return True
    posix_path = p.as_posix().casefold()
    if any(
        posix_path == root or posix_path.startswith(f"{root}/") for root in PRIVATE_ROOTS_CASEFOLDED
    ):
        return True
    return any(part.casefold() in DENIED_PARTS for part in p.parts)


def _resolve(raw: str) -> Path:
    pp = PurePosixPath(raw.strip())
    if pp.is_absolute() or any(s in {"", ".", ".."} for s in pp.parts):
        raise ToolError("repo-relative paths only, no traversal")
    rel = (REPO_ROOT / Path(*pp.parts)).resolve()
    if not rel.is_relative_to(REPO_ROOT):
        raise ToolError("outside repo root")
    repo_relative = rel.relative_to(REPO_ROOT)
    if _denied(repo_relative):
        raise ToolError("path is denied")
    return repo_relative


def _read_text(rel: Path, max_bytes: int = MAX_READ_BYTES) -> str:
    full = REPO_ROOT / rel
    if not full.is_file():
        raise ToolError("not a file")
    if full.stat().st_size > max_bytes:
        raise ToolError("file is too large for context read")
    return full.read_text(encoding="utf8", errors="replace")


def _git_files() -> list[str]:
    r = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if r.returncode != 0:
        return []
    return [
        item
        for item in r.stdout.split("\0")
        if item
        and (item in SEARCH_FILES or item.startswith(SEARCH_PREFIXES))
        and not _denied(Path(item))
    ]


def _mcp_configured() -> set[str]:
    config = REPO_ROOT / ".mcp.json"
    if not config.exists():
        return set()
    try:
        parsed = json.loads(config.read_text(encoding="utf8"))
    except json.JSONDecodeError:
        return set()
    servers = parsed.get("mcpServers")
    if isinstance(servers, dict):
        return set(servers)
    return set()


mcp = FastMCP(
    "Supaschema Local Context",
    mask_error_details=True,
)

READ_ONLY_TOOL = ToolAnnotations(
    read_only_hint=True,
    open_world_hint=False,
    idempotent_hint=True,
)

RepoContextAction = Literal["search", "read", "agent-instructions"]


def _upstream_mcp_capabilities(
    capability: Literal["all", "docs", "framework", "library", "product"] = "all",
) -> dict[str, Any]:
    configured = _mcp_configured()
    index = [
        {
            "server": "context7",
            "family": "library",
            "use_for": "Current library docs by package name.",
        },
        {"server": "zod", "family": "library", "use_for": "Current Zod documentation."},
        {
            "server": "ultracite",
            "family": "library",
            "use_for": "Ultracite linting and formatting docs.",
        },
        {
            "server": "cloudflare-docs",
            "family": "docs",
            "use_for": "Cloudflare product documentation.",
        },
        {
            "server": "openaiDeveloperDocs",
            "family": "product",
            "use_for": "OpenAI API, Agents SDK, and ChatGPT Apps documentation.",
        },
        {"server": "supaschema-docs", "family": "product", "use_for": "Published supaschema docs."},
    ]
    filtered = [item for item in index if capability == "all" or item["family"] == capability]
    return {
        "note": "Pointer index only; this server never calls or proxies other MCP servers.",
        "capabilities": [{**item, "configured": item["server"] in configured} for item in filtered],
    }


def _search_repo_context(query: str, limit: int = 20) -> dict[str, Any]:
    needle = query.lower()
    matches: list[dict[str, Any]] = []
    for file in _git_files():
        rel = _resolve(file)
        try:
            text = _read_text(rel)
        except ToolError:
            continue
        for number, line in enumerate(text.splitlines(), start=1):
            if needle in line.lower():
                matches.append({"path": str(rel), "line": number, "text": line[:500]})
                if len(matches) >= limit:
                    return {"matches": matches}
    return {"matches": matches}


def _read_context_file(path: str) -> dict[str, Any]:
    rel = _resolve(path)
    return {"path": str(rel), "text": _read_text(rel)}


def _nearest_agent_instructions(path: str) -> dict[str, Any]:
    rel = _resolve(path)
    full = REPO_ROOT / rel
    current = full if full.is_dir() else full.parent
    chain: list[dict[str, str]] = []
    while current.is_relative_to(REPO_ROOT):
        candidate = current / "AGENTS.md"
        if candidate.exists() and not _denied(candidate.relative_to(REPO_ROOT)):
            item_rel = candidate.relative_to(REPO_ROOT)
            chain.append({"path": str(item_rel), "text": _read_text(item_rel)})
        if current == REPO_ROOT:
            break
        current = current.parent
    chain.reverse()
    return {"path": str(rel), "instructions": chain}


@mcp.tool(annotations=READ_ONLY_TOOL)
def server_status() -> dict[str, Any]:
    """Summarize this read-only local supaschema server."""
    return {
        "server": "supaschema",
        "readonly": True,
        "repo_root": str(REPO_ROOT),
        "tools": [
            "server_status",
            "repo_context_query",
            "repo_safety_scan",
            "session_state",
        ],
        "repo_context_hint": (
            "Use repo_context_query to search or read repository context and nearest AGENTS.md "
            "instructions. Prove exact behavior with source, the configured language server, "
            "and focused tests. Validate MCP/client configuration with npm run guard:fastmcp."
        ),
        "session_state_hint": (
            "session_state validates a session id and reports that no persisted state is available."
        ),
        "blocked_capabilities": [
            "live database, mutating, or generic SQL",
            "arbitrary shell",
            "DB/API mutation",
            "credential reads",
            "external LLM calls",
        ],
        "upstream_mcp_capabilities": _upstream_mcp_capabilities(),
    }


@mcp.tool(annotations=READ_ONLY_TOOL)
def repo_context_query(
    action: Annotated[RepoContextAction, Field(description="Repo context action")],
    target: Annotated[str, Field(description="Search text or repo-relative path")],
    limit: Annotated[int, Field(ge=1, le=50)] = 20,
) -> dict[str, Any]:
    """Search/read safe repo context or load nearest agent instructions."""
    match action:
        case "search":
            if len(target.strip()) < 2:
                raise ToolError("search target must be at least 2 characters")
            return _search_repo_context(target, limit)
        case "read":
            return _read_context_file(target)
        case "agent-instructions":
            return _nearest_agent_instructions(target)
    raise ToolError("unsupported repo context action")


def _scan_source(value: str) -> str:
    if value in ("empty:", "git:HEAD", "git:INDEX"):
        return value
    for prefix in ("dir:", "dump:", "catalog:", "migrations:"):
        if value.startswith(prefix):
            rel = _resolve(value[len(prefix) :])
            return f"{prefix}{rel.as_posix()}"
    raise ToolError(
        "unsupported source; use a repo-relative dir:/dump:/catalog:/migrations: path, "
        "empty:, git:HEAD, or git:INDEX"
    )


@mcp.tool(annotations=READ_ONLY_TOOL)
def repo_safety_scan(
    source: Annotated[
        str | None, Field(description="Schema source to scan; defaults to the declarative tree")
    ] = None,
) -> dict[str, Any]:
    """Run a read-only supaschema safety scan and return JSON findings (no DB, no mutation)."""
    v = (source or "").strip()
    if v and (v.startswith("-") or any(c in v for c in "\x00\n\r")):
        raise ToolError("unsafe source value")
    if v.startswith("database:") or "://" in v:
        raise ToolError("repo_safety_scan stays local; database/URL sources are not allowed")
    normalized_source = _scan_source(v) if v else None
    cli = REPO_ROOT / "dist" / "cli.js"
    if not cli.is_file():
        return {
            "ok": False,
            "stdout": None,
            "stderr": "dist/cli.js is missing; run `npm run build` in the repository first",
        }
    args = ["node", "dist/cli.js", "scan", "--reporter", "json"]
    if normalized_source:
        args += ["--from", normalized_source]
    r = subprocess.run(args, cwd=REPO_ROOT, capture_output=True, text=True, timeout=60, check=False)
    stdout: Any
    try:
        stdout = json.loads(r.stdout or "null")
    except json.JSONDecodeError:
        stdout = r.stdout[:MAX_READ_BYTES]
    return {"ok": r.returncode == 0, "stdout": stdout, "stderr": r.stderr[:MAX_READ_BYTES]}


@mcp.tool(annotations=READ_ONLY_TOOL)
def session_state(
    session_id: Annotated[str, Field(description="Session id to inspect")],
) -> dict[str, Any]:
    """Read loaded skills, pending skills, and verification evidence for one hook session."""
    sid = (session_id or "").strip()
    if not sid or len(sid) > 200:
        raise ToolError("invalid session id")
    if any(ch in sid for ch in ("/", "\\", "\0")) or ".." in sid:
        raise ToolError("invalid session id")
    return {
        "ok": True,
        "session_id": sid,
        "state": None,
        "note": "no persisted session state is available",
    }


@mcp.resource("repo://agents/root")
def root_agents() -> str:
    return _read_text(Path("AGENTS.md"))


@mcp.resource("repo://rules/{name}")
def rule_resource(name: str) -> str:
    rel = _resolve(f".claude/rules/{name}.md")
    return _read_text(rel)


@mcp.resource("repo://skills/{name}")
def skill_resource(name: str) -> str:
    rel = _resolve(f".claude/skills/{name}/SKILL.md")
    return _read_text(rel)


@mcp.resource("repo://mcp/config")
def mcp_config_resource() -> str:
    rel = _resolve(".mcp.json")
    return _read_text(rel)


@mcp.prompt
def prepare_repo_change(target: str) -> str:
    scope = json.dumps({"target": target}, ensure_ascii=True, sort_keys=True)
    return (
        f"Prepare the repository change target encoded by this JSON object: {scope}. "
        "Use repo_context_query to load the nearest AGENTS.md instructions and search for exact "
        "owners and consumers. Use the configured language server for symbol references, read "
        "every owner before editing, and validate MCP/client configuration changes with "
        "npm run guard:fastmcp."
    )


@mcp.prompt
def review_repo_change(base: str, head: str = "HEAD") -> str:
    if not base.strip():
        raise PromptError("base must be non-empty")
    if not head.strip():
        raise PromptError("head must be non-empty")
    scope = json.dumps({"base": base, "head": head}, ensure_ascii=True, sort_keys=True)
    return (
        f"Review the explicit diff scope encoded by this JSON object: {scope}. "
        "Use repo_context_query to load the nearest AGENTS.md instructions and "
        "exact owner context. "
        "Inspect only the explicit diff, require a changed filePath and re-read source for every "
        "finding, and report only actionable findings grounded in that diff. Use the model already "
        "authenticated by the host; do not send code, credentials, or review candidates to an "
        "external provider. Use the configured language server and focused tests for verification. "
        "Validate MCP/client configuration with npm run guard:fastmcp."
    )


@mcp.prompt
def verify_repo_change(target: str) -> str:
    scope = json.dumps({"target": target}, ensure_ascii=True, sort_keys=True)
    return (
        f"Verify the repository change target encoded by this JSON object: {scope}. "
        "Use repo_context_query to load the nearest AGENTS.md instructions and "
        "exact owner context, "
        "call repo_safety_scan for schema, SQL, or migration changes. Use the configured "
        "language server for impacted "
        "symbols and run "
        "the narrowest relevant tests plus the sync and agent guards for their owned surfaces. For "
        "MCP/client configuration surfaces, run npm run guard:fastmcp."
    )


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
