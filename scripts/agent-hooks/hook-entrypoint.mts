import fs from "node:fs";
import {
  type ShapedHookResult,
  shapeHookResult,
  unexpectedFailureResult,
  writeHookResult,
} from "./hook-output.mts";
import {
  type HookPayload,
  type HookRuntime,
  hookRuntime,
  hookRuntimeDisabled,
} from "./hook-runtime.mts";

export interface HookEntrypointOptions {
  hookPath?: string;
  root?: string;
  runtime?: HookRuntime;
  validatePayload?: (payload: HookPayload, runtime: HookRuntime, eventName: string) => void;
}

export type HookHandler = (
  eventName: string,
  payload: HookPayload,
  options: HookEntrypointOptions
) => ShapedHookResult;

export function runHookEntrypoint(
  eventName: string,
  handler: HookHandler,
  options: HookEntrypointOptions = {}
): never {
  const runtime = options.runtime ?? hookRuntime();
  const hookPath = options.hookPath ?? process.argv[1] ?? "unknown";
  let shaped = disabledHookResult(eventName, runtime);
  if (shaped === undefined) {
    try {
      const payload = readStdinJson();
      options.validatePayload?.(payload, runtime, eventName);
      shaped = handler(eventName, payload, {
        ...options,
        hookPath,
        runtime,
      });
    } catch (error) {
      shaped = shapeHookResult(
        eventName,
        unexpectedFailureResult(eventName, error, "hookInput", {
          hookPath,
          remediation: `Send one valid JSON object on stdin matching the ${eventName} hook schema.`,
          runtime,
        }),
        runtime
      );
    }
  }
  writeHookResult(shaped);
  process.exit(shaped.exitCode);
}

function disabledHookResult(eventName: string, runtime: HookRuntime): ShapedHookResult | undefined {
  return hookRuntimeDisabled(runtime) ? shapeHookResult(eventName, {}, runtime) : undefined;
}

function readStdinJson(): HookPayload {
  const raw = fs.readFileSync(0, "utf8");
  if (raw.trim().length === 0) {
    throw new Error("hook stdin was empty");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `hook stdin is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  if (!isHookPayload(payload)) {
    throw new Error("hook stdin must contain one JSON object");
  }
  return payload;
}

function isHookPayload(value: unknown): value is HookPayload {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
