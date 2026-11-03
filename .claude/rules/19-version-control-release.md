---
description: Release versioning, mandatory update audit, release-surface parity, git staging, commit, push, and PR discipline.
paths:
  - "package.json"
  - "package-lock.json"
  - "CHANGELOG.md"
  - "action.yml"
  - ".github/workflows/release.yml"
  - "scripts/release/changelog-notes.mts"
  - "scripts/release/preflight.mts"
  - "scripts/guards/ci-release/check-release-version-surfaces.mts"
  - "scripts/guards/check-all.mts"
  - "AGENTS.md"
---

# Rule 19 - Version control and release

## Contract

This rule owns the operator workflow for version bumps, release notes, the mandatory `$update` audit, and release-control git work. When a user says to update supaschema to a version, that is one release-version transaction: update every version-coupled surface, run `$update` after versioning, prove parity with the guards, then stage, commit, push, or open the PR when requested. Do not ask the user to enumerate these steps.

## Publishing is automatic when a version bump merges

`.github/workflows/release.yml` triggers on `push` to `main`, and its preflight decides whether the pushed version still needs publishing. Merging a PR that bumps `package.json` `version` therefore publishes to npm and creates the GitHub Release with no separate publish step and no publish approval to request afterward. Merging a PR that leaves the version unchanged makes no stable release: preflight finds the version already published and exits successfully.

Every eligible `main` push also runs the `publish-next` job in `.github/workflows/release.yml`, which publishes an immutable `X.Y.(Z+1)-dev.<sha>` build to the `next` dist-tag after preflight succeeds and the stable publish either succeeds or is intentionally skipped because no stable work remains. Dependency failure or cancellation blocks the snapshot. Do not tell a user that a version-unchanged merge published nothing; it produced no `latest` release, and its snapshot publish still needs the same attention as any other failed workflow.

- Approval to merge a version-bumped PR is approval to release. Do not merge and then report publishing as still blocked or still pending.
- Never run `npm publish`, `npm version` with a tag push, or `gh release create` locally. Releases publish through npm OIDC trusted publishing with build provenance from the privileged workflow job; a local publish bypasses provenance attestation and is prohibited even when npm credentials are present.
- Before telling a user that a release step remains, read `.github/workflows/release.yml` triggers and resolve the release run for the merge commit. Registry state, the GitHub Release, and that run's conclusion are the evidence; an external handoff, plan, or issue claiming a manual publish step is not.
- When a merge is requested and the branch carries a version bump, say that merging publishes before merging, then merge and verify with the post-merge commands below.
- Tie release proof to the merge SHA and to a terminal conclusion. `gh run list --workflow=release.yml` alone lists recent runs and can match an older success, so it never proves the current release; use `--commit <merge-sha>` and wait for the run to finish. A published npm version does not prove the GitHub Release step succeeded, so check both.
- Repair a partially failed release by re-running that merge commit's own failed run, not by dispatching `main`. The workflow checks out `github.sha`, derives the version from that checkout, and creates the tag with `--target "$GITHUB_SHA"`, so a dispatch after later commits land would tag the release at the wrong commit or act on a different version. Use `workflow_dispatch` only when `main` still points at the commit needing repair. Preflight is idempotent either way: an already-published version exits successfully without republishing.
- Prepare all fallible release inputs before the first registry write. The stable job renders its CHANGELOG-owned GitHub release notes before npm publication; the snapshot job prepares pinned pnpm and Bun before npm publication. Keep each publish immediately followed by its provenance attestation so failure cannot strand avoidable preparation work after an irreversible write.

## Release-note owner

`CHANGELOG.md` is the canonical release-note owner for npm and GitHub releases. The top entry for `package.json` `version` must be `## <version> (YYYY-MM-DD)` and must contain non-empty, user-readable notes. `scripts/release/changelog-notes.mts` extracts that entry for GitHub Release creation; do not use GitHub auto-generated release notes as the published release body.

Changesets may collect PR-local release intent and may drive `npm run release:version`, but after versioning the generated top `CHANGELOG.md` entry is the source of truth. If `CHANGELOG.md`, GitHub Release notes, npm version, package metadata, or `action.yml` disagree, fix the canonical release transaction before publishing or repairing a release.

## Version bump transaction

When asked to create or update to version `<version>`, do all of this in the same change:

1. Inspect `git status --short --branch`.
2. Update `package.json` and `package-lock.json` together. Prefer `npm version <version> --no-git-tag-version` unless both files already carry the requested version.
3. Add or update the top `CHANGELOG.md` entry as `## <version> (YYYY-MM-DD)` with concise, source-grounded release notes.
4. Keep `action.yml` `inputs.version.default` unset; the action runner defaults from `package.json`. Keep exact-version validation text generic and do not duplicate `<version>` in the runner message.
5. Search for other version-coupled release surfaces introduced by the change and update them in the same commit.
6. Run `$update` as the final impact audit after all release-owned changes are present. Resolve every in-scope finding and run the owner, sync, docs, package, consumer, and generated-surface validation selected by the skill before continuing.
7. Run `npm run release:notes -- --version <version>` to inspect the release body that GitHub will publish.
8. Run `npm run guard:release-version` before broader release or package checks.

A version bump that only changes `package.json` and `package-lock.json` is incomplete.

## Git and PR transaction

When the user asks to stage, commit, push, or create a PR after a version bump, use these release specifics:

- Use a release-specific commit message such as `Prepare release <version>` or `Enforce release version surfaces`.
- Push only the intended release branch.
- When asked for a PR, create a non-draft PR unless the user explicitly says draft. Include the version, changelog, release-surface parity, base branch, head branch, commit count, changed-file count, mergeability result, and verification commands in the PR body.
- If CI fails on a version-coupled surface, fix the source drift and add or update guard coverage so the same miss fails locally next time.

## Enforced by

- `npm run guard:release-version` (`scripts/guards/ci-release/check-release-version-surfaces.mts`) asserts that:
  - `package.json`, `package-lock.json`, and the lockfile root package version agree;
  - the first `CHANGELOG.md` version heading matches the package version, uses an ISO date, and contains release notes;
  - `action.yml` leaves `inputs.version.default` unset so the runner defaults from `package.json`;
  - the action validation message tells users to use an exact npm version without copying the current version.
- `scripts/release/preflight.mts` repeats the package, lockfile, and changelog release-note checks before the release workflow decides whether to publish npm or repair GitHub Release state.
- `.github/workflows/release.yml` creates GitHub Releases with `--notes-file` from `scripts/release/changelog-notes.mts`, not `--generate-notes`.
- `npm run guard` runs `guard:release-version` through `scripts/guards/check-all.mts`.
- `tests/release/action.test.ts` verifies the composite action default follows `package.json` and does not drift to npm dist-tags.
- Snapshot publishing is the one permitted dist-tag write: the release.yml `publish-next` job publishes immutable `X.Y.(Z+1)-dev.<sha>` builds to the `next` tag from protected `main` pushes. The `latest` tag remains release.yml `publish`-job-only, and consuming a snapshot always resolves to an exact version before install; dist-tags remain forbidden for action execution.
- The release checklist and release PR checklist require `$update` after versioning and before release verification or merge. The audit is semantic and is reviewed through its changed owners and validation evidence; do not add a forgeable marker file or brittle prose guard to simulate execution proof.

STOP if a version bump does any of these:

- Leaves any known release surface on the previous version, or skips `$update` after the final release-owned changes.
- Adds a GitHub Action default version, or uses an npm dist-tag for action execution.
- Omits the changelog top entry, or publishes a GitHub Release body from auto-generated notes instead of `CHANGELOG.md`.
- Commits generated mirrors without syncing from the canonical owner, bypasses hooks, or weakens a guard or test to make the release pass.

## Verification

For every version bump, run:

```bash
npm run guard:release-version
npm run release:notes -- --version <version>
npm test -- tests/release/action.test.ts
```

For package or release workflow changes, also run:

```bash
npm run release:verify
npm run check:package
npm run pack:dry
npm run guard
```

For rule or generated agent-surface changes, also run:

```bash
npm run sync:llm
```

After merging a version-bumped PR into `main`, prove the automatic release instead of reporting a pending publish. Resolve the run for the merge commit, wait for it, and check its conclusion:

```bash
gh run list --workflow=release.yml --commit <merge-sha> --json databaseId,status,conclusion
gh run watch <run-id> --exit-status
npm view supaschema@<version> version
gh release view v<version> --json tagName,publishedAt,isDraft
```

## Failure behavior

Fix the drift in the canonical source. Do not add an action version default, loosen the exact-version validation, skip the changelog, or bypass hooks.

## Done means

All version-coupled surfaces agree with the package version, `$update` has closed every confirmed impact after the final release-owned changes, the changelog top entry names that version and is the GitHub Release body source, local release-version guards pass, and requested git and PR actions completed without touching unrelated work.

When the transaction included a merge to `main`, the release is also verified rather than assumed: the `release.yml` run for that merge commit concluded successfully, `npm view supaschema@<version> version` resolves the exact released version, and the GitHub Release exists for its tag. No publish step is reported as outstanding.
