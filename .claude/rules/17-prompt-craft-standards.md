---
enforcement:
  type: judgment-only
description: Authoring standards for AGENTS, CLAUDE, rules, skills, agents, hooks, commands, generated mirrors, and session-agent prompts.
paths:
  - "AGENTS.md"
  - "CLAUDE.md"
  - ".claude/**"
  - ".codex/**"
  - ".agents/**"
  - "scripts/agent-hooks/**"
  - "scripts/skills/**"
---

# Rule 17 - Prompt craft standards

## Contract

This rule owns how agent instructions are written and delivered. Stable prevention policy may live in the root brief or rules; repeatable workflows belong in skills, deterministic enforcement belongs in hooks or guards, and generated mirrors remain targets rather than owners.

Upstream Responses API guidance for prompt economy, skills, multi-agent delegation, reasoning controls, and tool orchestration lives in the optimizer skill reference `codex/prompting/responses-prompt-and-tool-contract.md`. Load it when a change turns on that guidance rather than restating it here.

## Surface selection

- Root `AGENTS.md`: canonical Codex project instruction brief.
- Nested `<subfolder>/AGENTS.md`: directory-scoped context that may serve as a concise route map or owner brief for that subtree.
- `.claude/rules/**`: durable policy, boundaries, STOP gates, and verification paths.
- `.claude/skills/**`: repeatable procedures, examples, references, scripts, and assets.
- `.claude/hooks/**` and `scripts/agent-hooks/**`: deterministic lifecycle enforcement.
- `.codex/**` and `.agents/**`: runtime config or generated/synced mirrors.
- `README.md`: npm package landing page, not agent policy.
- `docs/**`: Blume public docs, not agent policy.

## Rule and skill shape

Every non-stub rule or skill must include:

- frontmatter with a short `description`;
- `## Contract` near the top;
- direct rules before examples, history, or reference detail;
- verification and failure behavior when the surface is executable;
- no unresolved placeholders, no machine-local absolute paths, no stale plan text.

## Collaboration and response contract

- Keep personality and collaboration guidance short and distinct. Personality controls tone; collaboration controls initiative, questions, assumptions, uncertainty, tradeoffs, and verification.
- Before multi-step tool work, give a one- or two-sentence first-step preamble. Update at major phase changes or when evidence changes the plan; do not narrate routine calls.
- The newest request determines action authority. A debugging, review, audit, explanation, or reporting skill does not authorize edits or external mutation unless the request also asks for a fix or implementation.
- In diagnostic work, cite the observation behind each claim (command output, `path:line`, or run URL) and run the probe that tests each hypothesis before stating it. Claim a root cause or actor only when cited evidence explains the symptom and excludes material alternatives; temporal proximity and a later successful replay are not attribution.
- Lead final responses with the outcome unless the turn contains a material tool or runtime incident, rejected action, timeout, truncation, partial mutation, or lost-evidence event that the root contract requires surfaced first. In that case, lead with an explicit incident label, name what happened without euphemism, state impact and recovery evidence, and then give the outcome. A recovered incident remains prominent; do not demote it to a trailing caveat. For a recorded shell command-not-found incident, begin exactly with `Tool incident:` and explicitly say `command not found`.
- For edits, rewrites, summaries, and drafts, preserve the requested artifact, factual claims, length, structure, and genre before improving clarity. Do not add claims, sections, or promotional tone unless requested.

## Generated prompt contract

Prompts generated for another session agent must include:

1. Mission.
2. Context.
3. Authority and rule priority.
4. Scope in/out.
5. Non-negotiable rules.
6. Required workflow.
7. Verification.
8. Stop conditions.
9. Failure behavior.
10. Output format.
11. Acceptance criteria.

Generated prompts must not contain unresolved placeholders, invented paths, invented commands, secrets, local-only absolute paths, or unverified repo facts. If repo access is unavailable, leave file paths and commands out and tell the session agent to find them with a targeted repository search and cite the `path:line` of each.

## Style

- Use `MUST`/`MUST NOT` only for structural correctness, safety, security, package boundary, migration, or generated-surface requirements.
- Use direct bullets and concrete commands.
- Avoid vague phrases such as "best practices" unless immediately defined.
- Put long background and examples in skill-local `references/**`.
- Use tables only when the matrix is the rule.
- For review and audit prompts, require evidence, severity, and non-speculative findings, with each item no search settled reported as unknown and the routes tried.

## Verification

After changing rules, skills, hooks, agents, commands, generated mirrors, or root briefs, run the relevant sync/check command:

```bash
npm run sync:llm
npm run guard
```

Use narrower commands (`npm run guard:agent`, focused hook tests, rule/skill checks) when the task is scoped.

## Failure behavior

Fix the canonical owner first, then regenerate mirrors. Do not patch a generated mirror, duplicate policy across surfaces, or add a new rule or skill without an enforcement or verification story.

## Done means

- The instruction lives in the correct surface.
- The rule or skill has a contract, scope, verification, and failure behavior.
- Generated targets are synced from owners.
- No unresolved placeholders, secrets, stale dates, or local-only absolute paths remain.
