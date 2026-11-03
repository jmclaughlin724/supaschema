import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DocsViolation } from "./check-standard.mts";

const LOCAL_RUNNER_CONVENTION_SURFACES = [
  ".agents/prompts/supaschema-install.md",
  ".claude/skills/supaschema/SKILL.md",
  ".claude/rules/supaschema.md",
  "AGENTS.md",
  "README.md",
  "bin/scaffold.mjs",
  "docs/coding-agents/agent-bundle.mdx",
  "docs/coding-agents/index.mdx",
  "docs/installation.mdx",
  "docs/quickstart.mdx",
  "docs/reference/package-boundary.mdx",
  "docs/setup.mdx",
];
const INSTALL_PROMPT_REQUIRED_LOCAL_RUNNER_TEXT = [
  "packageManager",
  "devEngines.packageManager",
  "pnpm add supaschema",
  "| pnpm | `pnpm add supaschema`",
  "yarn add supaschema",
  "bun add supaschema",
  "npm exec -- supaschema init",
  "npm exec -- supaschema <cmd>",
  "pnpm exec supaschema <cmd>",
  "yarn exec supaschema <cmd>",
  "./node_modules/.bin/supaschema <cmd>",
  "pnpm exec supaschema init",
  "yarn exec supaschema init",
  "./node_modules/.bin/supaschema init",
  "Do not run npm in a pnpm, Yarn, or Bun project",
  "cd` into the owning member package",
];
const LOCAL_RUNNER_FORBIDDEN_TEXT = [
  {
    msg: "must not present npm install as universal install guidance",
    text: "Run `npm install supaschema`",
  },
  {
    msg: "must not present npx supaschema as universal schema workflow guidance",
    text: "npx supaschema diff",
  },
  {
    msg: "must not present npx supaschema as universal schema workflow guidance",
    text: "npx supaschema check",
  },
  {
    msg: "must not recommend workspace/filter install flags for first install",
    text: "--workspace <name-or-path>",
  },
  {
    msg: "must not recommend workspace/filter install flags for first install",
    text: "--filter <pkg> add",
  },
];

export function inspectLocalRunnerConvention(rootDir: string, violations: DocsViolation[]) {
  const surfaces = new Map<string, string>();
  for (const file of LOCAL_RUNNER_CONVENTION_SURFACES) {
    const text = readRequiredSurface(rootDir, file, violations);
    if (text !== undefined) {
      surfaces.set(file, text);
    }
  }

  const installPrompt = surfaces.get(".agents/prompts/supaschema-install.md") ?? "";
  for (const required of INSTALL_PROMPT_REQUIRED_LOCAL_RUNNER_TEXT) {
    if (!installPrompt.includes(required)) {
      violations.push({
        file: ".agents/prompts/supaschema-install.md",
        line: 1,
        msg: `must document ${required}`,
        rule: "local-runner",
      });
    }
  }

  for (const [surface, text] of surfaces) {
    for (const forbidden of LOCAL_RUNNER_FORBIDDEN_TEXT) {
      if (text.includes(forbidden.text)) {
        violations.push({
          file: surface,
          line: lineNumberForText(text, forbidden.text),
          msg: `${forbidden.msg} (${forbidden.text})`,
          rule: "local-runner",
        });
      }
    }
  }
}

function readRequiredSurface(rootDir: string, file: string, violations: DocsViolation[]) {
  try {
    return readFileSync(join(rootDir, file), "utf8");
  } catch (error) {
    violations.push({
      file,
      line: 1,
      msg: `required local-runner convention surface is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      rule: "local-runner",
    });
  }
}

function lineNumberForText(text: string, needle: string) {
  const index = text.indexOf(needle);
  if (index === -1) {
    return 1;
  }
  return text.slice(0, index).split("\n").length;
}
