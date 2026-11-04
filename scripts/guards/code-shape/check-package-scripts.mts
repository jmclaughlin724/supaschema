import path from "node:path";
import { forbiddenSurfaceNameTerms } from "./ast-scan.mts";

const forbiddenPackageLifecycleScripts = new Set([
  "install",
  "postinstall",
  "preinstall",
  "prepare",
]);
const codeFileExtensions = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
  ".py",
  ".bash",
  ".sh",
  ".zsh",
]);

export function packageScriptViolations(scripts: Record<string, unknown>): string[] {
  return Object.entries(scripts).flatMap(([name, command]) => {
    if (typeof command !== "string") {
      return [];
    }
    if (forbiddenPackageLifecycleScripts.has(name)) {
      return [
        `package script ${name} is a public install lifecycle script; remove it so consumer package managers do not require build-script approval.`,
      ];
    }
    const shellDeleteViolation = packageScriptShellDeleteViolation(name, command);
    if (shellDeleteViolation !== undefined) {
      return [shellDeleteViolation];
    }
    const commandPath = commandPathFromScript(command);
    if (commandPath === undefined) {
      return [];
    }
    const base = path.basename(commandPath).toLowerCase();
    if (!forbiddenSurfaceNameTerms.some((term) => base.includes(term))) {
      return [];
    }
    return [
      `package script ${name} runs ${commandPath}, which has a forbidden compatibility or parallel-contract module name.`,
    ];
  });
}

function packageScriptShellDeleteViolation(name: string, command: string): string | undefined {
  if (!command.includes("rm")) {
    return;
  }
  const tokens = command.split(" ").filter(Boolean);
  const rmIndex = tokens.findIndex((token) => token === "rm" || token.endsWith("/rm"));
  if (rmIndex === -1) {
    return;
  }
  const flags = tokens
    .slice(rmIndex + 1)
    .filter((token) => token.startsWith("-"))
    .join("");
  return flags.includes("r") && flags.includes("f")
    ? `package script ${name} uses recursive force deletion; delete the script or move cleanup into a guarded owner.`
    : undefined;
}

function commandPathFromScript(command: string): string | undefined {
  const parts = command.split(" ").filter(Boolean);
  return parts.find((part) => codeFileExtensions.has(path.extname(part)));
}
