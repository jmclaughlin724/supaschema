import path from "node:path";

export type HookRuntime = "claude" | "codex";
export type HookPayload = Record<string, unknown>;

export function hookRuntime(hookPath = process.argv[1] ?? "", explicitRuntime = ""): HookRuntime {
  if (typeof process.env.CODEX_THREAD_ID === "string" && process.env.CODEX_THREAD_ID.length > 0) {
    return "codex";
  }
  if (explicitRuntime === "claude" || explicitRuntime === "codex") {
    return explicitRuntime;
  }
  const normalized = String(hookPath).split(path.sep).join("/");
  return normalized.includes("/.codex/hooks/") ? "codex" : "claude";
}

export function hookRuntimeDisabled(runtime: HookRuntime): boolean {
  return runtime === "codex";
}
