export interface AgentSurface {
  excludedSourceDirectories?: readonly string[];
  excludeHiddenSourceDirectories?: boolean;
  sourceExtension?: string;
  sourceFile?: string;
  sourceRoot?: string;
  targetFile?: string;
  targetRoot?: string;
  targetRoots?: readonly string[];
}

export const agentSurfaceManifest = Object.freeze({
  agentBundle: Object.freeze({
    targetRoot: "agent-bundle",
  }),
  agents: Object.freeze({
    sourceRoot: ".claude/agents",
    targetRoot: ".codex/agents",
  }),
  bundleDocs: Object.freeze({
    excludedSourceDirectories: Object.freeze(["dist", "node_modules"]),
    excludeHiddenSourceDirectories: true,
    sourceExtension: ".mdx",
    sourceRoot: "docs",
    targetRoot: "agent-bundle/docs",
  }),
  codexHookConfig: Object.freeze({
    sourceFile: ".claude/settings.json",
    targetFile: ".codex/hooks.json",
  }),
  hooks: Object.freeze({
    sourceRoot: ".claude/hooks",
    targetRoot: ".codex/hooks",
  }),
  publicSkills: Object.freeze({
    sourceRoot: ".claude/skills",
    targetRoot: "skills",
  }),
  rules: Object.freeze({
    sourceRoot: ".claude/rules",
    targetRoot: ".codex/rules",
  }),
  skills: Object.freeze({
    sourceRoot: ".claude/skills",
    targetRoots: Object.freeze([".agents/skills"]),
  }),
  sourcePrompts: Object.freeze({
    sourceFile: ".agents/prompts/supaschema-install.md",
    targetFile: "agent-bundle/agents/prompts/supaschema-install.md",
  }),
  syncImplementation: Object.freeze({
    sourceExtension: ".mts",
    sourceRoot: "scripts/skills",
  }),
});

export function agentSurfaces(): AgentSurface[] {
  return Object.values<AgentSurface>(agentSurfaceManifest);
}

export function isCanonicalAgentSurfaceSource(relativePath: string): boolean {
  for (const surface of agentSurfaces()) {
    if (typeof surface.sourceFile === "string" && relativePath === surface.sourceFile) {
      return true;
    }
    if (typeof surface.sourceRoot !== "string") {
      continue;
    }
    const withinSourceRoot =
      relativePath === surface.sourceRoot || relativePath.startsWith(`${surface.sourceRoot}/`);
    if (!withinSourceRoot) {
      continue;
    }
    if (
      typeof surface.sourceExtension !== "string" ||
      relativePath.endsWith(surface.sourceExtension)
    ) {
      return true;
    }
  }
  return false;
}
