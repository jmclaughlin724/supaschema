import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { HookPayload } from "./hook-runtime.mts";

export interface EvidenceEntry {
  at: string;
  domain: string;
  outcome: "failure" | "success";
}

export interface TurnState {
  createdAt: string;
  evidence: EvidenceEntry[];
}

export interface SessionState {
  createdAt: string;
  currentTurnId: string;
  sessionId: string;
  turnSequence: number;
  turns: Record<string, TurnState>;
  updatedAt: string;
}

export interface SessionStateMetadata {
  warning?: string;
}

export interface SessionStateUpdate<Value> {
  state?: SessionState;
  value?: Value;
}

interface PersistedState extends Record<string, unknown> {
  createdAt: string;
  sessionId: string;
  turns: Record<string, unknown>;
  updatedAt: string;
}

interface StateRecord {
  found: boolean;
  needsRepair: boolean;
  state: SessionState;
  warning?: string;
}

interface LockLease {
  assertOwned: () => void;
  release: () => void;
}

interface LockOwner {
  pid: number;
}

const fallbackTurnId = "turn-0";
const lockInitializationGraceMs = 1000;
const lockPollMs = 20;
const lockTimeoutMs = 8000;
const sessionEndLockTimeoutMs = 500;
const stateTtlMs = 24 * 60 * 60 * 1000;
const maxTurns = 20;
const maxEvidenceEntries = 50;
const directoryMode = 0o700;
const fileMode = 0o600;

function stateDir(): string {
  const configured = process.env.STATE_DIR;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new Error("persistent hook state is not configured");
  }
  return path.resolve(configured);
}

function statePersistenceEnabled(): boolean {
  return typeof process.env.STATE_DIR === "string" && process.env.STATE_DIR.length > 0;
}

export function sessionStatePath(payload: HookPayload): string {
  const id = sessionId(payload);
  return path.join(stateDir(), `${Buffer.from(id).toString("base64url")}.json`);
}

function validateSessionId(id: string): string {
  if (id.length === 0 || id.length > 200) {
    throw new Error("invalid session id length");
  }
  for (const char of id) {
    if (char === "/" || char === "\\" || char === "\0") {
      throw new Error("invalid session id path character");
    }
  }
  if (id.includes("..")) {
    throw new Error("invalid session id traversal token");
  }
  return id;
}

export function readSessionState(payload: HookPayload): SessionState {
  if (!statePersistenceEnabled()) {
    return emptyState(sessionId(payload));
  }
  return readStateRecord(payload).state;
}

export function inspectSessionState(payload: HookPayload): {
  found: boolean;
  state: SessionState;
  warning?: string;
} {
  if (!statePersistenceEnabled()) {
    return { found: false, state: emptyState(sessionId(payload)) };
  }
  const record = readStateRecord(payload, { repairFileMode: false });
  return {
    found: record.found,
    state: record.state,
    ...(record.warning ? { warning: record.warning } : {}),
  };
}

export function withSessionState<Value>(
  payload: HookPayload,
  callback: (
    state: SessionState,
    metadata: SessionStateMetadata
  ) => SessionStateUpdate<Value> | undefined
): Value | undefined {
  if (!statePersistenceEnabled()) {
    const result = callback(emptyState(sessionId(payload)), {});
    return result?.value;
  }
  return withSessionLock(payload, (lock) => {
    const record = readStateRecord(payload);
    const before = JSON.stringify(record.state);
    const result = callback(record.state, { warning: record.warning });
    const next = normalizeState(result?.state ?? record.state, sessionId(payload));
    const changed = before !== JSON.stringify(next);
    if (changed || record.needsRepair) {
      next.updatedAt = now();
      writeStateFile(sessionStatePath(payload), next, lock.assertOwned);
    }
    return result?.value;
  });
}

export function refreshSessionState(payload: HookPayload): void {
  if (!statePersistenceEnabled()) {
    return;
  }
  discardSupersededLockOwners(payload);
  withSessionLock(payload, (lock) => {
    const state = emptyState(sessionId(payload));
    state.updatedAt = now();
    writeStateFile(sessionStatePath(payload), state, lock.assertOwned);
  });
}

export function clearSessionState(payload: HookPayload): void {
  if (!statePersistenceEnabled()) {
    return;
  }
  withSessionLock(
    payload,
    (lock) => {
      lock.assertOwned();
      unlinkIfPresent(sessionStatePath(payload));
    },
    sessionEndLockTimeoutMs
  );
}

export function beginTurnState(payload: HookPayload, state: SessionState): TurnState {
  const id = turnId(payload) ?? `prompt-${state.turnSequence + 1}`;
  if (!turnId(payload)) {
    state.turnSequence += 1;
  }
  state.currentTurnId = validateStateKey(id);
  state.turns[state.currentTurnId] = emptyTurn();
  pruneTurns(state);
  return currentTurnState(state);
}

export function selectTurnState(payload: HookPayload, state: SessionState): TurnState {
  const id = turnId(payload);
  if (id) {
    state.currentTurnId = validateStateKey(id);
  }
  if (!state.currentTurnId) {
    state.currentTurnId = fallbackTurnId;
  }
  return currentTurnState(state);
}

export function currentTurnState(state: SessionState): TurnState {
  if (!isRecord(state.turns)) {
    state.turns = {};
  }
  const id = state.currentTurnId || fallbackTurnId;
  state.currentTurnId = id;
  state.turns[id] ??= emptyTurn();
  return state.turns[id];
}

export function normalizeState(value: unknown, expectedSessionId = "default"): SessionState {
  const session = validateSessionId(expectedSessionId);
  const source = isRecord(value) ? value : {};
  const turns = normalizeTurns(source.turns);
  const currentTurnId =
    typeof source.currentTurnId === "string" && source.currentTurnId.length > 0
      ? validateStateKey(source.currentTurnId)
      : fallbackTurnId;
  turns[currentTurnId] ??= emptyTurn();
  const boundedTurns = Object.fromEntries(Object.entries(turns).slice(-maxTurns));
  if (!boundedTurns[currentTurnId]) {
    delete boundedTurns[Object.keys(boundedTurns)[0]];
    boundedTurns[currentTurnId] = turns[currentTurnId];
  }
  trimEvidence(boundedTurns);
  return {
    createdAt: timestamp(source.createdAt) ?? now(),
    currentTurnId,
    sessionId: session,
    turnSequence: nonNegativeInteger(source.turnSequence),
    turns: boundedTurns,
    updatedAt: timestamp(source.updatedAt) ?? now(),
  };
}

export function addEvidence(
  state: SessionState,
  evidence: { domain: string; outcome: string }
): void {
  const domain = identifier(evidence?.domain);
  const outcome = evidence?.outcome === "success" ? "success" : "failure";
  if (!domain) {
    return;
  }
  const turn = currentTurnState(state);
  turn.evidence.push({ at: now(), domain, outcome });
  trimEvidence(state.turns);
}

function readStateRecord(
  payload: HookPayload,
  { repairFileMode = true }: { repairFileMode?: boolean } = {}
): StateRecord {
  const file = sessionStatePath(payload);
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return { found: false, needsRepair: false, state: emptyState(sessionId(payload)) };
    }
    return malformedState(payload, file, "read failure");
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    assertPersistedState(parsed, sessionId(payload));
    if (Date.now() - Date.parse(parsed.updatedAt) > stateTtlMs) {
      return { found: true, needsRepair: true, state: emptyState(sessionId(payload)) };
    }
    if (repairFileMode) {
      fs.chmodSync(file, fileMode);
    }
    return {
      found: true,
      needsRepair: false,
      state: normalizeState(parsed, sessionId(payload)),
    };
  } catch (error) {
    return malformedState(
      payload,
      file,
      error instanceof SyntaxError ? "invalid JSON" : "invalid schema"
    );
  }
}

function malformedState(payload: HookPayload, file: string, category: string): StateRecord {
  return {
    found: true,
    needsRepair: true,
    state: emptyState(sessionId(payload)),
    warning: `Hook state warning: ignored ${category} in ${path.basename(file)} and continued with empty state.`,
  };
}

function assertPersistedState(
  value: unknown,
  expectedSessionId: string
): asserts value is PersistedState {
  if (!isRecord(value)) {
    throw new Error("state must be an object");
  }
  if (value.sessionId !== expectedSessionId) {
    throw new Error("state session id mismatch");
  }
  if (!(timestamp(value.createdAt) && timestamp(value.updatedAt))) {
    throw new Error("state timestamps are invalid");
  }
  if (!isRecord(value.turns)) {
    throw new Error("state collections are invalid");
  }
}

function emptyState(id: string): SessionState {
  const time = now();
  return {
    createdAt: time,
    currentTurnId: fallbackTurnId,
    sessionId: id,
    turnSequence: 0,
    turns: { [fallbackTurnId]: emptyTurn(time) },
    updatedAt: time,
  };
}

function emptyTurn(at = now()): TurnState {
  return { createdAt: at, evidence: [] };
}

function normalizeTurns(value: unknown): Record<string, TurnState> {
  if (!isRecord(value)) {
    return {};
  }
  const entries = Object.entries(value).slice(-maxTurns);
  const turns: Record<string, TurnState> = {};
  for (const [rawId, rawTurn] of entries) {
    const id = validateStateKey(rawId);
    const turn = isRecord(rawTurn) ? rawTurn : {};
    turns[id] = {
      createdAt: timestamp(turn.createdAt) ?? now(),
      evidence: normalizeEvidence(turn.evidence),
    };
  }
  return turns;
}

function normalizeEvidence(value: unknown): EvidenceEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.slice(-maxEvidenceEntries).flatMap((item: unknown): EvidenceEntry[] => {
    const entry = isRecord(item) ? item : {};
    const at = timestamp(entry.at);
    const domain = identifier(entry.domain);
    const outcome = entry.outcome === "success" || entry.outcome === "failure" ? entry.outcome : "";
    return at && domain && outcome ? [{ at, domain, outcome }] : [];
  });
}

function trimEvidence(turns: Record<string, TurnState>): void {
  let remaining = maxEvidenceEntries;
  const entries = Object.entries(turns);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const turn = entries[index][1];
    const evidence = Array.isArray(turn.evidence) ? turn.evidence : [];
    turn.evidence = evidence.slice(-remaining);
    remaining -= turn.evidence.length;
    if (remaining === 0) {
      for (let earlier = 0; earlier < index; earlier += 1) {
        entries[earlier][1].evidence = [];
      }
      break;
    }
  }
}

function pruneTurns(state: SessionState): void {
  const entries = Object.entries(state.turns);
  if (entries.length <= maxTurns) {
    return;
  }
  state.turns = Object.fromEntries(entries.slice(-maxTurns));
}

function writeStateFile(file: string, state: SessionState, assertOwned: () => void): void {
  ensurePrivateDirectory(path.dirname(file));
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    writePrivateFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
    assertOwned();
    fs.renameSync(temporary, file);
    fs.chmodSync(file, fileMode);
  } finally {
    unlinkIfPresent(temporary);
  }
}

function withSessionLock<Result>(
  payload: HookPayload,
  callback: (lock: LockLease) => Result,
  timeoutMs = lockTimeoutMs
): Result {
  const lock = acquireSessionLock(payload, timeoutMs);
  try {
    return callback(lock);
  } finally {
    lock.release();
  }
}

function acquireSessionLock(payload: HookPayload, timeoutMs: number): LockLease {
  const lockPath = `${sessionStatePath(payload)}.lock`;
  ensurePrivateDirectory(path.dirname(lockPath));
  const startedAt = process.hrtime.bigint();
  const token = randomUUID();
  const ownerName = `owner-${token}.json`;
  const ownerPath = path.join(lockPath, ownerName);
  const metadata = { acquiredAt: now(), pid: process.pid, token };

  while (true) {
    try {
      fs.mkdirSync(lockPath, { mode: directoryMode });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") {
        throw error;
      }
      reclaimDeadLockOwners(lockPath);
      if (lockWaitExpired(startedAt, timeoutMs)) {
        throw new Error(`timed out waiting for session state lock: ${path.basename(lockPath)}`, {
          cause: error,
        });
      }
      sleep(lockPollMs);
      continue;
    }

    try {
      fs.chmodSync(lockPath, directoryMode);
      writePrivateFile(ownerPath, `${JSON.stringify(metadata)}\n`);
      return lockLease(lockPath, ownerPath);
    } catch (error) {
      unlinkIfPresent(ownerPath);
      removeDirectoryIfEmpty(lockPath);
      if (isRetryableLockInitializationError(error) && !lockWaitExpired(startedAt, timeoutMs)) {
        sleep(lockPollMs);
        continue;
      }
      throw error;
    }
  }
}

const retryableLockInitializationCodes = new Set(["EACCES", "EBUSY", "EINVAL", "ENOENT", "EPERM"]);

function isRetryableLockInitializationError(error: unknown): boolean {
  const code = errorCode(error);
  return code !== undefined && retryableLockInitializationCodes.has(code);
}

function lockWaitExpired(startedAt: bigint, timeoutMs: number): boolean {
  return Number(process.hrtime.bigint() - startedAt) / 1_000_000 >= timeoutMs;
}

function writePrivateFile(file: string, contents: string): void {
  const descriptor = fs.openSync(file, "wx", fileMode);
  try {
    fs.writeFileSync(descriptor, contents, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function lockLease(lockPath: string, ownerPath: string): LockLease {
  return {
    assertOwned: () => {
      if (!lockHasOnlyOwner(lockPath, ownerPath)) {
        throw new Error(`lost session state lock ownership: ${path.basename(lockPath)}`);
      }
    },
    release: () => {
      unlinkIfPresent(ownerPath);
      removeDirectoryIfEmpty(lockPath);
    },
  };
}

function lockHasOnlyOwner(lockPath: string, ownerPath: string): boolean {
  try {
    const entries = fs.readdirSync(lockPath);
    if (!(entries.length === 1 && entries[0] === path.basename(ownerPath))) {
      return false;
    }
    return readLockOwner(ownerPath, entries[0])?.pid === process.pid;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function reclaimDeadLockOwners(lockPath: string): void {
  let entries: fs.Dirent[];
  try {
    const lockStat = fs.lstatSync(lockPath);
    if (!lockStat.isDirectory()) {
      throw new Error(`invalid session state lock: ${path.basename(lockPath)} is not a directory`);
    }
    entries = fs.readdirSync(lockPath, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return;
    }
    throw error;
  }
  if (entries.length === 0) {
    if (!lockArtifactIsRecent(lockPath)) {
      removeDirectoryIfEmpty(lockPath);
    }
    return;
  }
  for (const entry of entries) {
    const ownerPath = path.join(lockPath, entry.name);
    const owner = entry.isFile() ? readLockOwner(ownerPath, entry.name) : undefined;
    if (owner === null) {
      continue;
    }
    if (!owner) {
      if (lockArtifactIsRecent(ownerPath) || lockArtifactIsRecent(lockPath)) {
        return;
      }
      throw new Error(`invalid session state lock owner: ${entry.name}`);
    }
    if (!processIsLive(owner.pid)) {
      unlinkOwnerReclaimedConcurrently(ownerPath);
    }
  }
  removeDirectoryIfEmpty(lockPath);
}

function lockArtifactIsRecent(file: string): boolean {
  try {
    return Date.now() - fs.statSync(file).mtimeMs < lockInitializationGraceMs;
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return true;
    }
    throw error;
  }
}

function discardSupersededLockOwners(payload: HookPayload): void {
  const lockPath = `${sessionStatePath(payload)}.lock`;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(lockPath, { withFileTypes: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
      return;
    }
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    const ownerPath = path.join(lockPath, entry.name);
    if (readLockOwner(ownerPath, entry.name)) {
      unlinkOwnerReclaimedConcurrently(ownerPath);
    }
  }
  removeDirectoryIfEmpty(lockPath);
}

function readLockOwner(ownerPath: string, ownerName: string): LockOwner | null | undefined {
  if (!(ownerName.startsWith("owner-") && ownerName.endsWith(".json"))) {
    return;
  }
  try {
    const value: unknown = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    const expectedToken = ownerName.slice("owner-".length, -".json".length);
    if (!isRecord(value)) {
      return;
    }
    const fields = Object.keys(value).sort();
    const pid = value.pid;
    if (
      fields.join(",") !== "acquiredAt,pid,token" ||
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      value.token !== expectedToken ||
      timestamp(value.acquiredAt) === undefined
    ) {
      return;
    }
    return { pid };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return null;
    }
    if (error instanceof SyntaxError) {
      return;
    }
    throw error;
  }
}

function processIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function ensurePrivateDirectory(directory: string): void {
  fs.mkdirSync(directory, { mode: directoryMode, recursive: true });
  fs.chmodSync(directory, directoryMode);
}

const concurrentlyHeldDirectoryCodes = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "ENOENT",
  "ENOTEMPTY",
  "EPERM",
]);

function removeDirectoryIfEmpty(lockPath: string): void {
  try {
    fs.rmdirSync(lockPath);
  } catch (error) {
    const code = errorCode(error);
    if (!(code !== undefined && concurrentlyHeldDirectoryCodes.has(code))) {
      throw error;
    }
  }
}

const concurrentlyHeldFileCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
const concurrentlyHeldFileRetryLimit = 5;

function unlinkIfPresent(file: string): boolean {
  for (let remainingRetries = concurrentlyHeldFileRetryLimit; ; remainingRetries -= 1) {
    try {
      fs.unlinkSync(file);
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") {
        return false;
      }
      if (!(code !== undefined && concurrentlyHeldFileCodes.has(code) && remainingRetries > 0)) {
        throw error;
      }
      sleep(lockPollMs);
    }
  }
}

function unlinkOwnerReclaimedConcurrently(ownerPath: string): boolean {
  try {
    return unlinkIfPresent(ownerPath);
  } catch (error) {
    const code = errorCode(error);
    if (!(code !== undefined && concurrentlyHeldFileCodes.has(code))) {
      throw error;
    }
    return false;
  }
}

function sessionId(payload: HookPayload | undefined): string {
  const raw =
    payload?.session_id ??
    process.env.CLAUDE_SESSION_ID ??
    process.env.CODEX_SESSION_ID ??
    "default";
  return validateSessionId(String(raw || "default"));
}

function turnId(payload: HookPayload | undefined): string | undefined {
  return typeof payload?.turn_id === "string" && payload.turn_id.length > 0
    ? payload.turn_id
    : undefined;
}

function validateStateKey(id: string): string {
  return validateSessionId(id);
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 160) {
    return "";
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    const digit = code >= 48 && code <= 57;
    if (!(letter || digit || "_.:+-".includes(character))) {
      return "";
    }
  }
  return value;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    return;
  }
  return new Date(value).toISOString();
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function now(): string {
  return new Date().toISOString();
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}
