import { describe, expect, it } from "vitest";
import { check } from "../../../scripts/guards/fastmcp/check-fastmcp-agent.mts";
import { tempGuardRepo } from "../fixture.js";

const cloudflareRegistryAuthorization = ["Bearer $", "{input:cloudflare-api-token}"].join("");

type ServerConfig = Record<string, unknown>;

interface FixtureState {
  codexServers: Record<string, ServerConfig>;
  extraFiles: Record<string, string>;
  registryInputs: Record<string, unknown>[];
  registryServers: Record<string, ServerConfig>;
}

const registryServers: Record<string, ServerConfig> = {
  "cloudflare-api": {
    type: "http",
    url: "https://mcp.cloudflare.com/mcp",
    headers: { Authorization: cloudflareRegistryAuthorization },
  },
  "cloudflare-docs": {
    type: "http",
    url: "https://docs.mcp.cloudflare.com/mcp",
  },
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
  openaiDeveloperDocs: {
    type: "http",
    url: "https://developers.openai.com/mcp",
  },
  stripe: { url: "https://mcp.stripe.com" },
  ultracite: {
    type: "http",
    url: "https://gitmcp.io/haydenbleasel/ultracite",
  },
  zod: { type: "http", url: "https://mcp.inkeep.com/zod/mcp" },
  "supaschema-docs": {
    type: "http",
    url: "https://supaschema.com/docs/mcp",
  },
};

const codexServers: Record<string, ServerConfig> = {
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
  stripe: { enabled: false, url: "https://mcp.stripe.com" },
};

const serverSource = `
SERVER_CONTRACT_MARKERS = """
readonly
blocked_capabilities
DENIED_PARTS
".env"
"secrets"
"plans"
SECRET_SUFFIXES
repo_context_query
repo_safety_scan
["node", "dist/cli.js", "scan"
upstream_mcp_capabilities
Pointer index only
cloudflare-docs
supaschema-docs
from fastmcp.exceptions import PromptError, ToolError
raise PromptError(
raise ToolError(
"server": "supaschema"
"""
`;

const fixture = (mutate?: (state: FixtureState) => void): string => {
  const state: FixtureState = {
    codexServers: structuredClone(codexServers),
    extraFiles: {},
    registryInputs: [
      {
        type: "promptString",
        id: "cloudflare-api-token",
        description: "Cloudflare API token",
        password: true,
      },
    ],
    registryServers: structuredClone(registryServers),
  };
  mutate?.(state);

  return tempGuardRepo({
    "services/agent-mcp/supaschema_agent_mcp/server.py": serverSource,
    "services/agent-mcp/pyproject.toml": "",
    "pyproject.toml": "",
    "fastmcp.json": JSON.stringify({
      source: {
        type: "filesystem",
        path: "services/agent-mcp/supaschema_agent_mcp/server.py",
        entrypoint: "mcp",
      },
      environment: { type: "uv", project: "." },
      deployment: { transport: "stdio", cwd: "." },
    }),
    ".mcp.json": JSON.stringify({
      inputs: state.registryInputs,
      mcpServers: state.registryServers,
    }),
    ".claude/settings.json": "{}",
    ".codex/config.toml": renderCodexConfig(state.codexServers),
    "package.json": JSON.stringify({
      type: "module",
      scripts: {
        "fastmcp:inspect": "fastmcp inspect fastmcp.json",
        "fastmcp:list": "fastmcp list fastmcp.json",
        "fastmcp:status": "fastmcp call fastmcp.json server_status",
        "guard:fastmcp": "node scripts/guards/fastmcp/check-fastmcp-agent.mts",
      },
    }),
    ...state.extraFiles,
  });
};

const renderCodexConfig = (servers: Record<string, ServerConfig>): string =>
  `${Object.entries(servers)
    .map(([serverName, config]) => {
      const entries = Object.entries(config).map(
        ([key, value]) => `${key} = ${renderTomlValue(value)}`
      );
      return [`[mcp_servers.${serverName}]`, ...entries].join("\n");
    })
    .join("\n\n")}\n`;

const renderTomlValue = (value: unknown): string => {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(renderTomlValue).join(", ")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${key} = ${renderTomlValue(entry)}`)
      .join(", ")} }`;
  }
  throw new TypeError(`unsupported TOML fixture value ${String(value)}`);
};

describe("FastMCP agent guard", () => {
  it("accepts canonical registry and Codex activation without Claude approval preferences", () => {
    expect(check(fixture())).toBe("FASTMCP_AGENT_OK");
  });

  it("does not own Claude project-server approval preferences", () => {
    const root = fixture((state) => {
      state.extraFiles[".claude/settings.json"] = JSON.stringify({
        enableAllProjectMcpServers: true,
        enabledMcpjsonServers: ["supaschema"],
        disabledMcpjsonServers: ["context7"],
      });
    });

    expect(check(root)).toBe("FASTMCP_AGENT_OK");
  });

  it("rejects an activated unregistered server", () => {
    const root = fixture((state) => {
      state.codexServers.unregistered = {
        command: "node",
        args: ["unreviewed-server.mjs"],
      };
    });

    expect(() => check(root)).toThrow(
      ".codex/config.toml exposes unapproved MCP server unregistered"
    );
  });

  it("rejects a consistently configured but unapproved executable server", () => {
    const root = fixture((state) => {
      const unapprovedServer = {
        command: "node",
        args: ["unreviewed-server.mjs"],
      };
      state.registryServers.unapproved = unapprovedServer;
      state.codexServers.unapproved = structuredClone(unapprovedServer);
    });

    expect(() => check(root)).toThrow(
      ".mcp.json registry must contain exactly the approved active and registry-only servers"
    );
  });

  it("rejects cclsp as a disallowed registry server", () => {
    const root = fixture((state) => {
      state.registryServers.cclsp = {
        command: "npx",
        args: ["--no-install", "cclsp"],
        env: { CCLSP_CONFIG_PATH: "cclsp.json" },
      };
    });

    expect(() => check(root)).toThrow(
      ".mcp.json registry must contain exactly the approved active and registry-only servers"
    );
  });

  it("rejects exact supaschema Codex wiring drift", () => {
    const root = fixture((state) => {
      const config = state.codexServers.supaschema;
      if (config) {
        config.args = ["run", "fastmcp", "run", "fastmcp.json"];
      }
    });

    expect(() => check(root)).toThrow(
      ".codex/config.toml supaschema wiring or authentication drifted"
    );
  });

  it("rejects Cloudflare registry authorization-header drift", () => {
    const root = fixture((state) => {
      const config = state.registryServers["cloudflare-api"];
      if (config) {
        config.headers = { Authorization: ["Bearer $", "{input:wrong-token}"].join("") };
      }
    });

    expect(() => check(root)).toThrow(
      ".mcp.json registry wiring, transport, or authentication drifted"
    );
  });

  it("rejects Cloudflare Codex bearer-token environment drift", () => {
    const root = fixture((state) => {
      const config = state.codexServers["cloudflare-api"];
      if (config) {
        config.bearer_token_env_var = "WRONG_TOKEN";
      }
    });

    expect(() => check(root)).toThrow(
      ".codex/config.toml cloudflare-api wiring or authentication drifted"
    );
  });

  it("rejects unsupported project MCP client configuration", () => {
    const root = fixture((state) => {
      state.extraFiles[".cursor/mcp.json"] = JSON.stringify({ mcpServers: {} });
    });

    expect(() => check(root)).toThrow(
      ".cursor/mcp.json is an unsupported project MCP client config"
    );
  });
});
