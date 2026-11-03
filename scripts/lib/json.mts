export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordOf(value: unknown): JsonRecord {
  return isRecord(value) ? value : {};
}

export function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function stringsOf(value: unknown): string[] {
  return arrayOf(value).filter((item) => typeof item === "string");
}

export function at(value: unknown, ...keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return;
    }
    current = current[key];
  }
  return current;
}

export function stringAt(value: unknown, ...keys: readonly string[]): string | undefined {
  const found = at(value, ...keys);
  return typeof found === "string" ? found : undefined;
}

export function parseJson(text: string): unknown {
  return JSON.parse(text);
}

export function errorCode(error: unknown): string | undefined {
  return stringAt(error, "code");
}
