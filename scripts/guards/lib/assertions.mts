export function ok(token: string): void {
  process.stdout.write(`${token}\n`);
}

export function fail(message: string): never {
  throw new Error(message);
}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    fail(message);
  }
}
