import { type HookEntrypointOptions, runHookEntrypoint } from "./hook-entrypoint.mts";
import {
  type ShapedHookResult,
  shapeHookResult,
  shapeSessionStateFailure,
} from "./hook-output.mts";
import type { HookPayload, HookRuntime } from "./hook-runtime.mts";
import { clearSessionState, refreshSessionState } from "./state.mts";

interface SessionStartContract {
  modelRequired: boolean;
  permissionModeRequired: boolean;
  permissionModes: Set<string>;
  sources: Set<string>;
}

const sessionStartContracts: Record<HookRuntime, SessionStartContract> = {
  claude: {
    modelRequired: false,
    permissionModeRequired: false,
    permissionModes: new Set([
      "default",
      "acceptEdits",
      "plan",
      "dontAsk",
      "bypassPermissions",
      "auto",
    ]),
    sources: new Set(["startup", "resume", "clear", "compact", "fork"]),
  },
  codex: {
    modelRequired: true,
    permissionModeRequired: true,
    permissionModes: new Set(["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"]),
    sources: new Set(["startup", "resume", "clear", "compact"]),
  },
};

export function runSessionLifecycleEvent(
  eventName: string,
  options: HookEntrypointOptions = {}
): void {
  runHookEntrypoint(eventName, handleSessionLifecycleEvent, {
    ...options,
    validatePayload: validateLifecyclePayload,
  });
}

export function handleSessionLifecycleEvent(
  eventName: string,
  payload: HookPayload,
  options: HookEntrypointOptions = {}
): ShapedHookResult {
  const runtime = options.runtime ?? "claude";
  const hookPath = options.hookPath ?? "scripts/agent-hooks/session-lifecycle.mts";
  try {
    if (eventName === "SessionStart") {
      refreshSessionState(payload);
    } else if (eventName === "SessionEnd") {
      clearSessionState(payload);
    } else {
      throw new Error(`unsupported session lifecycle event: ${eventName}`);
    }
    return shapeHookResult(eventName, {}, runtime);
  } catch (error) {
    return shapeSessionStateFailure(eventName, error, { hookPath, runtime });
  }
}

function validateLifecyclePayload(
  payload: HookPayload,
  runtime: HookRuntime,
  eventName: string
): void {
  requireNonEmptyString(payload, "session_id");
  requireNullableString(payload, "transcript_path");
  requireNonEmptyString(payload, "cwd");
  if (payload.hook_event_name !== eventName) {
    throw new Error(`hook input field "hook_event_name" must equal "${eventName}"`);
  }
  if (eventName !== "SessionStart") {
    return;
  }
  const contract = sessionStartContracts[runtime] ?? sessionStartContracts.codex;
  if (contract.modelRequired) {
    requireNonEmptyString(payload, "model");
  }
  requireEnum(
    payload,
    "permission_mode",
    contract.permissionModes,
    contract.permissionModeRequired
  );
  requireEnum(payload, "source", contract.sources, true);
}

function requireEnum(
  payload: HookPayload,
  field: string,
  allowed: Set<string>,
  required: boolean
): void {
  const value = payload[field];
  if (!required && value === undefined) {
    return;
  }
  if (!(typeof value === "string" && allowed.has(value))) {
    throw new Error(`hook input field "${field}" has an unsupported value`);
  }
}

function requireNonEmptyString(payload: HookPayload, field: string): void {
  const value = payload[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`hook input field "${field}" must be a non-empty string`);
  }
}

function requireNullableString(payload: HookPayload, field: string): void {
  if (payload[field] !== null && typeof payload[field] !== "string") {
    throw new Error(`hook input field "${field}" must be a string or null`);
  }
}
