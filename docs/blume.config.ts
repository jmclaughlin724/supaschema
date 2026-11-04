import { cloudflare } from "blume/deploy";

const optionalKeywordList = {
  "~standard": {
    version: 1,
    vendor: "supaschema",
    validate(value: unknown) {
      if (value === undefined) {
        return { value };
      }
      if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
        return { value };
      }
      return { issues: [{ message: "keywords must be a list of strings" }] };
    },
  },
};

export default {
  title: "Supaschema",
  description:
    "Declarative PostgreSQL schema management with replay-safe migrations and generated TypeScript and Zod contracts.",
  content: {
    root: ".",
  },
  frontmatter: {
    extend: {
      keywords: optionalKeywordList,
    },
  },
  logo: {
    image: {
      alt: "supaschema",
      dark: "/images/brand/supaschema-logo-dark.png",
      light: "/images/brand/supaschema-logo-light.png",
    },
    text: "",
  },
  seo: {
    og: {
      image: "/images/brand/og-background.png",
    },
  },
  github: {
    owner: "jmclaughlin724",
    repo: "supaschema",
  },
  agents: {
    mcp: {
      enabled: true,
      name: "supaschema-docs",
      route: "/docs/mcp",
    },
  },
  deployment: cloudflare({ site: "https://supaschema.com" }),
  redirects: [
    { from: "/", to: "/introduction" },
    { from: "/docs", to: "/introduction" },
    { from: "/docs/commands", to: "/commands" },
    { from: "/commands/other", to: "/commands/plan" },
    { from: "/docs/commands/other", to: "/commands/plan" },
    { from: "/docs/config", to: "/configuration/config-file" },
    { from: "/docs/hints", to: "/configuration/hints" },
    { from: "/docs/diagnostics", to: "/reference/diagnostics" },
    { from: "/docs/support-matrix", to: "/reference/support-matrix" },
    { from: "/docs/whats-included", to: "/whats-included" },
    { from: "/docs/ci", to: "/guides/ci-github-actions" },
    { from: "/docs/ci-gate", to: "/guides/ci-gate" },
    { from: "/docs/corpus", to: "/guides/corpus-oracle" },
    { from: "/docs/case-study-anilize", to: "/case-study-anilize" },
    { from: "/docs/release", to: "/release" },
    { from: "/index", to: "/introduction" },
    { from: "/agents", to: "/coding-agents" },
    { from: "/ai-agents", to: "/coding-agents" },
    { from: "/compare", to: "/comparisons/supaschema-vs-supabase-cli" },
    { from: "/supaschema-vs-supabase-cli", to: "/comparisons/supaschema-vs-supabase-cli" },
    {
      from: "/atlas-migrate-lint-paid-alternatives",
      to: "/comparisons/atlas-migrate-lint-paid-alternatives",
    },
    { from: "/supaschema-vs-atlas", to: "/comparisons/supaschema-vs-atlas" },
    { from: "/supaschema-vs-prisma", to: "/comparisons/supaschema-vs-prisma" },
    { from: "/supaschema-vs-drizzle", to: "/comparisons/supaschema-vs-drizzle" },
    { from: "/supaschema-vs-squawk", to: "/comparisons/supaschema-vs-squawk" },
    { from: "/supaschema-vs-pgfence", to: "/comparisons/supaschema-vs-pgfence" },
    { from: "/supaschema-vs-flyway", to: "/comparisons/supaschema-vs-flyway" },
    { from: "/supaschema-vs-liquibase", to: "/comparisons/supaschema-vs-liquibase" },
    { from: "/concepts", to: "/concepts/declarative-schema" },
    { from: "/guides/type-generation", to: "/guides/generate-supabase-types-without-database" },
    { from: "/types", to: "/commands/types" },
    { from: "/supabase-db-diff-without-docker", to: "/guides/supabase-db-diff-without-docker" },
    {
      from: "/declarative-postgres-schema-management",
      to: "/guides/declarative-postgres-schema-management",
    },
    { from: "/idempotent-postgres-migrations", to: "/guides/idempotent-postgres-migrations" },
    { from: "/rls-policy-migration-safety", to: "/guides/rls-policy-migration-safety" },
    { from: "/guides/destructive-changes", to: "/configuration/hints" },
    { from: "/docs/:slug*", to: "/:slug*" },
  ],
};
