import path from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateBashPolicy } from "../../.claude/hooks/guards/bash-policy-checks.mts";
import { recordToolEvidence } from "./command-evidence.mts";
import { commentFreeSource } from "./comment-free-source.mts";
import { type HookEntrypointOptions, runHookEntrypoint } from "./hook-entrypoint.mts";
import {
  type HookCheckResult,
  mergeResult,
  runChecks,
  type ShapedHookResult,
  shapeHookResult,
  shapeSessionStateFailure,
} from "./hook-output.mts";
import type { HookPayload, HookRuntime } from "./hook-runtime.mts";
import { verificationClaimConflict } from "./response-claims.mts";
import { finalMessage } from "./response-evidence.mts";
import { beginTurnState, type SessionState, selectTurnState, withSessionState } from "./state.mts";

interface RunnerContext {
  hookPath: string;
  root: string;
  runtime: HookRuntime;
  state: SessionState;
}

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function runAgentHookEvent(eventName: string, options: HookEntrypointOptions = {}): void {
  runHookEntrypoint(eventName, handleAgentHookEvent, { root, ...options });
}

export function handleAgentHookEvent(
  eventName: string,
  payload: HookPayload,
  options: HookEntrypointOptions = {}
): ShapedHookResult {
  const runtime = options.runtime ?? "claude";
  const hookPath = options.hookPath ?? "scripts/agent-hooks/runner.mts";
  const hookRoot = options.root ?? root;
  try {
    const shaped = withSessionState(payload, (state, metadata) => {
      const context: RunnerContext = { hookPath, root: hookRoot, runtime, state };
      let result: HookCheckResult = {};

      if (eventName === "UserPromptSubmit") {
        beginTurnState(payload, state);
      } else if (eventName === "PreToolUse") {
        selectTurnState(payload, state);
        result = runChecks(eventName, payload, [bashSafety, commentFreeSource], context);
      } else if (eventName === "PostToolUse") {
        selectTurnState(payload, state);
        result = runChecks(eventName, payload, [toolEvidence], context);
      } else if (eventName === "PostToolUseFailure") {
        selectTurnState(payload, state);
        result = runChecks(eventName, payload, [toolEvidence], context);
      } else if (eventName === "Stop" || eventName === "SubagentStop") {
        selectTurnState(payload, state);
        result = runChecks(eventName, payload, [verificationConflict], context);
      }

      if (metadata.warning) {
        mergeResult(result, { systemMessage: metadata.warning });
      }
      return {
        state: context.state,
        value: shapeHookResult(eventName, result, runtime),
      };
    });
    if (shaped === undefined) {
      throw new Error(`${eventName} produced no hook result`);
    }
    return shaped;
  } catch (error) {
    return shapeSessionStateFailure(eventName, error, { hookPath, runtime });
  }
}

function bashSafety(payload: HookPayload, context: RunnerContext): HookCheckResult {
  if (payload?.tool_name !== "Bash") {
    return {};
  }
  const result = evaluateBashPolicy(payload, process.env, { root: context.root });
  return result.action === "block" ? { deny: result.message } : {};
}

function toolEvidence(payload: HookPayload, context: RunnerContext): HookCheckResult {
  return recordToolEvidence(payload, context.state, {
    root: context.root,
    runtime: context.runtime,
  });
}

function verificationConflict(payload: HookPayload, context: RunnerContext): HookCheckResult {
  if (payload?.stop_hook_active) {
    return {};
  }
  const conflict = verificationClaimConflict(finalMessage(payload), context.state);
  return conflict ? { block: conflict.message } : {};
}
