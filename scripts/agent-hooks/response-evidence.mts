import { isRecord } from "../lib/json.mts";
import type { HookPayload } from "./hook-runtime.mts";

export function finalMessage(payload: HookPayload): string {
  return typeof payload?.last_assistant_message === "string" ? payload.last_assistant_message : "";
}

export function toolSucceeded(payload: HookPayload): boolean | undefined {
  if (payload?.hook_event_name === "PostToolUseFailure") {
    return false;
  }
  const response = payload?.tool_response;
  if (!isRecord(response)) {
    return;
  }
  for (const field of ["exit_code", "exitCode", "code"]) {
    const value = response[field];
    if (typeof value === "number") {
      return value === 0;
    }
  }
  for (const field of ["is_error", "isError"]) {
    const value = response[field];
    if (typeof value === "boolean") {
      return !value;
    }
  }
  if (typeof response.interrupted === "boolean") {
    return !response.interrupted;
  }
  for (const field of ["success", "ok"]) {
    const value = response[field];
    if (typeof value === "boolean") {
      return value;
    }
  }
  for (const field of ["status", "outcome"]) {
    const outcome = structuredStatus(response[field]);
    if (outcome !== undefined) {
      return outcome;
    }
  }
}

function structuredStatus(value: unknown): boolean | undefined {
  if (typeof value !== "string") {
    return;
  }
  switch (value.toLowerCase()) {
    case "complete":
    case "completed":
    case "ok":
    case "success":
      return true;
    case "canceled":
    case "cancelled":
    case "error":
    case "failed":
    case "failure":
      return false;
    default:
      return;
  }
}
