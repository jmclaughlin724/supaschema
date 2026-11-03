import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { lintDocsStandard } from "../../scripts/docs-lint/check-standard.mts";

const docsLintCli = fileURLToPath(
  new URL("../../scripts/docs-lint/check-standard.mts", import.meta.url)
);
const roots: string[] = [];

const page = (body: string) => `---
title: "Test"
description: "A test page."
keywords: ["test", "docs"]
---

${body}
`;

async function writeDocs(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "supaschema-docs-standard-"));
  roots.push(root);
  for (const [file, contents] of Object.entries(files)) {
    const absoluteFile = join(root, file);
    await mkdir(dirname(absoluteFile), { recursive: true });
    await writeFile(absoluteFile, contents);
  }
  return root;
}

const lintOne = async (file: string, contents: string) => {
  const root = await writeDocs({ [file]: contents });
  return lintDocsStandard({ files: [file], rootDir: root });
};

const localRunnerDocsPages = [
  "coding-agents/agent-bundle",
  "coding-agents/index",
  "installation",
  "quickstart",
  "reference/package-boundary",
  "setup",
];

const localRunnerPrompt = [
  "packageManager",
  "devEngines.packageManager",
  "pnpm add supaschema",
  "| pnpm | `pnpm add supaschema`",
  "yarn add supaschema",
  "bun add supaschema",
  "npm exec -- supaschema init",
  "npm exec -- supaschema <cmd>",
  "pnpm exec supaschema <cmd>",
  "yarn exec supaschema <cmd>",
  "./node_modules/.bin/supaschema <cmd>",
  "pnpm exec supaschema init",
  "yarn exec supaschema init",
  "./node_modules/.bin/supaschema init",
  "Do not run npm in a pnpm, Yarn, or Bun project",
  "For workspaces, `cd` into the owning member package before first install.",
].join("\n");

function localRunnerFixtureFiles(overrides: Record<string, string> = {}) {
  return {
    ".agents/prompts/supaschema-install.md": localRunnerPrompt,
    ".claude/rules/supaschema.md": "Use the package manager local runner.\n",
    ".claude/skills/supaschema/SKILL.md": "Use the package manager local runner.\n",
    "AGENTS.md": "Use the package manager local runner.\n",
    "bin/scaffold.mjs": "export {};\n",
    "CLAUDE.md": "Use the package manager local runner.\n",
    "README.md": "Use the package manager local runner.\n",
    ...Object.fromEntries(
      localRunnerDocsPages.map((route) => [`docs/${route}.mdx`, page("## Start")])
    ),
    ...overrides,
  };
}

describe("docs authoring standard", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("rejects relative markdown and MDX component docs links", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      page(`
[bare](commands/diff)
[dot](./setup)
[parent](../configuration/hints)
<Card title="Relative" icon="terminal" href="commands/types" />
`)
    );

    expect(violations).toHaveLength(4);
    expect(violations.map((violation) => violation.rule)).toEqual([
      "internal-link",
      "internal-link",
      "internal-link",
      "internal-link",
    ]);
    expect(violations.map((violation) => violation.msg).join("\n")).toContain(
      'link "commands/diff" - docs links must be root-relative'
    );
  });

  it("allows root-relative docs links, same-page links, mailto, and external links", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      page(`
[root](/commands/diff)
[fragment](/configuration/hints#object-keys)
[anchor](#local-heading)
[query](?playground=open)
[mail](mailto:docs@example.com)
[external](https://example.com/docs)
<Card title="Root" icon="terminal" href="/commands/types" />
`)
    );

    expect(violations).toEqual([]);
  });

  it("rejects absolute docs URLs, docs-directory paths, and markdown extensions", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      page(`
[absolute](https://supaschema.com/docs/commands)
[docs-dir](docs/configuration/hints)
[root-docs-dir](/docs/configuration/hints)
[extension](/configuration/hints.md)
`)
    );

    expect(violations.map((violation) => violation.rule)).toEqual([
      "internal-link",
      "internal-link",
      "internal-link",
      "internal-link",
    ]);
  });

  it("uses AST nodes for body headings and code fence metadata", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      page(`
\`\`\`md
# This is code, not a body heading.
\`\`\`

# Duplicate body heading

\`\`\`bash theme={null}
echo ok
\`\`\`
`)
    );

    expect(violations.map((violation) => violation.rule)).toEqual(["body-h1", "fence-artifact"]);
  });

  it("requires language tags on code fences", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      page(`
\`\`\`
plain output
\`\`\`
`)
    );

    expect(violations.map((violation) => violation.rule)).toEqual(["code-fence-language"]);
  });

  it("accepts Blume sidebar and hidden frontmatter", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      `---
title: "Hidden"
description: "Hidden page."
keywords: ["hidden", "docs"]
hidden: true
sidebar:
  label: "Hidden"
---

## Hidden
`
    );

    expect(violations).toEqual([]);
  });

  it("requires keywords and rejects unsupported frontmatter values", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      `---
title: "Test"
description: "A test page."
keywords: []
hidden: "no"
sidebar: "left"
---

## Start
`
    );

    expect(violations.map((violation) => violation.rule)).toEqual([
      "frontmatter",
      "frontmatter",
      "frontmatter",
    ]);
    expect(violations.map((violation) => violation.msg).join("\n")).toContain(
      "missing or invalid `keywords` array"
    );
    expect(violations.map((violation) => violation.msg).join("\n")).toContain(
      "`hidden` must be a boolean when present"
    );
    expect(violations.map((violation) => violation.msg).join("\n")).toContain(
      "`sidebar` must be a mapping when present"
    );
  });

  it("rejects generic link text", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      page(`
[here](/commands/diff)
[Descriptive command reference](/commands/diff)
`)
    );

    expect(violations.map((violation) => violation.rule)).toEqual(["link-text"]);
  });

  it("requires docs images to live under /images and use Frame", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      page(`
![Example diagram](/diagrams/example.svg)

<img src="/images/example.svg" alt="Example diagram" />
`)
    );

    expect(violations.map((violation) => violation.rule)).toEqual([
      "image-path",
      "image-frame",
      "image-frame",
    ]);
  });

  it("allows framed docs images under /images", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      page(`
<Frame caption="Example diagram">
  <img src="/images/example.svg" alt="Example diagram" />
</Frame>
`)
    );

    expect(violations).toEqual([]);
  });

  it("rejects Columns card grids and malformed cards", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      page(`
<Columns cols={2}>
  <Card title="Missing icon" href="/commands/diff">
    Read the command reference.
  </Card>
</Columns>

<Card icon="terminal" href="/commands/check">
  Missing title.
</Card>
`)
    );

    expect(violations.map((violation) => violation.rule)).toEqual(["card-grid", "card", "card"]);
    expect(violations.map((violation) => violation.msg).join("\n")).toContain(
      "use <CardGroup> for docs card grids"
    );
  });

  it("limits CardGroup size by column count", async () => {
    const twoColumn = await lintOne(
      "docs/page.mdx",
      page(`
<CardGroup cols={2}>
  <Card title="One" icon="circle">One.</Card>
  <Card title="Two" icon="circle">Two.</Card>
  <Card title="Three" icon="circle">Three.</Card>
  <Card title="Four" icon="circle">Four.</Card>
  <Card title="Five" icon="circle">Five.</Card>
</CardGroup>
`)
    );
    const threeColumn = await lintOne(
      "docs/page.mdx",
      page(`
<CardGroup cols={3}>
  <Card title="One" icon="circle">One.</Card>
  <Card title="Two" icon="circle">Two.</Card>
</CardGroup>
`)
    );

    expect(twoColumn.map((violation) => violation.rule)).toEqual(["card-grid"]);
    expect(threeColumn.map((violation) => violation.rule)).toEqual(["card-grid"]);
  });

  it("rejects long card bodies", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      page(`
<Card title="Long" icon="book">
  This card body is deliberately much too long because cards should be glanceable, not miniature documentation sections with multiple clauses, several details, extra context, repeated caveats, and explanation that belongs in the page body instead of inside a compact card.
</Card>
`)
    );

    expect(violations.map((violation) => violation.rule)).toEqual(["card"]);
    expect(violations[0]?.msg).toContain("35 words max");
  });

  it("rejects adjacent callouts without explanatory content", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      page(`
:::note
First note.
:::

:::tip[Titled]
Second tip.
:::
`)
    );

    expect(violations.map((violation) => violation.rule)).toEqual(["callout-spacing"]);
  });

  it("accepts callouts separated by explanatory content", async () => {
    const violations = await lintOne(
      "docs/page.mdx",
      page(`
:::note
First note.
:::

Prose that explains why the second callout follows.

:::tip
Second tip.
:::
`)
    );

    expect(violations.map((violation) => violation.rule)).not.toContain("callout-spacing");
  });

  it("requires sentence-case body headings while allowing commands, acronyms, and code", async () => {
    const rejected = await lintOne(
      "docs/page.mdx",
      page(`
## How It Works
`)
    );
    const allowed = await lintOne(
      "docs/page.mdx",
      page(`
## diff

## CI

## \`dir:\` files

## GitHub Actions
`)
    );

    expect(rejected.map((violation) => violation.rule)).toEqual(["heading-case"]);
    expect(allowed).toEqual([]);
  });

  it("checks local-runner install wording as part of docs-standard", async () => {
    const root = await writeDocs(localRunnerFixtureFiles());

    const violations = lintDocsStandard({ rootDir: root });

    expect(violations).toEqual([]);
  });

  it("checks local-runner conventions from the executable full-lint route", async () => {
    const root = await writeDocs(
      localRunnerFixtureFiles({
        "README.md": "Run `npm install supaschema`\nnpx supaschema diff\n",
      })
    );

    const result = spawnSync(process.execPath, [docsLintCli], { cwd: root, encoding: "utf8" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[local-runner]");
  });

  it("rejects stale universal npx and missing local-runner install guidance", async () => {
    const root = await writeDocs(
      localRunnerFixtureFiles({
        ".agents/prompts/supaschema-install.md": localRunnerPrompt.replace(
          "./node_modules/.bin/supaschema init",
          ""
        ),
        "README.md": "Run `npm install supaschema`\nnpx supaschema diff\n",
      })
    );

    const violations = lintDocsStandard({ rootDir: root });
    const localRunnerMessages = violations
      .filter((violation) => violation.rule === "local-runner")
      .map((violation) => violation.msg)
      .join("\n");

    expect(localRunnerMessages).toContain("must document ./node_modules/.bin/supaschema init");
    expect(localRunnerMessages).toContain("must not present npm install as universal");
    expect(localRunnerMessages).toContain("must not present npx supaschema as universal");
  });

  it("requires comparison pages to carry dated sources", async () => {
    const missing = await lintOne(
      "docs/comparisons/example.mdx",
      page(`
## Comparison

This page compares an external tool.
`)
    );
    const sourced = await lintOne(
      "docs/comparisons/example.mdx",
      page(`
<Info>
  Last verified 2026-06-18 against the vendor documentation.
</Info>

## Sources

- [Vendor documentation](https://example.com/docs)
`)
    );

    expect(missing.map((violation) => violation.rule)).toEqual([
      "comparison-claim",
      "comparison-claim",
    ]);
    expect(sourced).toEqual([]);
  });
});
