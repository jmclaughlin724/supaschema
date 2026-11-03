import { chmodSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { check } from "../../../scripts/guards/code-shape/check-canonical-surfaces.mts";
import { tempGuardRepo } from "../fixture.js";

const packageJson = (scripts: Record<string, string> = {}) =>
  `${JSON.stringify({ scripts, type: "module" })}\n`;

describe("canonical surfaces guard", () => {
  it("blocks recursive force deletion in package scripts", async () => {
    const root = tempGuardRepo({ "package.json": packageJson({ clean: "rm -rf dist" }) });
    await expect(check(root)).rejects.toThrow("package script clean uses recursive force deletion");
  });

  it.each(["install", "postinstall", "preinstall", "prepare"])(
    "blocks public package lifecycle script %s",
    async (script) => {
      const root = tempGuardRepo({
        "package.json": packageJson({ [script]: "node scripts/check.mjs" }),
        "scripts/check.mjs": "process.stdout.write('ok\\n');\n",
      });
      await expect(check(root)).rejects.toThrow(
        `package script ${script} is a public install lifecycle`
      );
    }
  );

  it("blocks comments in code files", async () => {
    const root = tempGuardRepo({ "src/commented.ts": "const value = 1;\n// explain elsewhere\n" });
    await expect(check(root)).rejects.toThrow("contains a line comment");
  });

  it("blocks regular expression engines in code files", async () => {
    const root = tempGuardRepo({
      "scripts/pattern.mjs": "const pattern = new RegExp('x');\npattern.test('x');\n",
    });
    await expect(check(root)).rejects.toThrow("contains pattern-engine syntax");
  });

  it("does not let a local ast-grep binary affect pattern checks", async () => {
    const root = tempGuardRepo({
      "node_modules/.bin/ast-grep":
        "#!/usr/bin/env node\nprocess.stdout.write('src/clean.ts:1:1 contains pattern-engine syntax\\n');\n",
      "src/clean.ts": "export const value = 1;\n",
    });
    chmodSync(join(root, "node_modules/.bin/ast-grep"), 0o755);
    await expect(check(root)).resolves.toBeUndefined();
  });

  it("blocks TypeScript assertions in code files", async () => {
    const root = tempGuardRepo({
      "src/assertion.ts":
        "const raw: unknown = {};\nexport const value = raw as { ok: boolean };\n",
    });
    await expect(check(root)).rejects.toThrow("contains a TypeScript assertion");
  });

  it("blocks inline zod enum tuples in code files", async () => {
    const root = tempGuardRepo({
      "src/schema.ts": "import { z } from 'zod';\nexport const schema = z.enum(['a', 'b']);\n",
    });
    await expect(check(root)).rejects.toThrow("contains an inline z.enum tuple");
  });

  it("blocks regex-shaped string contracts in code files", async () => {
    const groupStart = ["(", "?", ":"].join("");
    const pattern = ["^", groupStart, "dir:.+", "|empty:", ")", "$"].join("");
    const root = tempGuardRepo({
      "src/source-contract.ts": `export const sourceSpecPattern = ${JSON.stringify(pattern)};\n`,
    });
    await expect(check(root)).rejects.toThrow("contains a regex-shaped string contract");
  });

  it("blocks comments and regular expression engines in skill reference code", async () => {
    const root = tempGuardRepo({
      ".agents/skills/research/references/workflow.js":
        "const value = 1;\n// generated mirror must stay clean\n",
      ".claude/skills/research/references/workflow.js": "const value = /x/;\n",
    });
    const message = await errorMessage(check(root));
    expect(message).toContain(".claude/skills/research/references/workflow.js");
    expect(message).toContain("pattern-engine syntax");
    expect(message).toContain(".agents/skills/research/references/workflow.js");
    expect(message).toContain("line comment");
  });

  it("blocks DTO facade and view-model code surfaces", async () => {
    const root = tempGuardRepo({
      "src/account-dto.ts": "export const value = 1;\n",
      "src/profile-facade.ts": "export const value = 1;\n",
      "src/user-view-model.ts": "export const value = 1;\n",
    });
    const message = await errorMessage(check(root));
    expect(message).toContain("account-dto.ts");
    expect(message).toContain("profile-facade.ts");
    expect(message).toContain("user-view-model.ts");
  });

  it("blocks public Stripe checkout implementation", async () => {
    const root = tempGuardRepo({
      "src/marketplace.ts":
        "export const endpoint = 'https://api.stripe.com/v1/checkout/sessions';\n",
    });
    await expect(check(root)).rejects.toThrow("contains monetization term");
  });

  it("blocks public GitHub Marketplace billing implementation", async () => {
    const root = tempGuardRepo({
      "src/billing.ts": "export const event = 'marketplace_purchase';\n",
    });
    await expect(check(root)).rejects.toThrow("contains monetization term marketplace_purchase");
  });

  it("blocks public license issuance implementation", async () => {
    const root = tempGuardRepo({
      "src/license.ts": "export const secret = 'SUPASCHEMA_LICENSE_PRIVATE_KEY';\n",
    });
    await expect(check(root)).rejects.toThrow(
      "contains monetization term SUPASCHEMA_LICENSE_PRIVATE_KEY"
    );
  });

  it("allows monetization terms inside the tracked license worker", {
    timeout: 20_000,
  }, async () => {
    const root = tempGuardRepo({
      "services/license-worker/src/checkout.ts":
        "export const endpoint = 'https://api.stripe.com/v1/checkout/sessions';\n",
    });
    await expect(check(root)).resolves.toBeUndefined();
  });

  it("allows monetization terms inside the tracked stripe catalog tooling", {
    timeout: 20_000,
  }, async () => {
    const root = tempGuardRepo({
      "scripts/stripe/create-catalog.mts":
        "export const endpoint = 'https://api.stripe.com/v1/products';\n",
    });
    await expect(check(root)).resolves.toBeUndefined();
  });

  it("allows package scripts without recursive force deletion", async () => {
    const root = tempGuardRepo({
      "package.json": packageJson({ lint: "node scripts/check.mjs" }),
      "scripts/check.mjs": "process.stdout.write('ok\\n');\n",
    });
    await expect(check(root)).resolves.toBeUndefined();
  });
});

async function errorMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (failure) {
    return failure instanceof Error ? failure.message : String(failure);
  }
  return "";
}
