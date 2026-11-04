import { describe, expect, it } from "vitest";
import {
  computeSnapshotVersion,
  snapshotCommitSha,
} from "../../scripts/release/snapshot-version.mts";

describe("computeSnapshotVersion", () => {
  it("bumps the patch and appends the dev prerelease", () => {
    expect(computeSnapshotVersion("0.5.5", "abc1234")).toBe("0.5.6-dev.abc1234");
    expect(computeSnapshotVersion("1.0.0", "deadbee")).toBe("1.0.1-dev.deadbee");
  });

  it("prefixes all-numeric SHAs so the prerelease identifier stays valid semver", () => {
    expect(computeSnapshotVersion("0.5.5", "0123456")).toBe("0.5.6-dev.g0123456");
    expect(computeSnapshotVersion("0.5.5", "1234567")).toBe("0.5.6-dev.g1234567");
    expect(computeSnapshotVersion("0.5.5", "0abc123")).toBe("0.5.6-dev.0abc123");
  });

  it("rejects non-stable base versions", () => {
    expect(() => computeSnapshotVersion("0.5.6-dev.abc1234", "abc1234")).toThrow(
      "stable X.Y.Z base version"
    );
    expect(() => computeSnapshotVersion("0.5", "abc1234")).toThrow("stable X.Y.Z base version");
  });
});

describe("snapshotCommitSha", () => {
  it("recovers ordinary and semver-safe numeric commit identifiers", () => {
    expect(snapshotCommitSha("0.5.6-dev.abc1234")).toBe("abc1234");
    expect(snapshotCommitSha("0.5.6-dev.g0123456")).toBe("0123456");
    expect(snapshotCommitSha("0.5.6-dev.g1234567")).toBe("1234567");
  });

  it("rejects non-snapshot and invalid identifiers", () => {
    expect(snapshotCommitSha("0.5.6")).toBeNull();
    expect(snapshotCommitSha("0.5.6-dev.gabc123")).toBeNull();
    expect(snapshotCommitSha("0.5.6-dev.xyz1234")).toBeNull();
  });
});
