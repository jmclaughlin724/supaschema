#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse as parseToml } from "smol-toml";
import { at, isRecord, type JsonRecord, parseJson, recordOf } from "../../lib/json.mts";
import { assert, ok } from "../lib/assertions.mts";
import { exists, ROOT, readJson, readText } from "../lib/repository.mts";

const required = [
  "services/agent-mcp/supaschema_agent_mcp/server.py",
  "services/agent-mcp/pyproject.toml",
  "pyproject.toml",
  "fastmcp.json",
  ".mcp.json",
  ".codex/config.toml",
];

const requiredSharedServers = [
  "cloudflare-api",
  "cloudflare-docs",
  "supaschema",
  "context7",
  "openaiDeveloperDocs",
  "ultracite",
  "zod",
  "supaschema-docs",
];
const registryOnlyServers = ["stripe"];
const expectedRegistryInputs = [
  {
    type: "promptString",
    id: "cloudflare-api-token",
    description: "Cloudflare API token",
    password: true,
  },
];
const expectedRegistryServers = {
  "cloudflare-api": {
    type: "http",
    url: "https://mcp.cloudflare.com/mcp",
    headers: { Authorization: ["Bearer $", "{input:cloudflare-api-token}"].join("") },
  },
  "cloudflare-docs": { type: "http", url: "https://docs.mcp.cloudflare.com/mcp" },
  supaschema: {
    command: "uv",
    args: [
      "run",
      "--package",
      "supaschema-agent-mcp",
      "fastmcp",
      "run",
      "fastmcp.json",
      "--skip-env",
    ],
  },
  context7: { type: "http", url: "https://mcp.context7.com/mcp" },
  openaiDeveloperDocs: { type: "http", url: "https://developers.openai.com/mcp" },
  stripe: { url: "https://mcp.stripe.com" },
  ultracite: { type: "http", url: "https://gitmcp.io/haydenbleasel/ultracite" },
  zod: { type: "http", url: "https://mcp.inkeep.com/zod/mcp" },
  "supaschema-docs": { type: "http", url: "https://supaschema.com/docs/mcp" },
};
const disallowedServers = ["MCP_DOCKER", "cclsp", "next-devtools", "render", "sentry"];
const unsupportedProjectClientConfigs = [
  ".cursor/mcp.json",
  ".gemini/settings.json",
  ".vscode/mcp.json",
];
const expectedCodexWiring = {
  "cloudflare-api": {
    url: "https://mcp.cloudflare.com/mcp",
    bearer_token_env_var: "CLOUDFLARE_API_TOKEN",
  },
  "cloudflare-docs": { url: "https://docs.mcp.cloudflare.com/mcp" },
  supaschema: {
    command: "uv",
    args: [
      "run",
      "--package",
      "supaschema-agent-mcp",
      "fastmcp",
      "run",
      "fastmcp.json",
      "--skip-env",
    ],
  },
  context7: { url: "https://mcp.context7.com/mcp" },
  openaiDeveloperDocs: { url: "https://developers.openai.com/mcp" },
  ultracite: { url: "https://gitmcp.io/haydenbleasel/ultracite" },
  zod: { url: "https://mcp.inkeep.com/zod/mcp" },
  "supaschema-docs": { url: "https://supaschema.com/docs/mcp" },
};
const allowedCodexServerKeys = new Set([
  "args",
  "bearer_token_env_var",
  "command",
  "default_tools_approval_mode",
  "enabled",
  "env",
  "required",
  "startup_timeout_sec",
  "tool_timeout_sec",
  "url",
]);

function codexWiring(config: unknown): unknown {
  const source = recordOf(config);
  const wiring: JsonRecord = {};
  for (const key of ["command", "args", "env", "url", "bearer_token_env_var"]) {
    if (source[key] !== undefined) {
      wiring[key] = source[key];
    }
  }
  return parseJson(JSON.stringify(wiring));
}

function assertCodexServerShape(serverName: string, config: JsonRecord): void {
  for (const key of Object.keys(config)) {
    assert(
      allowedCodexServerKeys.has(key),
      `.codex/config.toml ${serverName} has unsupported key ${key}`
    );
  }
  if (config.enabled !== undefined) {
    assert(
      typeof config.enabled === "boolean",
      `.codex/config.toml ${serverName}.enabled must be boolean`
    );
  }
  if (config.required !== undefined) {
    assert(
      typeof config.required === "boolean",
      `.codex/config.toml ${serverName}.required must be boolean`
    );
  }
  if (config.default_tools_approval_mode !== undefined) {
    assert(
      config.default_tools_approval_mode === "approve",
      `.codex/config.toml ${serverName} default_tools_approval_mode must remain approve`
    );
  }
}

function assertSameServerNames(
  actual: readonly string[],
  expected: readonly string[],
  message: string
): void {
  const sortedActual = [...actual].sort();
  const sortedExpected = [...expected].sort();
  assert(
    isDeepStrictEqual(sortedActual, sortedExpected),
    `${message}; expected ${JSON.stringify(sortedExpected)}, received ${JSON.stringify(sortedActual)}`
  );
}

export function check(root = ROOT): string {
  for (const file of required) {
    assert(exists(file, root), `missing ${file}`);
  }
  for (const file of unsupportedProjectClientConfigs) {
    assert(!exists(file, root), `${file} is an unsupported project MCP client config`);
  }

  const server = readText("services/agent-mcp/supaschema_agent_mcp/server.py", root);
  for (const token of [
    "readonly",
    "blocked_capabilities",
    "DENIED_PARTS",
    '".env"',
    '"secrets"',
    '"plans"',
    "SECRET_SUFFIXES",
    "repo_context_query",
    "repo_safety_scan",
    '["node", "dist/cli.js", "scan"',
    "upstream_mcp_capabilities",
    "Pointer index only",
    "cloudflare-docs",
    "supaschema-docs",
    "from fastmcp.exceptions import PromptError, ToolError",
    "raise PromptError(",
    "raise ToolError(",
    '"server": "supaschema"',
  ]) {
    assert(server.includes(token), `FastMCP server missing marker ${token}`);
  }
  assert(!server.includes("FastMCP.as_proxy"), "supaschema must not proxy other MCP servers");
  assert(
    !server.includes("raise ValueError("),
    "FastMCP handlers must raise PromptError or ToolError, not bare ValueError"
  );

  const fastmcp = readJson("fastmcp.json", root);
  assert(at(fastmcp, "source", "type") === "filesystem", "fastmcp source must use the filesystem");
  assert(
    at(fastmcp, "source", "path") === "services/agent-mcp/supaschema_agent_mcp/server.py",
    "fastmcp source path drifted"
  );
  assert(at(fastmcp, "source", "entrypoint") === "mcp", "fastmcp entrypoint must be mcp");
  assert(at(fastmcp, "environment", "type") === "uv", "fastmcp must use uv environment");
  assert(
    at(fastmcp, "environment", "project") === ".",
    "fastmcp uv project must be the repository root"
  );
  assert(at(fastmcp, "deployment", "transport") === "stdio", "fastmcp transport must be stdio");
  assert(
    at(fastmcp, "deployment", "cwd") === ".",
    "fastmcp working directory must be the repository root"
  );

  const registry = readJson(".mcp.json", root);
  const mcp = recordOf(at(registry, "mcpServers"));
  assert(
    isDeepStrictEqual(at(registry, "inputs"), expectedRegistryInputs),
    ".mcp.json inputs must keep the reviewed Cloudflare credential prompt"
  );
  assertSameServerNames(
    Object.keys(mcp),
    [...requiredSharedServers, ...registryOnlyServers],
    ".mcp.json registry must contain exactly the approved active and registry-only servers"
  );
  assert(
    isDeepStrictEqual(mcp, expectedRegistryServers),
    ".mcp.json registry wiring, transport, or authentication drifted"
  );
  for (const serverName of requiredSharedServers) {
    assert(mcp[serverName], `.mcp.json missing ${serverName}`);
  }
  for (const serverName of disallowedServers) {
    assert(!mcp[serverName], `.mcp.json must not expose ${serverName} MCP`);
  }
  assert(!mcp.repo_context, ".mcp.json must not expose legacy repo_context MCP");
  assert(
    at(mcp, "supaschema-docs", "url") === "https://supaschema.com/docs/mcp",
    ".mcp.json supaschema-docs must use /docs/mcp"
  );
  const codexConfig: unknown = parseToml(readText(".codex/config.toml", root));
  const codexServers = recordOf(at(codexConfig, "mcp_servers"));
  for (const [serverName, config] of Object.entries(codexServers)) {
    assert(
      requiredSharedServers.includes(serverName) || registryOnlyServers.includes(serverName),
      `.codex/config.toml exposes unapproved MCP server ${serverName}`
    );
    assert(isRecord(config), `.codex/config.toml ${serverName} must be a table`);
    assertCodexServerShape(serverName, config);
    if (registryOnlyServers.includes(serverName)) {
      assert(
        config.enabled === false,
        `.codex/config.toml registry-only server ${serverName} must remain disabled`
      );
    }
  }
  for (const serverName of requiredSharedServers) {
    assert(codexServers[serverName], `.codex/config.toml missing ${serverName}`);
    assert(
      at(codexServers, serverName, "enabled") !== false,
      `.codex/config.toml must enable ${serverName}`
    );
  }
  for (const serverName of registryOnlyServers) {
    assert(
      at(codexServers, serverName, "enabled") === false,
      `.codex/config.toml must explicitly disable registry-only server ${serverName}`
    );
  }
  for (const serverName of disallowedServers) {
    assert(!codexServers[serverName], `.codex/config.toml must not expose ${serverName} MCP`);
  }
  assert(!codexServers.repo_context, ".codex/config.toml must not expose legacy repo_context");
  assert(
    at(codexServers, "supaschema-docs", "url") === "https://supaschema.com/docs/mcp",
    ".codex/config.toml supaschema-docs must use /docs/mcp"
  );
  const activeCodexServers = Object.entries(codexServers)
    .filter(([, config]) => at(config, "enabled") !== false)
    .map(([serverName]) => serverName);
  assertSameServerNames(
    activeCodexServers,
    requiredSharedServers,
    ".codex/config.toml must activate exactly the approved MCP servers"
  );
  for (const [serverName, expectedWiring] of Object.entries(expectedCodexWiring)) {
    assert(
      isDeepStrictEqual(codexWiring(codexServers[serverName]), expectedWiring),
      `.codex/config.toml ${serverName} wiring or authentication drifted`
    );
  }

  const packageJson = readJson("package.json", root);
  for (const script of ["fastmcp:inspect", "fastmcp:list", "fastmcp:status", "guard:fastmcp"]) {
    assert(at(packageJson, "scripts", script), `package.json missing script ${script}`);
  }

  return "FASTMCP_AGENT_OK";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  ok(check());
}
