import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { pathContainsOrEqual, pathsOverlap } from "../../src/paths.js";

const segmentHead = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz");
const segmentTail = fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789-");
const segment = fc
  .tuple(segmentHead, fc.array(segmentTail, { maxLength: 8 }))
  .map(([head, rest]) => `${head}${rest.join("")}`);
const relPath = fc.array(segment, { maxLength: 3 }).map((parts) => parts.join("/"));

describe("path overlap primitives", () => {
  it.each([
    ["identical", "db/schemas", "db/schemas"],
    ["trailing-slash child", "db/schemas", "db/schemas/"],
    ["trailing-slash parent", "db/schemas/", "db/schemas"],
    ["dot-prefix child", "db/schemas", "./db/schemas"],
    ["dot-prefix parent", "./db/schemas", "db/schemas"],
    ["nested child", "db/schemas", "db/schemas/migrations"],
    ["nested parent", "db", "db/schemas"],
  ])("pathsOverlap detects overlap: %s", (_name, a, b) => {
    expect(pathsOverlap(a, b)).toBe(true);
  });

  it.each([
    ["distinct siblings", "db/schemas", "db/migrations"],
    ["unrelated", "db/a", "other/b"],
  ])("pathsOverlap rejects disjoint paths: %s", (_name, a, b) => {
    expect(pathsOverlap(a, b)).toBe(false);
  });

  it("pathContainsOrEqual is strict about direction (parent vs child)", () => {
    expect(pathContainsOrEqual("db/schemas", "db/schemas/migrations")).toBe(true);
    expect(pathContainsOrEqual("db/schemas/migrations", "db/schemas")).toBe(false);
    expect(pathContainsOrEqual("db/schemas", "db/schemas")).toBe(true);
  });

  it.skipIf(process.platform === "win32")(
    "matches missing children below symlinked existing parents",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "supa-paths-"));
      const realRoot = join(directory, "real");
      const linkRoot = join(directory, "link");
      await mkdir(join(realRoot, "schemas"), { recursive: true });
      await symlink(realRoot, linkRoot);

      expect(
        pathContainsOrEqual(join(linkRoot, "schemas"), join(linkRoot, "schemas", "missing.sql"))
      ).toBe(true);
    }
  );

  it("pathsOverlap is symmetric for arbitrary path pairs", () => {
    fc.assert(
      fc.property(relPath, relPath, (a, b) => {
        expect(pathsOverlap(a, b)).toBe(pathsOverlap(b, a));
      })
    );
  });

  it("pathsOverlap is invariant under trailing-separator and dot-prefix normalization", () => {
    fc.assert(
      fc.property(relPath, relPath, (a, b) => {
        const base = pathsOverlap(a, b);
        expect([
          pathsOverlap(`${a}/`, b),
          pathsOverlap(a, `${b}/`),
          pathsOverlap(`./${a}`, b),
        ]).toEqual([base, base, base]);
      })
    );
  });
});
