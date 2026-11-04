import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const proxy = resolve("scripts/cclsp-language-id-proxy.mts");
const echoChild = [process.execPath, "-e", "process.stdin.pipe(process.stdout)"];
const initializeMessageSchema = z.object({
  params: z.object({
    initializationOptions: z.object({
      preferences: z.object({ quotePreference: z.string() }),
      tsserver: z.object({
        logVerbosity: z.string(),
        path: z.string(),
      }),
    }),
  }),
});
const didOpenMessageSchema = z.object({
  params: z.object({
    textDocument: z.object({ languageId: z.string() }),
  }),
});

interface ProxyResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  stdout: Buffer;
  timedOut: boolean;
}

function frame(message: unknown, extraHeader = ""): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const suffix = extraHeader ? `${extraHeader}\r\n` : "";
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n${suffix}\r\n`), body]);
}

function decodeFrame(value: Buffer): unknown {
  const headerEnd = value.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    throw new Error("missing response header");
  }
  return JSON.parse(value.subarray(headerEnd + 4).toString("utf8"));
}

async function runProxy(
  chunks: Buffer[] = [],
  childCommand: string[] = echoChild,
  timeoutMs = 3000
): Promise<ProxyResult> {
  const [command, ...args] = childCommand;
  if (!command) {
    throw new Error("missing child command");
  }
  const child = spawn(process.execPath, [proxy, "--", command, ...args], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  for (const chunk of chunks) {
    child.stdin.write(chunk);
  }
  child.stdin.end();

  return await new Promise((resolveResult) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on("close", (code, signal) => {
      clearTimeout(timeout);
      resolveResult({
        code,
        signal,
        stderr,
        stdout: Buffer.concat(stdout),
        timedOut,
      });
    });
  });
}

describe("cclsp TypeScript language-server proxy", () => {
  it("injects the TypeScript 6 path while preserving initialization options", async () => {
    const input = frame({
      id: 1,
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        initializationOptions: {
          preferences: { quotePreference: "double" },
          tsserver: { logVerbosity: "normal" },
        },
      },
    });
    const result = await runProxy([input.subarray(0, 9), input.subarray(9)]);
    const message = initializeMessageSchema.parse(decodeFrame(result.stdout));

    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false });
    expect(message.params.initializationOptions.preferences.quotePreference).toBe("double");
    expect(message.params.initializationOptions.tsserver.logVerbosity).toBe("normal");
    expect(isAbsolute(message.params.initializationOptions.tsserver.path)).toBe(true);
    expect(message.params.initializationOptions.tsserver.path).toContain(
      join("@typescript", "old", "lib", "tsserver.js")
    );
    expect(existsSync(message.params.initializationOptions.tsserver.path)).toBe(true);
  });

  it.each(["mjs", "cjs"])("normalizes %s didOpen frames", async (extension) => {
    const result = await runProxy([
      frame({
        jsonrpc: "2.0",
        method: "textDocument/didOpen",
        params: {
          textDocument: { languageId: "plaintext", uri: `file:///tmp/example.${extension}` },
        },
      }),
    ]);
    const message = didOpenMessageSchema.parse(decodeFrame(result.stdout));
    expect(message.params.textDocument.languageId).toBe("javascript");
  });

  it("passes ordinary valid frames through byte-for-byte", async () => {
    const input = frame({ id: 2, jsonrpc: "2.0", method: "shutdown" }, "X-Test: retained");
    const result = await runProxy([input]);
    expect(result.stdout.equals(input)).toBe(true);
  });

  it.each([
    Buffer.from("X-Test: missing\r\n\r\n{}"),
    Buffer.from("Content-Length: 1\r\n\r\n{"),
    Buffer.from("Content-Length: 20\r\n\r\n{}"),
  ])("fails closed on malformed input", async (input) => {
    const result = await runProxy([input]);
    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("cclsp-language-id-proxy:");
  });

  it("preserves child exit codes", async () => {
    const result = await runProxy([], [process.execPath, "-e", "process.exit(7)"]);
    expect(result).toMatchObject({ code: 7, signal: null, timedOut: false });
  });

  it.skipIf(process.platform === "win32")("preserves child signals", async () => {
    const result = await runProxy(
      [],
      [process.execPath, "-e", 'process.kill(process.pid, "SIGTERM")']
    );
    expect(result).toMatchObject({ code: null, signal: "SIGTERM", timedOut: false });
  });

  it("fails promptly when the child command is missing", async () => {
    const result = await runProxy([], ["supaschema-definitely-missing-command"]);
    expect(result.timedOut).toBe(false);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("failed to start supaschema-definitely-missing-command");
  });
});
