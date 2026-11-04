import { createHmac, createPublicKey, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parsePlanCatalog,
  successUrlWithSessionId,
} from "../../services/license-worker/src/checkout.js";
import {
  createOAuthState,
  verifyOAuthState,
} from "../../services/license-worker/src/github-oauth.js";
import {
  handleLicenseWorker,
  type LicenseWorkerEnv,
} from "../../services/license-worker/src/index.js";
import {
  isEntitled,
  issueLicenseToken,
  licenseClaimsFor,
  licenseClaimsThrough,
  verifyLicenseToken,
} from "../../services/license-worker/src/issue.js";
import {
  consumeOAuthState,
  type OAuthStateNamespace,
} from "../../services/license-worker/src/oauth-state.js";
import { createMemoryStore } from "../../services/license-worker/src/store.js";
import {
  coordinatedSubscriptionLicense,
  coordinateSubscriptionRenewal,
  type RenewalOutcome,
  type SubscriptionRenewalCoordinatorStore,
  type SubscriptionRenewalCoordinatorTransaction,
  type SubscriptionRenewalNamespace,
} from "../../services/license-worker/src/subscription-renewal.js";

const webhookSecret = "whsec_test_secret";
const { privateKey } = generateKeyPairSync("ed25519");
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const licensePublicKeyPem = createPublicKey(privateKey)
  .export({ format: "pem", type: "spki" })
  .toString();

function testEnv(): LicenseWorkerEnv {
  let env: LicenseWorkerEnv;
  env = {
    CHECKOUT_CANCEL_URL: "https://supaschema.com/pricing",
    CHECKOUT_SUCCESS_URL: "https://supaschema.com/license",
    CONTRACT_KV: createMemoryStore(),
    GITHUB_OAUTH_CLIENT_ID: "github-oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "github-oauth-client-secret",
    LICENSE_KV: createMemoryStore(),
    OAUTH_STATES: createMemoryOAuthStates(),
    STRIPE_PRICE_MAP: JSON.stringify({
      bundle: { mode: "payment", price: "price_payment" },
      pro: { mode: "subscription", price: "price_subscription" },
    }),
    STRIPE_SECRET_KEY: "sk_test_secret",
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    SUBSCRIPTION_RENEWALS: createMemorySubscriptionRenewals(() => env),
    SUPASCHEMA_LICENSE_PRIVATE_KEY: privateKeyPem,
  };
  return env;
}

function createMemoryOAuthStates(): OAuthStateNamespace {
  const stores = new Map<string, MemorySubscriptionRenewalStore>();
  return {
    getByName: (nonce) => {
      const coordinator = stores.get(nonce) ?? new MemorySubscriptionRenewalStore();
      stores.set(nonce, coordinator);
      return {
        consume: (expiresAt, stateNowSeconds) =>
          consumeOAuthState(coordinator, expiresAt, stateNowSeconds),
      };
    },
  };
}

class MemorySubscriptionRenewalStore
  implements SubscriptionRenewalCoordinatorStore, SubscriptionRenewalCoordinatorTransaction
{
  private readonly values = new Map<string, unknown>();

  private transactionTail: Promise<void> = Promise.resolve();

  scheduledAlarm: number | undefined;

  get(key: string): Promise<unknown | undefined> {
    return Promise.resolve(this.values.get(key));
  }

  put(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }

  setAlarm(scheduledTime: number): Promise<void> {
    this.scheduledAlarm = scheduledTime;
    return Promise.resolve();
  }

  async transaction<T>(
    callback: (transaction: SubscriptionRenewalCoordinatorTransaction) => Promise<T>
  ): Promise<T> {
    const preceding = this.transactionTail;
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.transactionTail = preceding.then(
      () => current,
      () => current
    );
    await preceding;
    try {
      return await callback(this);
    } finally {
      release?.();
    }
  }
}

function createMemorySubscriptionRenewals(
  env: () => LicenseWorkerEnv
): SubscriptionRenewalNamespace {
  const stores = new Map<string, MemorySubscriptionRenewalStore>();
  return {
    getByName: (coordinatorId) => {
      const coordinator = stores.get(coordinatorId) ?? new MemorySubscriptionRenewalStore();
      stores.set(coordinatorId, coordinator);
      return {
        license: (routedSubscriptionId, sessionId) =>
          coordinatedSubscriptionLicense(
            coordinator,
            env().LICENSE_KV,
            routedSubscriptionId,
            sessionId
          ),
        renew: (routedSubscriptionId, renewal, renewalNowSeconds): Promise<RenewalOutcome> =>
          coordinateSubscriptionRenewal(
            coordinator,
            env().LICENSE_KV,
            privateKey,
            routedSubscriptionId,
            renewal,
            renewalNowSeconds
          ),
      };
    },
  };
}

function signedWebhookRequest(event: unknown, nowSeconds: number): Request {
  const rawBody = JSON.stringify(event);
  const signature = createHmac("sha256", webhookSecret)
    .update(`${nowSeconds}.${rawBody}`)
    .digest("hex");
  return new Request("https://license.workers.dev/webhook", {
    body: rawBody,
    headers: { "stripe-signature": `t=${nowSeconds},v1=${signature}` },
    method: "POST",
  });
}

async function retrieveLicenseToken(
  env: LicenseWorkerEnv,
  sessionId = "cs_test_123"
): Promise<string> {
  const response = await handleLicenseWorker(
    new Request(`https://license.workers.dev/license?session_id=${sessionId}`),
    env,
    { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
    nowSeconds,
    fakeFetch
  );
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) {
    throw new Error("expected a license response");
  }
  const token = Reflect.get(body, "license");
  if (typeof token !== "string") {
    throw new Error("expected a license token");
  }
  return token;
}

function completionEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      object: {
        id: "cs_test_123",
        metadata: { plan: "bundle", repo: "acme/app" },
        payment_status: "paid",
        ...overrides,
      },
    },
    type: "checkout.session.completed",
  };
}

const nowSeconds = 1_800_000_000;
const fakeFetch: typeof fetch = () =>
  Promise.reject(new Error("unexpected external fetch in test"));

function subscriptionFetch(
  priceId: string,
  paidThrough: number,
  duplicateMatchingItem = false
): typeof fetch {
  return (input) => {
    const url = String(input);
    if (!url.startsWith("https://api.stripe.com/v1/subscriptions/")) {
      return Promise.reject(new Error(`unexpected external fetch in test: ${url}`));
    }
    const item = { current_period_end: paidThrough, price: { id: priceId } };
    return Promise.resolve(
      new Response(
        JSON.stringify({ items: { data: duplicateMatchingItem ? [item, item] : [item] } }),
        { status: 200 }
      )
    );
  };
}

function invoicePaidEvent(
  invoiceId: string,
  subscriptionId: string,
  priceId: string,
  paidThrough: number
) {
  return {
    data: {
      object: {
        billing_reason: "subscription_cycle",
        id: invoiceId,
        lines: { data: [{ period: { end: paidThrough }, price: { id: priceId } }] },
        subscription: subscriptionId,
      },
    },
    type: "invoice.paid",
  };
}

const basilInvoicePaid: {
  api_version: string;
  data: {
    object: {
      lines: {
        data: Array<{
          parent: { subscription_item_details: { subscription: string } };
          period: { end: number };
          pricing: { price_details: { price: string } };
        }>;
      };
      parent: { subscription_details: { subscription: string } };
    };
  };
} = JSON.parse(
  readFileSync(new URL("./fixtures/invoice-paid.basil.json", import.meta.url), "utf8")
);

describe("successUrlWithSessionId", () => {
  it("inserts the session query before any URL fragment", () => {
    expect(successUrlWithSessionId("https://example.com/license#status")).toBe(
      "https://example.com/license?session_id={CHECKOUT_SESSION_ID}#status"
    );
    expect(successUrlWithSessionId("https://example.com/license?ref=nav#status")).toBe(
      "https://example.com/license?ref=nav&session_id={CHECKOUT_SESSION_ID}#status"
    );
    expect(successUrlWithSessionId("https://example.com/license")).toBe(
      "https://example.com/license?session_id={CHECKOUT_SESSION_ID}"
    );
  });
});

describe("parsePlanCatalog", () => {
  it("reserves fixed entitlement days for one-time payment plans", () => {
    expect(() =>
      parsePlanCatalog(
        JSON.stringify({
          pro: { intervalDays: 30, mode: "subscription", price: "price_monthly" },
        })
      )
    ).toThrow("intervalDays is only valid for one-time payment plans");
  });
});

describe("canonicalRepo entitlement", () => {
  it("matches GitHub repo identifiers case-insensitively", () => {
    const claims = licenseClaimsFor("Jmclaughlin724/Anilize", "pro", nowSeconds);
    expect(claims.repo).toBe("jmclaughlin724/anilize");
    expect(isEntitled(claims, "JMCLAUGHLIN724/ANILIZE", nowSeconds)).toBe(true);
    expect(isEntitled(claims, "jmclaughlin724/anilize", nowSeconds)).toBe(true);
    expect(isEntitled(claims, "jmclaughlin724/other", nowSeconds)).toBe(false);
  });
});

describe("license worker", () => {
  it("serves /license with CORS scoped to the success origin", async () => {
    const env = testEnv();
    const response = await handleLicenseWorker(
      new Request("https://license.workers.dev/license?session_id=cs_test_none"),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      fakeFetch
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://supaschema.com");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const preflight = await handleLicenseWorker(
      new Request("https://license.workers.dev/license", { method: "OPTIONS" }),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      fakeFetch
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://supaschema.com");
  });

  it("serves verified one-time tokens and rejects a tampered direct token", async () => {
    const env = testEnv();
    const paymentToken = issueLicenseToken(
      licenseClaimsFor("acme/app", "bundle", nowSeconds),
      privateKey
    );
    await env.LICENSE_KV.put("cs_payment", paymentToken);

    const paymentResponse = await handleLicenseWorker(
      new Request("https://license.workers.dev/license?session_id=cs_payment"),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      fakeFetch
    );
    expect(paymentResponse.status).toBe(200);
    expect(await paymentResponse.json()).toEqual({ license: paymentToken });

    await env.LICENSE_KV.put("cs_payment", `${paymentToken}tampered`);
    const tamperedResponse = await handleLicenseWorker(
      new Request("https://license.workers.dev/license?session_id=cs_payment"),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      fakeFetch
    );
    expect(tamperedResponse.status).toBe(503);
  });

  it("issues on async_payment_succeeded and ignores unpaid completions", async () => {
    const env = testEnv();
    const unpaid = await handleLicenseWorker(
      signedWebhookRequest(
        {
          data: {
            object: {
              id: "cs_test_unpaid",
              metadata: { plan: "bundle", repo: "acme/app" },
              payment_status: "unpaid",
            },
          },
          type: "checkout.session.completed",
        },
        nowSeconds
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      fakeFetch
    );
    expect(await unpaid.json()).toEqual({ ignored: true });
    expect(await env.LICENSE_KV.get("cs_test_unpaid")).toBeNull();

    const asyncPaid = await handleLicenseWorker(
      signedWebhookRequest(
        { ...completionEvent(), type: "checkout.session.async_payment_succeeded" },
        nowSeconds
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      fakeFetch
    );
    expect(await asyncPaid.json()).toEqual({ issued: true, repo: "acme/app" });
    expect(await env.LICENSE_KV.get("cs_test_123")).not.toBeNull();
  });

  it("rejects internal storage keys as license retrieval session ids", async () => {
    const env = testEnv();
    await env.LICENSE_KV.put(
      "subscription:sub_123",
      JSON.stringify({ plan: "pro", repo: "acme/app", sessionId: "cs_test_123" })
    );

    const response = await handleLicenseWorker(
      new Request("https://worker.test/license?session_id=subscription:sub_123"),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      fakeFetch
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe("invalid session_id");
  });

  it("stores contracts under the canonical repository casing", async () => {
    const env = testEnv();
    const token = issueLicenseToken(licenseClaimsFor("Acme/App", "pro", nowSeconds), privateKey);
    const put = await handleLicenseWorker(
      new Request("https://worker.test/contracts?repo=Acme/App&name=schema", {
        body: JSON.stringify({ schemas: {} }),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        method: "PUT",
      }),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      fakeFetch
    );

    expect(await put.json()).toEqual({ stored: true });
    expect(await env.CONTRACT_KV.get("contract:acme/app:schema")).not.toBeNull();
  });

  it("repairs a missing subscription record on a webhook retry", async () => {
    const env = testEnv();
    const paidThrough = nowSeconds + 2_700_000;
    await env.LICENSE_KV.put(
      "cs_test_123",
      issueLicenseToken(licenseClaimsThrough("acme/app", "pro", paidThrough), privateKey)
    );

    const response = await handleLicenseWorker(
      signedWebhookRequest(
        completionEvent({
          metadata: { plan: "pro", repo: "acme/app" },
          subscription: "sub_123",
        }),
        nowSeconds
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      subscriptionFetch("price_subscription", paidThrough)
    );

    expect(await response.json()).toEqual({ idempotent: true, issued: true });
    const rawRecord = await env.LICENSE_KV.get("subscription:sub_123");
    if (rawRecord === null) {
      throw new Error("expected subscription record to be repaired");
    }
    expect(JSON.parse(rawRecord)).toMatchObject({
      paidThrough,
      plan: "pro",
      priceId: "price_subscription",
      repo: "acme/app",
      sessionId: "cs_test_123",
    });
  });

  it("keeps an initializing subscription license in the pending state", async () => {
    const env = testEnv();
    await env.LICENSE_KV.put(
      "subscription:sub_123",
      JSON.stringify({
        paidThrough: nowSeconds + 2_700_000,
        plan: "pro",
        priceId: "price_subscription",
        repo: "acme/app",
        sessionId: "cs_test_123",
      })
    );

    const response = await handleLicenseWorker(
      new Request("https://license.workers.dev/license?session_id=cs_test_123"),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      fakeFetch
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ pending: true });
  });

  it("matches subscription token expiry to Stripe's paid-through boundaries", async () => {
    const env = testEnv();
    env.STRIPE_PRICE_MAP = JSON.stringify({
      pro: { mode: "subscription", price: "price_monthly" },
    });
    const initialPaidThrough = nowSeconds + 31 * 24 * 60 * 60;

    const completion = await handleLicenseWorker(
      signedWebhookRequest(
        completionEvent({
          metadata: { plan: "pro", repo: "acme/app" },
          subscription: "sub_monthly",
        }),
        nowSeconds
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      subscriptionFetch("price_monthly", initialPaidThrough)
    );
    expect(await completion.json()).toEqual({ issued: true, repo: "acme/app" });

    const publicKeyPem = createPublicKey(privateKey)
      .export({ format: "pem", type: "spki" })
      .toString();
    const issued = await env.LICENSE_KV.get("cs_test_123");
    if (issued === null) {
      throw new Error("expected a minted token");
    }
    const claims = verifyLicenseToken(issued, publicKeyPem);
    expect(claims?.exp).toBe(initialPaidThrough);

    const renewedPaidThrough = initialPaidThrough + 28 * 24 * 60 * 60;
    const renewalEvent = invoicePaidEvent(
      "in_renew_monthly",
      "sub_monthly",
      "price_monthly",
      renewedPaidThrough
    );
    const renewal = await handleLicenseWorker(
      signedWebhookRequest(renewalEvent, nowSeconds),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      fakeFetch
    );
    expect(await renewal.json()).toEqual({ renewed: true, repo: "acme/app" });
    const renewed = await retrieveLicenseToken(env);
    expect(verifyLicenseToken(renewed, publicKeyPem)?.exp).toBe(renewedPaidThrough);

    const replay = await handleLicenseWorker(
      signedWebhookRequest(renewalEvent, nowSeconds + 10_000),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds + 10_000,
      fakeFetch
    );
    expect(await replay.json()).toEqual({ idempotent: true, renewed: true });
    expect(await retrieveLicenseToken(env)).toBe(renewed);

    const stale = await handleLicenseWorker(
      signedWebhookRequest(
        invoicePaidEvent("in_stale_monthly", "sub_monthly", "price_monthly", initialPaidThrough),
        nowSeconds + 20_000
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds + 20_000,
      fakeFetch
    );
    expect(await stale.json()).toEqual({ ignored: true });
    expect(await retrieveLicenseToken(env)).toBe(renewed);
  });

  it("serializes overlapping renewals without regressing the paid-through period", async () => {
    const env = testEnv();
    const initialPaidThrough = nowSeconds + 2_700_000;
    await handleLicenseWorker(
      signedWebhookRequest(
        completionEvent({
          metadata: { plan: "pro", repo: "acme/app" },
          subscription: "sub_123",
        }),
        nowSeconds
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      subscriptionFetch("price_subscription", initialPaidThrough)
    );

    const newerPaidThrough = initialPaidThrough + 5_400_000;
    const olderPaidThrough = initialPaidThrough + 2_700_000;
    const responses = await Promise.all([
      handleLicenseWorker(
        signedWebhookRequest(
          invoicePaidEvent("in_newer", "sub_123", "price_subscription", newerPaidThrough),
          nowSeconds + 100
        ),
        env,
        { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
        nowSeconds + 100,
        fakeFetch
      ),
      handleLicenseWorker(
        signedWebhookRequest(
          invoicePaidEvent("in_older", "sub_123", "price_subscription", olderPaidThrough),
          nowSeconds + 100
        ),
        env,
        { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
        nowSeconds + 100,
        fakeFetch
      ),
    ]);
    expect(responses.every((response) => response.ok)).toBe(true);

    const publicKeyPem = createPublicKey(privateKey)
      .export({ format: "pem", type: "spki" })
      .toString();
    expect(verifyLicenseToken(await retrieveLicenseToken(env), publicKeyPem)?.exp).toBe(
      newerPaidThrough
    );
  });

  it("routes renewed legacy subscriptions through their original session", async () => {
    const env = testEnv();
    const initialPaidThrough = nowSeconds + 2_700_000;
    await env.LICENSE_KV.put(
      "subscription:sub_legacy",
      JSON.stringify({
        paidThrough: initialPaidThrough,
        plan: "pro",
        priceId: "price_subscription",
        repo: "acme/app",
        sessionId: "cs_legacy",
      })
    );
    const legacyToken = issueLicenseToken(
      licenseClaimsThrough("acme/app", "pro", initialPaidThrough),
      privateKey
    );
    await env.LICENSE_KV.put("cs_legacy", legacyToken);

    expect(await retrieveLicenseToken(env, "cs_legacy")).toBe(legacyToken);

    const renewedPaidThrough = initialPaidThrough + 2_700_000;
    const renewal = await handleLicenseWorker(
      signedWebhookRequest(
        invoicePaidEvent("in_legacy", "sub_legacy", "price_subscription", renewedPaidThrough),
        nowSeconds + 100
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds + 100,
      fakeFetch
    );

    expect(renewal.status).toBe(200);
    const publicKeyPem = createPublicKey(privateKey)
      .export({ format: "pem", type: "spki" })
      .toString();
    expect(
      verifyLicenseToken(await retrieveLicenseToken(env, "cs_legacy"), publicKeyPem)?.exp
    ).toBe(renewedPaidThrough);
  });

  it("preserves the maximum verified legacy token and record paid-through", async () => {
    const firstPaidThrough = nowSeconds + 2_700_000;
    const middlePaidThrough = firstPaidThrough + 2_700_000;
    const lastPaidThrough = middlePaidThrough + 2_700_000;
    const cases = [
      {
        recordPaidThrough: firstPaidThrough,
        sessionId: "cs_token_later",
        subscriptionId: "sub_token_later",
        tokenPaidThrough: lastPaidThrough,
      },
      {
        recordPaidThrough: lastPaidThrough,
        sessionId: "cs_record_later",
        subscriptionId: "sub_record_later",
        tokenPaidThrough: firstPaidThrough,
      },
    ];

    for (const legacy of cases) {
      const env = testEnv();
      await env.LICENSE_KV.put(
        `subscription:${legacy.subscriptionId}`,
        JSON.stringify({
          paidThrough: legacy.recordPaidThrough,
          plan: "pro",
          priceId: "price_subscription",
          repo: "acme/app",
          sessionId: legacy.sessionId,
        })
      );
      await env.LICENSE_KV.put(
        legacy.sessionId,
        issueLicenseToken(
          licenseClaimsThrough("acme/app", "pro", legacy.tokenPaidThrough),
          privateKey
        )
      );

      const renewal = await handleLicenseWorker(
        signedWebhookRequest(
          invoicePaidEvent(
            `in_${legacy.subscriptionId}`,
            legacy.subscriptionId,
            "price_subscription",
            middlePaidThrough
          ),
          nowSeconds + 100
        ),
        env,
        { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
        nowSeconds + 100,
        fakeFetch
      );

      expect(await renewal.json()).toEqual({ ignored: true });
      expect(
        verifyLicenseToken(await retrieveLicenseToken(env, legacy.sessionId), licensePublicKeyPem)
          ?.exp
      ).toBe(lastPaidThrough);
    }
  });

  it("merges a newer verified direct token into existing coordinated state", async () => {
    const env = testEnv();
    const initialPaidThrough = nowSeconds + 2_700_000;
    await handleLicenseWorker(
      signedWebhookRequest(
        completionEvent({
          metadata: { plan: "pro", repo: "acme/app" },
          subscription: "sub_diverged",
        }),
        nowSeconds
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      subscriptionFetch("price_subscription", initialPaidThrough)
    );

    const coordinatedPaidThrough = initialPaidThrough + 2_700_000;
    const coordinatedRenewal = await handleLicenseWorker(
      signedWebhookRequest(
        invoicePaidEvent(
          "in_coordinated",
          "sub_diverged",
          "price_subscription",
          coordinatedPaidThrough
        ),
        nowSeconds + 100
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds + 100,
      fakeFetch
    );
    expect(coordinatedRenewal.status).toBe(200);

    const directPaidThrough = coordinatedPaidThrough + 2_700_000;
    await env.LICENSE_KV.put(
      "subscription:sub_diverged",
      JSON.stringify({
        lastInvoiceId: "in_direct",
        paidThrough: directPaidThrough,
        plan: "pro",
        priceId: "price_subscription",
        repo: "acme/app",
        sessionId: "cs_test_123",
      })
    );
    await env.LICENSE_KV.put(
      "cs_test_123",
      issueLicenseToken(licenseClaimsThrough("acme/app", "pro", directPaidThrough), privateKey)
    );
    expect(verifyLicenseToken(await retrieveLicenseToken(env), licensePublicKeyPem)?.exp).toBe(
      directPaidThrough
    );

    const staleRenewal = await handleLicenseWorker(
      signedWebhookRequest(
        invoicePaidEvent(
          "in_between",
          "sub_diverged",
          "price_subscription",
          coordinatedPaidThrough + 1_350_000
        ),
        nowSeconds + 200
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds + 200,
      fakeFetch
    );
    expect(await staleRenewal.json()).toEqual({ ignored: true });
    expect(verifyLicenseToken(await retrieveLicenseToken(env), licensePublicKeyPem)?.exp).toBe(
      directPaidThrough
    );
  });

  it("rejects forged or identity-mismatched tokens during legacy migration", async () => {
    const initialPaidThrough = nowSeconds + 2_700_000;
    const forgedPaidThrough = initialPaidThrough + 5_400_000;
    const validToken = issueLicenseToken(
      licenseClaimsThrough("acme/app", "pro", initialPaidThrough),
      privateKey
    );
    const [header, , signature] = validToken.split(".");
    if (header === undefined || signature === undefined) {
      throw new Error("expected a three-part signed token");
    }
    const forgedPayload = Buffer.from(
      JSON.stringify(licenseClaimsThrough("acme/app", "pro", forgedPaidThrough))
    ).toString("base64url");
    const cases = [
      {
        exerciseRetrieval: true,
        sessionId: "cs_forged",
        token: `${header}.${forgedPayload}.${signature}`,
      },
      {
        exerciseRetrieval: false,
        sessionId: "cs_mismatched",
        token: issueLicenseToken(
          licenseClaimsThrough("other/repo", "pro", forgedPaidThrough),
          privateKey
        ),
      },
      {
        exerciseRetrieval: false,
        sessionId: "cs_wrong_plan",
        token: issueLicenseToken(
          licenseClaimsThrough("acme/app", "bundle", forgedPaidThrough),
          privateKey
        ),
      },
    ];
    const retrievalStatuses: [string, number][] = [];

    for (const legacy of cases) {
      const env = testEnv();
      const subscriptionId = `sub_${legacy.sessionId}`;
      await env.LICENSE_KV.put(
        `subscription:${subscriptionId}`,
        JSON.stringify({
          paidThrough: initialPaidThrough,
          plan: "pro",
          priceId: "price_subscription",
          repo: "acme/app",
          sessionId: legacy.sessionId,
        })
      );
      await env.LICENSE_KV.put(legacy.sessionId, legacy.token);

      const renewal = await handleLicenseWorker(
        signedWebhookRequest(
          invoicePaidEvent(
            `in_${legacy.sessionId}`,
            subscriptionId,
            "price_subscription",
            initialPaidThrough + 2_700_000
          ),
          nowSeconds + 100
        ),
        env,
        { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
        nowSeconds + 100,
        fakeFetch
      );

      expect(renewal.status).toBe(503);
      expect(await env.LICENSE_KV.get(legacy.sessionId)).toBe(legacy.token);
      if (legacy.exerciseRetrieval) {
        const retrieval = await handleLicenseWorker(
          new Request(`https://license.workers.dev/license?session_id=${legacy.sessionId}`),
          env,
          { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
          nowSeconds,
          fakeFetch
        );
        retrievalStatuses.push([legacy.sessionId, retrieval.status]);
      }

      await env.LICENSE_KV.put(
        legacy.sessionId,
        issueLicenseToken(licenseClaimsThrough("acme/app", "pro", initialPaidThrough), privateKey)
      );
      const retry = await handleLicenseWorker(
        signedWebhookRequest(
          invoicePaidEvent(
            `in_retry_${legacy.sessionId}`,
            subscriptionId,
            "price_subscription",
            initialPaidThrough + 2_700_000
          ),
          nowSeconds + 200
        ),
        env,
        { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
        nowSeconds + 200,
        fakeFetch
      );
      expect(retry.status).toBe(200);
      expect(
        verifyLicenseToken(await retrieveLicenseToken(env, legacy.sessionId), licensePublicKeyPem)
          ?.exp
      ).toBe(initialPaidThrough + 2_700_000);
    }

    expect(retrievalStatuses).toEqual([["cs_forged", 503]]);
  });

  it("routes renewed subscriptions independently of reverse KV state", async () => {
    const env = testEnv();
    const initialPaidThrough = nowSeconds + 2_700_000;
    await handleLicenseWorker(
      signedWebhookRequest(
        completionEvent({
          metadata: { plan: "pro", repo: "acme/app" },
          subscription: "sub_routed",
        }),
        nowSeconds
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      subscriptionFetch("price_subscription", initialPaidThrough)
    );
    const renewedPaidThrough = initialPaidThrough + 2_700_000;
    const renewal = await handleLicenseWorker(
      signedWebhookRequest(
        invoicePaidEvent("in_routed", "sub_routed", "price_subscription", renewedPaidThrough),
        nowSeconds + 100
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds + 100,
      fakeFetch
    );
    expect(renewal.status).toBe(200);

    expect(await env.LICENSE_KV.get("subscription-session:cs_test_123")).toBeNull();
    expect(verifyLicenseToken(await retrieveLicenseToken(env), licensePublicKeyPem)?.exp).toBe(
      renewedPaidThrough
    );

    await env.LICENSE_KV.put("subscription-session:cs_test_123", "sub_stale");
    expect(verifyLicenseToken(await retrieveLicenseToken(env), licensePublicKeyPem)?.exp).toBe(
      renewedPaidThrough
    );
  });

  it("fails closed on missing or ambiguous subscription paid-through periods", async () => {
    const env = testEnv();
    const completionRequest = signedWebhookRequest(
      completionEvent({
        metadata: { plan: "pro", repo: "acme/app" },
        subscription: "sub_ambiguous",
      }),
      nowSeconds
    );
    const ambiguous = await handleLicenseWorker(
      completionRequest,
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      subscriptionFetch("price_subscription", nowSeconds + 2_700_000, true)
    );
    expect(ambiguous.status).toBe(500);
    expect(await env.LICENSE_KV.get("cs_test_123")).toBeNull();

    const initialPaidThrough = nowSeconds + 2_700_000;
    const validCompletion = await handleLicenseWorker(
      signedWebhookRequest(
        completionEvent({
          metadata: { plan: "pro", repo: "acme/app" },
          subscription: "sub_ambiguous",
        }),
        nowSeconds
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      subscriptionFetch("price_subscription", initialPaidThrough)
    );
    expect(validCompletion.status).toBe(200);

    const ambiguousInvoice = invoicePaidEvent(
      "in_ambiguous",
      "sub_ambiguous",
      "price_subscription",
      initialPaidThrough + 2_700_000
    );
    ambiguousInvoice.data.object.lines.data.push({
      period: { end: initialPaidThrough + 2_700_000 },
      price: { id: "price_subscription" },
    });
    const invalidRenewal = await handleLicenseWorker(
      signedWebhookRequest(ambiguousInvoice, nowSeconds + 100),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds + 100,
      fakeFetch
    );
    expect(invalidRenewal.status).toBe(500);
  });

  it("renews a subscription token from invoice.paid under the original session id", async () => {
    const env = testEnv();
    const initialPaidThrough = nowSeconds + 2_700_000;
    const completion = await handleLicenseWorker(
      signedWebhookRequest(
        completionEvent({
          metadata: { plan: "pro", repo: "acme/app" },
          subscription: "sub_123",
        }),
        nowSeconds
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      subscriptionFetch("price_subscription", initialPaidThrough)
    );
    expect(await completion.json()).toEqual({ issued: true, repo: "acme/app" });
    const original = await env.LICENSE_KV.get("cs_test_123");
    expect(original).not.toBeNull();

    const unknown = await handleLicenseWorker(
      signedWebhookRequest(
        invoicePaidEvent(
          "in_unknown",
          "sub_other",
          "price_subscription",
          initialPaidThrough + 2_700_000
        ),
        nowSeconds + 100
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds + 100,
      fakeFetch
    );
    expect(await unknown.json()).toEqual({ ignored: true });

    const renewal = await handleLicenseWorker(
      signedWebhookRequest(
        invoicePaidEvent("in_123", "sub_123", "price_subscription", initialPaidThrough + 2_700_000),
        nowSeconds + 100
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds + 100,
      fakeFetch
    );
    expect(await renewal.json()).toEqual({ renewed: true, repo: "acme/app" });
    const renewed = await retrieveLicenseToken(env);
    expect(renewed).not.toBe(original);
  });

  it("renews from the basil invoice parent subscription shape", async () => {
    expect(basilInvoicePaid.api_version).toBe("2025-03-31.basil");
    expect(basilInvoicePaid.data.object.parent.subscription_details.subscription).toBe("sub_123");
    expect(basilInvoicePaid.data.object.lines.data[0]?.period.end).toBe(1_805_270_400);
    const env = testEnv();
    const initialPaidThrough = nowSeconds + 2_700_000;
    await handleLicenseWorker(
      signedWebhookRequest(
        completionEvent({
          metadata: { plan: "pro", repo: "acme/app" },
          subscription: "sub_123",
        }),
        nowSeconds
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      subscriptionFetch("price_subscription", initialPaidThrough)
    );

    const renewal = await handleLicenseWorker(
      signedWebhookRequest(basilInvoicePaid, nowSeconds + 100),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds + 100,
      fakeFetch
    );
    expect(await renewal.json()).toEqual({ renewed: true, repo: "acme/app" });
    const renewed = await retrieveLicenseToken(env);
    const publicKeyPem = createPublicKey(privateKey)
      .export({ format: "pem", type: "spki" })
      .toString();
    expect(verifyLicenseToken(renewed, publicKeyPem)?.exp).toBe(1_805_270_400);
  });
});

describe("github oauth checkout flow", () => {
  function oauthFetch(permission: string, stripeBodies: string[]): typeof fetch {
    return (input, init) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return Promise.resolve(
          new Response(JSON.stringify({ access_token: "gho_test" }), { status: 200 })
        );
      }
      if (url === "https://api.github.com/user") {
        return Promise.resolve(new Response(JSON.stringify({ login: "buyer" }), { status: 200 }));
      }
      if (url === "https://api.github.com/repos/acme/app/collaborators/buyer/permission") {
        return Promise.resolve(new Response(JSON.stringify({ permission }), { status: 200 }));
      }
      if (url === "https://api.stripe.com/v1/checkout/sessions") {
        stripeBodies.push(String(init?.body ?? ""));
        return Promise.resolve(
          new Response(JSON.stringify({ url: "https://checkout.stripe.com/c/pay/cs_test_new" }), {
            status: 200,
          })
        );
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    };
  }

  function stateToken(repo: string, plan: string): string {
    return createOAuthState(repo, plan, nowSeconds, privateKey);
  }

  function callbackRequest(code: string, state: string): Request {
    return new Request(
      `https://license.workers.dev/auth/github/callback?code=${code}&state=${state}`,
      { headers: { cookie: `supaschema_oauth_state=${state}` } }
    );
  }

  it("redirects /checkout into GitHub OAuth with a signed state", async () => {
    const env = testEnv();
    const response = await handleLicenseWorker(
      new Request("https://license.workers.dev/checkout?repo=acme/app&plan=bundle"),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      fakeFetch
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://github.com");
    expect(location.pathname).toBe("/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe("github-oauth-client-id");
    expect(location.searchParams.get("redirect_uri")).toBe(
      "https://license.workers.dev/auth/github/callback"
    );
    expect(location.searchParams.get("scope")).toBeNull();
    const state = location.searchParams.get("state") ?? "";
    expect(response.headers.get("set-cookie")).toContain(
      `supaschema_oauth_state=${state}; HttpOnly; Max-Age=600`
    );
    expect(response.headers.get("set-cookie")).toContain("SameSite=Lax; Secure");
    const claims = verifyOAuthState(
      state,
      createPublicKey(privateKey).export({ format: "pem", type: "spki" }).toString(),
      nowSeconds + 1
    );
    expect(claims).toMatchObject({ plan: "bundle", repo: "acme/app" });

    const unauthorized = await handleLicenseWorker(
      new Request("https://license.workers.dev/contracts?repo=acme/app&name=state-token", {
        body: JSON.stringify({ schemas: {} }),
        headers: { authorization: `Bearer ${state}`, "content-type": "application/json" },
        method: "PUT",
      }),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds + 1,
      fakeFetch
    );
    expect(unauthorized.status).toBe(401);
    expect(await env.CONTRACT_KV.get("contract:acme/app:state-token")).toBeNull();
  });

  it("creates the Stripe session from the verified identity at the callback", async () => {
    const env = testEnv();
    const stripeBodies: string[] = [];
    const state = stateToken("acme/app", "bundle");
    const response = await handleLicenseWorker(
      callbackRequest("oauth-code", state),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      oauthFetch("admin", stripeBodies)
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://checkout.stripe.com/c/pay/cs_test_new");
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(stripeBodies).toHaveLength(1);
    expect(stripeBodies[0]).toContain("metadata%5Brepo%5D=acme%2Fapp");
    expect(stripeBodies[0]).toContain("metadata%5Bgithub_user%5D=buyer");
  });

  it("denies the callback without creating a Stripe session when permission is insufficient", async () => {
    const env = testEnv();
    const stripeBodies: string[] = [];
    const unboundState = stateToken("acme/app", "bundle");
    const unbound = await handleLicenseWorker(
      new Request(
        `https://license.workers.dev/auth/github/callback?code=oauth-code&state=${unboundState}`
      ),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      oauthFetch("admin", stripeBodies)
    );
    expect(unbound.status).toBe(400);
    expect(stripeBodies).toHaveLength(0);

    const deniedState = stateToken("acme/app", "bundle");
    const denied = await handleLicenseWorker(
      callbackRequest("oauth-code", deniedState),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      oauthFetch("none", stripeBodies)
    );
    expect(denied.status).toBe(403);
    expect(stripeBodies).toHaveLength(0);

    const tamperedState = `${stateToken("acme/app", "bundle")}tampered`;
    const tampered = await handleLicenseWorker(
      callbackRequest("oauth-code", tamperedState),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      oauthFetch("admin", stripeBodies)
    );
    expect(tampered.status).toBe(400);
    expect(stripeBodies).toHaveLength(0);
  });

  it("rejects a replayed state token and survives a non-JSON exchange response", async () => {
    const env = testEnv();
    const stripeBodies: string[] = [];
    const callbackState = stateToken("acme/app", "bundle");

    const first = await handleLicenseWorker(
      callbackRequest("oauth-code", callbackState),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      oauthFetch("admin", stripeBodies)
    );
    expect(first.status).toBe(302);
    expect(stripeBodies).toHaveLength(1);

    const replay = await handleLicenseWorker(
      callbackRequest("oauth-code", callbackState),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds,
      oauthFetch("admin", stripeBodies)
    );
    expect(replay.status).toBe(400);
    expect(await replay.text()).toBe("state already used");
    expect(stripeBodies).toHaveLength(1);

    const malformedFetch: typeof fetch = (input) => {
      const url = String(input);
      if (url === "https://github.com/login/oauth/access_token") {
        return Promise.resolve(new Response("not json", { status: 200 }));
      }
      return Promise.resolve(new Response("not found", { status: 404 }));
    };
    const malformedState = stateToken("acme/app", "pro");
    const malformed = await handleLicenseWorker(
      callbackRequest("other-code", malformedState),
      env,
      { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
      nowSeconds + 100,
      malformedFetch
    );
    expect(malformed.status).toBe(502);
    expect(stripeBodies).toHaveLength(1);
  });

  it("atomically consumes a state before concurrent callbacks create checkout sessions", async () => {
    const env = testEnv();
    const stripeBodies: string[] = [];
    const callbackState = stateToken("acme/app", "bundle");

    const responses = await Promise.all([
      handleLicenseWorker(
        callbackRequest("oauth-code-one", callbackState),
        env,
        { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
        nowSeconds,
        oauthFetch("admin", stripeBodies)
      ),
      handleLicenseWorker(
        callbackRequest("oauth-code-two", callbackState),
        env,
        { contracts: env.CONTRACT_KV, licenses: env.LICENSE_KV },
        nowSeconds,
        oauthFetch("admin", stripeBodies)
      ),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([302, 400]);
    expect(stripeBodies).toHaveLength(1);
  });
});
