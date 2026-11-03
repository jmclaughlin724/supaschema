#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord, type JsonRecord } from "./lib/json.mts";

interface LspFrame {
  body: Buffer;
  raw: Buffer;
}

const rootRequire = createRequire(import.meta.url);

export function resolveTsserverPath(): string {
  const typescriptPackage = rootRequire.resolve("typescript/package.json");
  return createRequire(typescriptPackage).resolve("@typescript/old/lib/tsserver.js");
}

export function runProxy(argv: readonly string[] = process.argv): void {
  const separatorIndex = argv.indexOf("--");
  const commandArgs = separatorIndex === -1 ? argv.slice(2) : argv.slice(separatorIndex + 1);
  const [command, ...args] = commandArgs;
  if (!command) {
    process.stderr.write(
      "usage: node scripts/cclsp-language-id-proxy.mts -- <command> [args...]\n"
    );
    process.exitCode = 1;
    return;
  }

  let tsserverPath: string;
  try {
    tsserverPath = resolveTsserverPath();
  } catch (error) {
    process.stderr.write(
      `cclsp-language-id-proxy: failed to resolve TypeScript 6 tsserver: ${errorMessage(error)}\n`
    );
    process.exitCode = 1;
    return;
  }

  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "inherit"],
  });
  let clientBuffer: Buffer = Buffer.alloc(0);
  let failure = false;
  let finished = false;

  const stopClientInput = () => {
    process.stdin.off("data", onClientData);
    process.stdin.off("end", onClientEnd);
    process.stdin.pause();
  };

  const fail = (error: unknown, terminateChild = true): void => {
    if (!failure) {
      process.stderr.write(`cclsp-language-id-proxy: ${errorMessage(error)}\n`);
    }
    failure = true;
    stopClientInput();
    if (!child.stdin.destroyed) {
      child.stdin.destroy();
    }
    if (terminateChild && child.pid !== undefined) {
      child.kill();
    }
  };

  const flushClientMessages = () => {
    for (;;) {
      const next = takeFrame(clientBuffer);
      if (!next) {
        return;
      }
      clientBuffer = next.rest;
      child.stdin.write(transformFrame(next.frame, tsserverPath));
    }
  };

  function onClientData(chunk: Buffer): void {
    if (failure || finished) {
      return;
    }
    clientBuffer = Buffer.concat([clientBuffer, chunk]);
    try {
      flushClientMessages();
    } catch (error) {
      fail(error);
    }
  }

  function onClientEnd() {
    if (failure || finished) {
      return;
    }
    if (clientBuffer.length > 0) {
      fail(new Error("incomplete LSP frame at end of input"));
      return;
    }
    child.stdin.end();
  }

  child.on("error", (error) => {
    fail(new Error(`failed to start ${command}: ${error.message}`), false);
  });
  child.stdin.on("error", () => undefined);
  child.on("close", (code, signal) => {
    if (finished) {
      return;
    }
    finished = true;
    stopClientInput();
    if (failure) {
      process.exitCode = 1;
      return;
    }
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exitCode = code ?? 1;
  });

  child.stdout.pipe(process.stdout);
  process.stdin.on("data", onClientData);
  process.stdin.on("end", onClientEnd);
}

function takeFrame(buffer: Buffer): { frame: LspFrame; rest: Buffer } | undefined {
  const headerEnd = buffer.indexOf("\r\n\r\n");
  if (headerEnd === -1) {
    return;
  }
  const headers = buffer.subarray(0, headerEnd).toString("ascii").split("\r\n");
  const contentLength = readContentLength(headers);
  const bodyStart = headerEnd + 4;
  const frameEnd = bodyStart + contentLength;
  if (buffer.length < frameEnd) {
    return;
  }
  return {
    frame: {
      body: buffer.subarray(bodyStart, frameEnd),
      raw: buffer.subarray(0, frameEnd),
    },
    rest: buffer.subarray(frameEnd),
  };
}

function readContentLength(headers: readonly string[]): number {
  let contentLength: number | undefined;
  for (const header of headers) {
    const delimiter = header.indexOf(":");
    if (delimiter === -1) {
      continue;
    }
    const name = header.slice(0, delimiter).trim().toLowerCase();
    if (name !== "content-length") {
      continue;
    }
    if (contentLength !== undefined) {
      throw new Error("duplicate Content-Length header");
    }
    const rawValue = header.slice(delimiter + 1).trim();
    if (!isAsciiDigits(rawValue)) {
      throw new Error("invalid Content-Length header");
    }
    contentLength = Number(rawValue);
    if (!Number.isSafeInteger(contentLength)) {
      throw new Error("invalid Content-Length header");
    }
  }
  if (contentLength === undefined) {
    throw new Error("missing Content-Length header");
  }
  return contentLength;
}

function isAsciiDigits(value: string): boolean {
  return value.length > 0 && [...value].every((character) => character >= "0" && character <= "9");
}

function transformFrame(frame: LspFrame, tsserverPath: string): Buffer {
  let message: unknown;
  try {
    message = JSON.parse(frame.body.toString("utf8"));
  } catch (error) {
    throw new Error("invalid JSON payload", { cause: error });
  }

  if (!isRecord(message)) {
    return frame.raw;
  }
  if (message.method === "initialize") {
    return encodeMessage(injectTsserverPath(message, tsserverPath));
  }
  if (message.method !== "textDocument/didOpen") {
    return frame.raw;
  }

  const params = isRecord(message.params) ? message.params : {};
  const textDocument = isRecord(params.textDocument) ? params.textDocument : {};
  const languageId = languageIdForUri(textDocument.uri);
  if (!languageId) {
    return frame.raw;
  }
  return encodeMessage({
    ...message,
    params: {
      ...params,
      textDocument: {
        ...textDocument,
        languageId,
      },
    },
  });
}

function injectTsserverPath(message: JsonRecord, tsserverPath: string): JsonRecord {
  const params = isRecord(message.params) ? message.params : {};
  const initializationOptions = isRecord(params.initializationOptions)
    ? params.initializationOptions
    : {};
  const tsserver = isRecord(initializationOptions.tsserver) ? initializationOptions.tsserver : {};
  return {
    ...message,
    params: {
      ...params,
      initializationOptions: {
        ...initializationOptions,
        tsserver: {
          ...tsserver,
          path: tsserverPath,
        },
      },
    },
  };
}

function encodeMessage(message: JsonRecord): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
}

function languageIdForUri(uri: unknown): string | undefined {
  const extension = extensionForUri(uri);
  return extension === "mjs" || extension === "cjs" ? "javascript" : undefined;
}

function extensionForUri(uri: unknown): string {
  if (typeof uri !== "string") {
    return "";
  }
  if (uri.startsWith("file:")) {
    try {
      return extname(fileURLToPath(uri)).slice(1).toLowerCase();
    } catch {
      return extname(uri).slice(1).toLowerCase();
    }
  }
  return extname(uri).slice(1).toLowerCase();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runProxy();
}
