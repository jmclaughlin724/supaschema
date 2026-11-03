import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyPnpmOverride,
  cloneConfiguration,
  cloneTarget,
  detectPackageManager,
  gateArgv,
  isExactVersionSpec,
  isTarballSpec,
  npmInstallArgs,
  parseCanaryArgs,
  pnpmInstallArgs,
  pnpmOverrideValue,
} from "../../scripts/release/consumer-canary.mts";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("parseCanaryArgs", () => {
  it("applies defaults and collects repeated gates", () => {
    expect(parseCanaryArgs(["--repo", "jmclaughlin724/anilize"])).toEqual({
      gates: ["config validate", "types --check", "check"],
      ref: "main",
      repo: "jmclaughlin724/anilize",
      spec: "next",
    });
    expect(
      parseCanaryArgs([
        "--repo",
        "jmclaughlin724/anilize",
        "--ref",
        "develop",
        "--spec",
        "0.5.6-dev.abc1234",
        "--gate",
        "types --check",
        "--gate",
        "check",
      ])
    ).toEqual({
      gates: ["types --check", "check"],
      ref: "develop",
      repo: "jmclaughlin724/anilize",
      spec: "0.5.6-dev.abc1234",
    });
  });

  it("requires --repo and flag values", () => {
    expect(() => parseCanaryArgs([])).toThrow("--repo is required");
    expect(() => parseCanaryArgs(["--repo"])).toThrow("missing value");
    expect(() => parseCanaryArgs(["--repo", "x", "--nope", "y"])).toThrow("unknown argument");
  });
});

describe("cloneTarget", () => {
  it("enables token authentication only for the exact GitHub HTTPS host", () => {
    expect(cloneTarget("jmclaughlin724/anilize")).toEqual({
      authenticated: true,
      url: "https://github.com/jmclaughlin724/anilize.git",
    });
    expect(cloneTarget("https://github.com/jmclaughlin724/anilize.git")).toEqual({
      authenticated: true,
      url: "https://github.com/jmclaughlin724/anilize.git",
    });
    expect(cloneTarget("https://github.com.evil.example/jmclaughlin724/anilize.git")).toEqual({
      authenticated: false,
      url: "https://github.com.evil.example/jmclaughlin724/anilize.git",
    });
    expect(cloneTarget("https://github.com@evil.example/private.git")).toEqual({
      authenticated: false,
      url: "https://github.com@evil.example/private.git",
    });
    expect(cloneTarget("https://attacker@github.com/acme/private.git")).toEqual({
      authenticated: false,
      url: "https://attacker@github.com/acme/private.git",
    });
    expect(cloneTarget("https://github.com:444/acme/private.git")).toEqual({
      authenticated: false,
      url: "https://github.com:444/acme/private.git",
    });
    expect(cloneTarget("file:///tmp/consumer")).toEqual({
      authenticated: false,
      url: "file:///tmp/consumer",
    });
  });

  it("removes clone credentials entirely for non-GitHub targets", () => {
    const sourceEnv = { CONSUMER_CANARY_TOKEN: "secret-token", PATH: "/usr/bin" };
    const external = cloneConfiguration(
      "https://github.com.evil.example/private.git",
      "secret-token",
      sourceEnv,
      () => "/tmp/should-not-be-created"
    );
    expect(external.env).toEqual({ GIT_TERMINAL_PROMPT: "0", PATH: "/usr/bin" });
    expect(external.env).not.toHaveProperty("CONSUMER_CANARY_TOKEN");
    expect(external.env).not.toHaveProperty("GIT_ASKPASS");

    const github = cloneConfiguration(
      "https://github.com/acme/private.git",
      "secret-token",
      sourceEnv,
      () => "/tmp/test-askpass"
    );
    expect(github.env).toMatchObject({
      CONSUMER_CANARY_TOKEN: "secret-token",
      GIT_ASKPASS: "/tmp/test-askpass",
    });
  });
});

describe("spec classification", () => {
  it("distinguishes tags, exact versions, and tarballs", () => {
    expect(isExactVersionSpec("0.5.6-dev.abc1234")).toBe(true);
    expect(isExactVersionSpec("next")).toBe(false);
    expect(isTarballSpec("/tmp/supaschema-0.5.6-dev.abc1234.tgz")).toBe(true);
    expect(pnpmOverrideValue("0.5.6-dev.abc1234")).toBe("0.5.6-dev.abc1234");
    expect(pnpmOverrideValue("/tmp/pack.tgz")).toBe("file:/tmp/pack.tgz");
    expect(npmInstallArgs("0.5.6-dev.abc1234")).toEqual([
      "install",
      "supaschema@0.5.6-dev.abc1234",
      "--no-save",
      "--no-audit",
      "--no-fund",
    ]);
    expect(npmInstallArgs("/tmp/pack.tgz")[1]).toBe("/tmp/pack.tgz");
  });
});

describe("detectPackageManager", () => {
  it("selects pnpm for workspace consumers and npm for lockfile consumers", async () => {
    const pnpmRoot = await mkdtemp(join(tmpdir(), "supa-canary-pnpm-"));
    tempRoots.push(pnpmRoot);
    await writeFile(join(pnpmRoot, "pnpm-workspace.yaml"), "packages: []\n");
    expect(detectPackageManager(pnpmRoot)).toBe("pnpm");

    const npmRoot = await mkdtemp(join(tmpdir(), "supa-canary-npm-"));
    tempRoots.push(npmRoot);
    await writeFile(join(npmRoot, "package-lock.json"), "{}\n");
    expect(detectPackageManager(npmRoot)).toBe("npm");

    const bareRoot = await mkdtemp(join(tmpdir(), "supa-canary-bare-"));
    tempRoots.push(bareRoot);
    expect(() => detectPackageManager(bareRoot)).toThrow("unsupported package manager");
  });
});

describe("applyPnpmOverride", () => {
  it("merges the supaschema override into an existing overrides block", async () => {
    const root = await mkdtemp(join(tmpdir(), "supa-canary-override-"));
    tempRoots.push(root);
    const workspacePath = join(root, "pnpm-workspace.yaml");
    await writeFile(workspacePath, "packages:\n  - apps/*\noverrides:\n  esbuild: true\n");

    applyPnpmOverride(workspacePath, "0.5.6-dev.abc1234");

    const written = await readFile(workspacePath, "utf8");
    expect(written).toContain("esbuild: true");
    expect(written).toContain("supaschema: 0.5.6-dev.abc1234");
    expect(written).toContain("apps/*");
  });
});

describe("pnpmInstallArgs", () => {
  it("disables frozen lockfiles so the injected override can resolve", () => {
    expect(pnpmInstallArgs()).toEqual(["pnpm", "install", "--no-frozen-lockfile"]);
  });
});

describe("gateArgv", () => {
  it("splits gate strings into argv", () => {
    expect(gateArgv("types --check")).toEqual(["types", "--check"]);
    expect(gateArgv("config validate")).toEqual(["config", "validate"]);
  });
});
