---
enforcement:
  type: judgment-only
description: Single source-control owner for worktrees, Git commands, branches, commits, pushes, GitHub settings, pull requests, merges, and cleanup.
codexExecPolicy: |
  [
    {
      "pattern": ["git", "checkout"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids git checkout; keep work in the current branch and use git show or git diff for read-only comparisons.",
      "match": ["git checkout main"],
      "not_match": ["git show main:package.json", "git diff main -- package.json"]
    },
    {
      "pattern": ["git", "switch", "main"],
      "decision": "allow",
      "justification": "Rule 21 allows returning to main only after the current topic PR is verified merged.",
      "match": ["git switch main"],
      "not_match": ["git switch -C main origin/main"]
    },
    {
      "pattern": ["git", "switch", "-c"],
      "decision": "allow",
      "justification": "Rule 21 allows transactional topic-branch creation only after origin/main fetch and base proof are complete.",
      "match": ["git switch -c feature/demo origin/main"],
      "not_match": ["git switch --track origin/feature/demo", "git switch -C feature/demo origin/main"]
    },
    {
      "pattern": ["git", "switch", "--track"],
      "decision": "allow",
      "justification": "Rule 21 allows tracking an existing origin topic branch only after fetch and base proof are complete.",
      "match": ["git switch --track origin/feature/demo"],
      "not_match": ["git switch -c feature/demo origin/main", "git switch main"]
    },
    {
      "pattern": ["git", "switch", ["-C", "--force-create", "-f", "--force", "--discard-changes", "-m", "--merge"]],
      "decision": "forbidden",
      "justification": "Rule 21 forbids branch replacement and switch modes that discard, stash, or merge local changes.",
      "match": ["git switch -C feature/demo origin/main", "git switch --discard-changes feature/demo", "git switch --merge feature/demo"],
      "not_match": ["git switch -c feature/demo origin/main", "git switch --track origin/feature/demo"]
    },
    {
      "pattern": ["git", "branch"],
      "decision": "prompt",
      "justification": "Rule 21 limits git branch to one verified merged-topic deletion; native prefix policy cannot prove the operand or merge state.",
      "match": ["git branch -D feature/demo", "git branch feature/demo"],
      "not_match": ["git rev-parse --abbrev-ref HEAD", "git status --short"]
    },
    {
      "pattern": ["git", "worktree"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids every worktree command; continue only in the active primary checkout.",
      "match": ["git worktree list --porcelain -z", "git worktree add ../demo HEAD"],
      "not_match": ["git status --short"]
    },
    {
      "pattern": ["git", "reset"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids git reset because it can discard unrelated work.",
      "match": ["git reset --hard"],
      "not_match": ["git status --short"]
    },
    {
      "pattern": ["git", "stash"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids git stash; preserve unrelated work in place.",
      "match": ["git stash"],
      "not_match": ["git status --short"]
    },
    {
      "pattern": ["git", "clean"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids destructive clean operations without explicit approval.",
      "match": ["git clean -fd"],
      "not_match": ["git status --ignored --short"]
    },
    {
      "pattern": ["git", "commit", "--no-verify"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids bypassing hooks; fix the hook failure instead.",
      "match": ["git commit --no-verify -m skip"],
      "not_match": ["git commit --signoff -m update"]
    },
    {
      "pattern": ["git", "merge", "--squash"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids local squash merges for PR merge workflow.",
      "match": ["git merge --squash feature/demo"],
      "not_match": ["git merge-base --is-ancestor HEAD origin/main"]
    },
    {
      "pattern": ["git", "push", "--force"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids force-push shortcuts.",
      "match": ["git push --force origin main"],
      "not_match": ["git push origin HEAD:main"]
    },
    {
      "pattern": ["git", "push", "--force-with-lease"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids force-push shortcuts.",
      "match": ["git push --force-with-lease origin main"],
      "not_match": ["git push origin HEAD:main"]
    },
    {
      "pattern": ["git", "restore", "--source"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids git restore --source because it overwrites local files from another ref.",
      "match": ["git restore --source HEAD~1 src/index.ts"],
      "not_match": ["git diff -- src/index.ts"]
    },
    {
      "pattern": ["git", "restore", "-s"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids git restore -s because it overwrites local files from another ref.",
      "match": ["git restore -s HEAD~1 src/index.ts"],
      "not_match": ["git show HEAD~1:src/index.ts"]
    },
    {
      "pattern": ["gh", "pr", "merge", "--rebase"],
      "decision": "forbidden",
      "justification": "Rule 21 uses GitHub squash merges with branch cleanup; use gh pr merge <number> --squash --delete-branch.",
      "match": ["gh pr merge --rebase 53"],
      "not_match": ["gh pr merge 53 --squash --delete-branch"]
    },
    {
      "pattern": ["gh", "pr", "merge", "--merge"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids merge commits; use gh pr merge <number> --squash --delete-branch.",
      "match": ["gh pr merge --merge 53"],
      "not_match": ["gh pr merge 53 --squash --delete-branch"]
    },
    {
      "pattern": ["gh", "pr", "merge", "--admin"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids admin merge bypasses unless the user explicitly approves and records the exception.",
      "match": ["gh pr merge --admin 53"],
      "not_match": ["gh pr merge 53 --squash --delete-branch"]
    },
    {
      "pattern": ["gh", "pr", "merge", "--disable-auto"],
      "decision": "forbidden",
      "justification": "Rule 21 forbids disabling auto-merge as a merge workaround.",
      "match": ["gh pr merge --disable-auto 53"],
      "not_match": ["gh pr merge 53 --squash --delete-branch"]
    },
    {
      "pattern": ["gh", "pr", "merge"],
      "decision": "prompt",
      "justification": "Keep selector-before-flag merge forms behind approval because native prefix policy cannot validate the complete merge argument shape.",
      "match": ["gh pr merge 53 --rebase", "gh pr merge 53 --squash --delete-branch"],
      "not_match": ["gh pr view 53"]
    },
    {
      "pattern": ["git", "push", "origin", "HEAD:main"],
      "decision": "forbidden",
      "justification": "Rule 21 requires all main updates to pass through a protected pull request.",
      "match": ["git push origin HEAD:main"],
      "not_match": ["git push -u origin codex/feature"]
    }
  ]
paths:
  - ".github/**"
  - ".gitignore"
  - ".gitattributes"
  - ".claude/rules/21-source-control.md"
  - "scripts/github/**"
  - "scripts/guards/ci-release/check-github-process.mts"
  - "scripts/guards/check-all.mts"
  - "package.json"
  - "AGENTS.md"
  - "CLAUDE.md"
---

# Rule 21 - Source control and GitHub

## Contract

This rule is the single owner for source-control state and lifecycle: dirty worktrees, Git command safety, branch creation, staging, commits, pushes, GitHub repository settings, pull requests, squash merging, local and remote branch cleanup, and live settings audit.

Upstream sources:

- GitHub protected branches: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches>
- GitHub merge methods: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/about-merge-methods-on-github>
- GitHub ruleset rules: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets>
- GitHub automatic branch deletion: <https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-the-automatic-deletion-of-branches>
- GitHub CLI `gh pr merge`: <https://cli.github.com/manual/gh_pr_merge>
- GitHub CLI `gh repo edit`: <https://cli.github.com/manual/gh_repo_edit>
- Git worktrees: <https://git-scm.com/docs/git-worktree>

## Dirty worktree rules

- A dirty worktree is normal. Do not block on a clean tree unless a specific Git operation requires it.
- Do not revert, stash, reset, clean, or overwrite unrelated tracked or untracked work.
- Stage only task-owned hunks after reviewing the intended diff.

## Git safety

- Commit, push, open a PR, or merge only when explicitly requested. Native Codex command rules cover expressible command prefixes; this rule and the agent action boundary own prerequisites and complete argument semantics that prefix policy cannot prove.
- Deleting a merged topic branch is routine cleanup, not a gated action. Once a topic PR is proved merged, delete the local branch as part of post-merge closeout without waiting for separate approval.
- Every update to `main` uses a protected pull request. Direct pushes to `main` are prohibited.
- Keep one active topic branch at a time. Do not create a separate branch off the active branch (no stacked branches); follow-up commits and review fixes for an open PR stay on its branch. Once the active branch's PR is squash-merged, the branch is archived: complete the post-merge closeout below and delete it locally and remotely before any new work, which starts on a fresh topic from `origin/main`.
- When the current user prompt explicitly requests a topic branch, run `git fetch origin main`, prove `HEAD` equals `origin/main`, and create and enter the topic branch atomically with `git switch -c <branch> origin/main`.
- When continuing an existing remote topic branch that has no local ref, fetch it, prove `HEAD` equals `origin/main` and the remote topic is based on fetched `origin/main`, then use `git switch --track origin/<branch>`.
- When returning to a topic branch that already exists locally, for example to address PR review findings after working elsewhere, use `git switch --no-guess <branch>`. `--no-guess` is required: Git's default DWIM behavior would otherwise create and track a new local branch from a unique `origin/<branch>`, bypassing the fetch and base-proof path above. Verify the local ref matches its pushed remote first so the return cannot silently resurrect stale work.
- Never commit PR-scoped work on local `main` and push it to a branch ref. Do not create a recovery path that moves task commits off local `main` after the fact.
- Let lefthook, pre-commit, and pre-push run. Never use `--no-verify`.
- Do not use `git checkout` or `git branch` for creation or discovery. Do not run any `git worktree` command. Do not use `git switch` apart from the four forms above: `git switch main` after verified PR merge, `git switch --no-guess <existing local topic>`, `git switch -c <topic> origin/main`, and `git switch --track origin/<topic>`.
- Branch operands must be literal, validated topic-branch names. Reject previous-checkout shorthand such as `@{-1}`: `git branch -D` expands this syntax (the same expansion `git check-ref-format --branch` performs) to another branch, including `main`, and deletes it regardless of merge state. Reject unexpanded shell operands such as `$BRANCH` or `$(cmd)` for the same reason: an unvalidated value can name the wrong branch. `HEAD~1` and `topic^` are not valid branch-name syntax and fail closed instead of silently resolving, but keep operands to validated literal names only.
- Subagents must never create, switch, or delete a branch because they share the active primary checkout.
- After proving a topic PR merged and preserving all dirty work elsewhere, delete the local topic with `git branch -D <topic>`. Never delete `main`, an unmerged branch, or more than one branch per command.
- Do not use `git switch -C`, `--force-create`, `--force`, `--discard-changes`, `--merge`, or their short forms.
- Do not use `git reset`, `git restore --source`, `git stash`, `git merge --squash`, force-push, or destructive branch operations without explicit approval.
- Do not use `git push` as a diagnostic. Use the repo pre-push script or `git push --dry-run` only when remote negotiation itself must be tested.
- Run `git commit`, `git push`, and merge commands bare. Never pipe them through `tail`, `head`, or another truncator, and never redirect their output into a scratch file: either shape hides hook output or the command's real result. Let the command result remain visible and use the tool's own output limit only for display.
- Subagents and workers may edit files only inside the active primary checkout. They must not stage, commit, push, switch branches, create branches or worktrees, merge, or open or replace PRs.
- Only the main agent may stage, commit, push, create or replace a PR, merge, clean up branches, and perform final source-control verification.

## Canonical policy

`.github/repo-policy.json` is the machine-readable owner for intended GitHub repository, Actions, branch-protection, and ruleset state. `npm run guard:github-process` asserts the policy file stays synchronized, and `npm run github:audit-settings` compares live GitHub state against it. Read the policy file for the current values instead of restating them here.

These change-protocol rules govern how that policy may move, and cannot live in the JSON:

- Commit signoff MUST NOT be enforced by GitHub settings, CI, package scripts, PR template checklists, or repo guards unless the user explicitly approves a new contributor-certificate policy in the same change.
- If required reviews or status checks are introduced, update `.github/repo-policy.json`, CODEOWNERS expectations, the PR template, and this rule in the same change.
- Ruleset bypass actors MUST remain empty unless the user explicitly approves a break-glass path and the reason is recorded in this rule.
- Classic branch protection MUST NOT duplicate required status checks or pull-request review settings; the repository ruleset owns those gates.

CODEOWNERS is advisory while `required_approving_review_count` is `0` and `require_code_owner_reviews` is `false`. Do not describe code-owner review as enforced unless those settings change.

## Repository surface policy

This rule owns `.gitignore` content policy. Repo surfaces stay tracked or stay out; `.gitignore` never defines published package contents.

- `.gitignore` covers only build artifacts, env/secret files, OS noise, agent session/personal state (`.claude/plans`, `.claude/agents/`, `.codex/agents/`, `.claude/scheduled_tasks.lock`, `.claude/settings.local.json`), editor state (`.vscode/`), and the held business-sensitive set: `advisor-plans/`, `.planning/`. Publishing a held path is an irreversible public-repo exposure and requires an explicit user decision in the same change. The tracked nested `docs/.gitignore` owns Blume build output (`.blume/`, `.blume-verify/`, `dist/`) for the private docs package.
- `scripts/guards/repo-surface/private-paths.json` is the machine-readable owner of the private-path set, in two buckets: `heldPrivate` (never public, never agent-MCP-readable: `advisor-plans/`, `.planning/`) and `agentPrivate` (public-repo-private user state: `.claude/plans/`, `.claude/agents/`, `.codex/agents/`, `.vscode/`). The repo-surface guard and the agent-MCP `repo_context_query` read path both consume this file; do not maintain a third private-path list anywhere else.
- `.gitignore` MUST NOT hide source surfaces that tracked files reference. Wired maintainer tooling stays tracked: `services/agent-mcp/`, `services/license-worker/`, `scripts/stripe/`, `wrangler.toml`, `pyproject.toml`, `uv.lock`, `fastmcp.json`, `.mcp.json`, `.codex/config.toml`, and `.github/workflows/python.yml`.
- `scripts/guards/repo-surface/check-public-repo-surface.mts` enforces both invariants: held-private paths are never tracked or stageable, and wired tooling present on disk is always tracked. Changing either set means updating `private-paths.json`, `.gitignore`, the guard, its tests, and this rule in the same change.
- The `.agents/.claude/.codex` ignore-with-unignore pattern is the deliberate privacy filter for the local skills library (the 2026-06 public-surface reduction); do not collapse it without an explicit user decision.

## Pull-request workflow

Use this path for every commit intended for `main`.

Enter the topic checkout before the first commit, so local `main` never carries unpublished work. Use the transactional branch paths defined above. Commit, push, and open the PR only from that topic checkout. A topic branch lives for exactly one PR cycle: while its PR is open, follow-up commits and review fixes stay on it; after squash merge it is archived, never reused for a follow-up PR. Do not open a PR from a long-lived, release-scoped, conflict-producing, or overbroad branch with commits outside the requested task.

Merge PRs with GitHub's squash merge path:

```bash
gh pr merge <number> --squash --delete-branch
```

Do not use `--merge`, `--rebase`, `--admin`, `--disable-auto`, local squash merges, force-push workarounds, or repo-local merge wrappers unless the user explicitly approves the exception and the reason is recorded in the PR.

Merging a version-bumped PR into `main` also publishes the release. The release-versioning rule owns that contract, its constraints, and its post-merge proof commands; read it before merging such a branch instead of restating its policy here.

## Multi-session branches

When more than one agent session works on the same topic branch, use user-visible session updates and the shared checkout, re-read status and diffs before overlapping edits, preserve every hunk not owned by the current task, and keep one main session responsible for staging and commits.

## Post-merge closeout

After a PR merge, complete local and remote cleanup before starting another task:

1. Run `git fetch --prune origin` so deleted GitHub heads cannot survive as stale `origin/<branch>` refs.
2. Verify with `gh pr view <number> --json state,mergeCommit,headRefName,headRefOid,baseRefName` that the PR is merged and record the exact head and merge commit.
3. Verify the merge commit is contained by `origin/main`, the remote head is absent, the local head is absent, and the active checkout is no longer the merged topic branch.
4. Verify local `main` equals `origin/main` when the merge operated from the primary checkout.

Squash merging creates a new commit and leaves the original topic commits outside `main` ancestry. An ahead count on a surviving squash-merged topic branch does not mean its content is unmerged; it means cleanup is incomplete. Archive the merged topic branch by deleting it locally and remotely, instead of resetting, force-pushing, or continuing work on it.

STOP before further edits when the merge succeeds but local cleanup fails. Preserve any dirty work, prove the PR and tree state, and obtain explicit approval for destructive recovery rather than silently carrying new work on the merged branch.

## PR review and check resolution

Address every PR review comment and failing check before merge, and mark each resolved only when its correction lands: never before, and never for a valid finding left unaddressed.

1. Fix the finding in the canonical owner, or record an owner-scoped not-applicable reason with evidence, and commit that correction.
2. Only then resolve the review thread (`gh api graphql` `resolveReviewThread`) or re-run the failing check to success. Resolving a thread or dismissing a check before its correction is committed, or resolving a valid unaddressed finding, is prohibited.

`required_conversation_resolution` is enforced on `main` PRs, so unresolved threads block merge; do not resolve threads prematurely to unblock a merge.

## Enforced by

- `npm run guard:github-process` (`scripts/guards/ci-release/check-github-process.mts`) asserts the policy file, package commands, canonical Rule 21 path, and retired duplicate rule paths stay synchronized.
- `npm run guard` runs `guard:github-process` through `scripts/guards/check-all.mts`.
- `npm run github:audit-settings` (`scripts/github/audit-settings.mts`) compares live GitHub repository settings, Actions permissions, `main` branch protection, repository rulesets, and topics to `.github/repo-policy.json`.
- `.github/PULL_REQUEST_TEMPLATE.md` records the short operator checklist for PR authors and reviewers.

## Verification

After GitHub process, PR template, policy, package script, guard, or related rule changes, run:

```bash
npm run guard:github-process
npm run sync:llm
```

Before merging a PR, run:

```bash
npm run github:audit-settings
```

After merging a PR, run the post-merge closeout above and record the fetched ref and PR-state evidence.

## Failure behavior

Fix the worktree, branch, policy, GitHub setting, or failing check that failed. If `statusCheckRollup` evidence reports failed checks, fix the checks and record later successful evidence before claiming green. Do not bypass branch protection, push directly to `main`, use admin merge, force push, retarget the PR to avoid conflicts, loosen `.github/repo-policy.json`, discard unrelated work, or continue on a merged topic branch to make a command pass.

## Done means

One rule owns the entire source-control lifecycle; task-owned staging is verified; local and remote branch state agree; merged topic branches are absent; local `main` is current after primary-checkout merges; and repo policy, live GitHub settings, merge method, guard, PR template, and GitHub check evidence agree.
