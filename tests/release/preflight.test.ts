import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const script = resolve(import.meta.dirname, "../..", "scripts/release/preflight.mts");
const notesScript = resolve(import.meta.dirname, "../..", "scripts/release/changelog-notes.mts");
const tempDirs: string[] = [];
const releaseCommit = "0123456789abcdef0123456789abcdef01234567";

function makeProject(options: {
  changelogText?: string;
  packageVersion?: string;
  lockVersion?: string;
  rootVersion?: string;
}) {
  const dir = mkdtempSync(join(tmpdir(), "supaschema-release-preflight-"));
  tempDirs.push(dir);

  const packageVersion = options.packageVersion ?? "1.2.3";
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify(
      {
        name: "supaschema",
        repository: { type: "git", url: "git+https://github.com/jmclaughlin724/supaschema.git" },
        version: packageVersion,
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(dir, "package-lock.json"),
    `${JSON.stringify(
      {
        lockfileVersion: 3,
        name: "supaschema",
        packages: { "": { name: "supaschema", version: options.rootVersion ?? packageVersion } },
        version: options.lockVersion ?? packageVersion,
      },
      null,
      2
    )}\n`
  );
  writeFileSync(
    join(dir, "CHANGELOG.md"),
    options.changelogText ??
      `# Changelog

## ${packageVersion} (2026-06-16)

- Release note for ${packageVersion}.

## 1.2.2 (2026-06-15)

- Previous release note.
`
  );

  return dir;
}

function runPreflight(
  cwd: string,
  options: {
    githubEnv?: string;
    githubEventName?: string;
    githubOutput?: string;
    githubPackageVersions?: string[];
    githubRef?: string;
    githubReleaseExists?: boolean;
    githubSha?: string;
    githubTagTarget?: string;
    publishedVersions?: string[];
  } = {}
) {
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GITHUB_ENV: options.githubEnv,
      GITHUB_EVENT_NAME: options.githubEventName,
      GITHUB_OUTPUT: options.githubOutput,
      GITHUB_REF: options.githubRef,
      GITHUB_REPOSITORY: "jmclaughlin724/supaschema",
      GITHUB_SHA: options.githubSha ?? releaseCommit,
      SUPASCHEMA_RELEASE_GITHUB_PACKAGE_VIEW_JSON: JSON.stringify(
        options.githubPackageVersions ?? []
      ),
      SUPASCHEMA_RELEASE_GITHUB_RELEASE_EXISTS: String(options.githubReleaseExists ?? false),
      SUPASCHEMA_RELEASE_GITHUB_TAG_TARGET: options.githubTagTarget ?? "",
      SUPASCHEMA_RELEASE_NPM_VIEW_JSON: JSON.stringify(options.publishedVersions ?? []),
    },
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { force: true, recursive: true });
  }
});

describe("release preflight", () => {
  it("accepts a matching package version that is not released", () => {
    const cwd = makeProject({});

    const result = runPreflight(cwd, { publishedVersions: ["1.2.2"] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "RELEASE_PREFLIGHT_OK supaschema@1.2.3 will publish to npm; @jmclaughlin724/supaschema@1.2.3 will publish to GitHub Packages; v1.2.3 will be created"
    );
  });

  it("writes GitHub Actions release-state flags", () => {
    const cwd = makeProject({});
    const githubEnv = join(cwd, "github-env");
    const githubOutput = join(cwd, "github-output");

    const result = runPreflight(cwd, {
      githubEnv,
      githubOutput,
      publishedVersions: ["1.2.2"],
    });

    expect(result.status).toBe(0);
    for (const file of [githubEnv, githubOutput]) {
      const contents = readFileSync(file, "utf8");
      expect(contents).toContain("SUPASCHEMA_PACKAGE_NAME=supaschema");
      expect(contents).toContain("SUPASCHEMA_PACKAGE_VERSION=1.2.3");
      expect(contents).toContain(
        "SUPASCHEMA_RELEASE_GITHUB_PACKAGE_NAME=@jmclaughlin724/supaschema"
      );
      expect(contents).toContain("SUPASCHEMA_RELEASE_GITHUB_PACKAGE_PUBLISHED=false");
      expect(contents).toContain("SUPASCHEMA_RELEASE_TAG=v1.2.3");
      expect(contents).toContain("SUPASCHEMA_RELEASE_SHOULD_PUBLISH_GITHUB_PACKAGE=true");
      expect(contents).toContain("SUPASCHEMA_RELEASE_SHOULD_PUBLISH_NPM=true");
      expect(contents).toContain("SUPASCHEMA_RELEASE_SHOULD_CREATE_GITHUB_RELEASE=true");
    }
  });

  it("repairs a missing GitHub release after npm publish", () => {
    const cwd = makeProject({});

    const result = runPreflight(cwd, { publishedVersions: ["1.2.2", "1.2.3"] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "RELEASE_PREFLIGHT_OK supaschema@1.2.3 is on npm; v1.2.3 and @jmclaughlin724/supaschema@1.2.3 will be created"
    );
  });

  it("publishes a missing GitHub Packages mirror after npm and GitHub release exist", () => {
    const cwd = makeProject({});

    const result = runPreflight(cwd, {
      githubReleaseExists: true,
      publishedVersions: ["1.2.2", "1.2.3"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "RELEASE_PREFLIGHT_OK supaschema@1.2.3 and v1.2.3 are released; @jmclaughlin724/supaschema@1.2.3 will publish to GitHub Packages"
    );
  });

  it("accepts an already complete npm, GitHub release, and GitHub Packages mirror", () => {
    const cwd = makeProject({});

    const result = runPreflight(cwd, {
      githubPackageVersions: ["1.2.3"],
      githubReleaseExists: true,
      publishedVersions: ["1.2.2", "1.2.3"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "RELEASE_PREFLIGHT_OK supaschema@1.2.3, @jmclaughlin724/supaschema@1.2.3, and v1.2.3 are already released"
    );
  });

  it("accepts an already complete release on a main push", () => {
    const cwd = makeProject({});

    const result = runPreflight(cwd, {
      githubEventName: "push",
      githubPackageVersions: ["1.2.3"],
      githubRef: "refs/heads/main",
      githubReleaseExists: true,
      publishedVersions: ["1.2.2", "1.2.3"],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "RELEASE_PREFLIGHT_OK supaschema@1.2.3, @jmclaughlin724/supaschema@1.2.3, and v1.2.3 are already released"
    );
  });

  it("rejects a GitHub release that exists before npm publish", () => {
    const cwd = makeProject({});

    const result = runPreflight(cwd, { githubReleaseExists: true, publishedVersions: ["1.2.2"] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "v1.2.3 already exists on GitHub but supaschema@1.2.3 is not on npm"
    );
  });

  it("rejects an existing GitHub tag that points to the wrong commit", () => {
    const cwd = makeProject({});

    const result = runPreflight(cwd, {
      githubTagTarget: "1111111111111111111111111111111111111111",
      publishedVersions: ["1.2.2", "1.2.3"],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("v1.2.3 points to 1111111111111111111111111111111111111111");
  });

  it("rejects a top-level package-lock version mismatch", () => {
    const cwd = makeProject({ lockVersion: "1.2.2" });

    const result = runPreflight(cwd);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package-lock.json version 1.2.2 does not match");
  });

  it("rejects a package-lock root package version mismatch", () => {
    const cwd = makeProject({ rootVersion: "1.2.2" });

    const result = runPreflight(cwd);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("package-lock.json root package version 1.2.2 does not match");
  });

  it("rejects a package version without a matching top changelog entry", () => {
    const cwd = makeProject({
      changelogText: `# Changelog

## 1.2.2 (2026-06-15)

- Previous release note.
`,
    });

    const result = runPreflight(cwd);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'CHANGELOG.md first version heading must be "## 1.2.3 (YYYY-MM-DD)"'
    );
  });

  it("extracts the top changelog entry for GitHub release notes", () => {
    const cwd = makeProject({});

    const result = spawnSync(process.execPath, [notesScript, "--version", "1.2.3"], {
      cwd,
      encoding: "utf8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("- Release note for 1.2.3.\n");
  });
});
