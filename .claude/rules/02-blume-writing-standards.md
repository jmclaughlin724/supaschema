---
description: Blume docs writing, MDX structure, frontmatter, navigation, and validation standards.
paths:
  - "docs/**"
---

# Rule 02 - Blume writing standards

## Contract

This rule owns the `docs/**` Blume documentation surface: writing style, MDX structure, frontmatter, navigation, AI readiness, and docs validation.

Sources:

- Blume documentation: <https://useblume.dev/docs>
- Blume frontmatter reference: <https://useblume.dev/docs/reference/frontmatter>
- Blume CLI reference: <https://useblume.dev/docs/reference/cli>

## Writing rules

- Write for the user's task, not for product promotion.
- Use clear, direct second-person instructions.
- Use active voice and present tense for current behavior.
- Lead with the most important information.
- Put prerequisites before steps and expected results after meaningful steps.
- Use progressive disclosure: common workflows first, advanced or rare details later.
- Avoid promotional, vague, and editorial phrasing such as "rich heritage" or "it is important to note".
- Use descriptive, keyword-rich, sentence-case headings.
- Avoid emoji and decorative formatting. Bold only when it helps the reader perform an action.

## Scanability rules

- Give each page one job and make that job clear in the first paragraph.
- Lead with the task, command, or outcome the reader came for. Move background below the first action.
- Keep paragraphs short: one idea per paragraph, two to four sentences.
- Non-hub pages get one primary next-action or related-resource grid. Hub pages may have one grid per distinct choice set.
- Body headings use sentence case unless the heading is a command, acronym, code symbol, product name, or diagnostic code.

## Page and frontmatter rules

- Every docs page is `.md` or `.mdx` under `docs/`.
- Every page declares `title`, `description`, and the repo's `keywords` list. `keywords` is registered through `frontmatter.extend` in `docs/blume.config.ts`.
- Any other frontmatter key must be a Blume-recognized field: `type`, `date`, `authors`, `slug`, `draft`, `deprecated`, `hidden`, `icon`, `noindex`, `lastModified`, `ai.*`, `changelog.*`, `sidebar.*`, `seo.*`, or `search.*`. Unknown keys fail `blume doctor`.
- Use `sidebar.label` for a short navigation title and `sidebar.hidden: true` to keep a page out of navigation.
- Use kebab-case filenames. Navigation derives from folder structure plus `meta.ts` files; there is no navigation manifest.
- Internal links are extensionless and root-relative, such as `/configuration/hints`. `blume validate` proves internal links, anchors, and asset references.
- Images live under `docs/public/images/**`, use root-relative `/images/**` paths, and include descriptive alt text. Blume serves root-relative paths only from `docs/public/`.
- When moving or renaming a page, declare a redirect in the `redirects` key of `docs/blume.config.ts` in the same change.
- Comparison pages under `docs/comparisons/` must include `Last verified YYYY-MM-DD` for external claims and a `## Sources` section with at least one outbound source link.

## AI readiness

- Blume serves `llms.txt`, `llms-full.txt`, raw page sources at `.md`/`.mdx` URLs, and `agent-readability.json` from static output.
- The MCP surface (`/mcp`, `/.well-known/mcp.json`) always requires server output with a deployment adapter. Self-hosted Ask AI requires it too; Ask AI pointed at an external `ai.ask.endpoint` does not. Enable them only with an explicit deployment decision.
- Use `draft: true` only for genuinely unpublished pages; drafts are excluded from production builds and AI surfaces.

## Verification

For docs changes, run:

```bash
npm run docs:check
```

`docs:check` runs the repo docs lint, then `blume doctor`, `blume validate`, and `blume build` in `docs/`. The build is the gate that rejects unknown components. Preview with `npm run docs:dev`.

## Failure behavior

Fix frontmatter, navigation, link, and component failures at the source page or `docs/blume.config.ts`. Do not extend the frontmatter schema to silence a typo and do not mark a failing page `draft: true` to pass validation.

## Done means

- Changed pages carry valid Blume frontmatter with `title`, `description`, and `keywords`.
- Navigation and redirects are current.
- `blume doctor` and `blume validate` pass.
- Code examples are syntactically valid or explicitly verified.
