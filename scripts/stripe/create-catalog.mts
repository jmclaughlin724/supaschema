import { pathToFileURL } from "node:url";
import { arrayOf, at, isRecord, stringAt } from "../lib/json.mts";

const stripeApiBase = "https://api.stripe.com/v1";

interface CatalogPlan {
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  mode: string;
  name: string;
  plan: string;
  recurringInterval?: string;
}

interface CreatedPlan {
  mode: string;
  plan: string;
  priceId: string;
  productId: string;
}

export function recommendedCatalog(): CatalogPlan[] {
  return [
    {
      amount: 4900,
      currency: "usd",
      metadata: { pack: "type-contract", plan: "type-contract" },
      mode: "payment",
      name: "supaschema type-contract pack",
      plan: "type-contract",
    },
    {
      amount: 4900,
      currency: "usd",
      metadata: { pack: "grant-drift", plan: "grant-drift" },
      mode: "payment",
      name: "supaschema grant-drift pack",
      plan: "grant-drift",
    },
    {
      amount: 9900,
      currency: "usd",
      metadata: { pack: "bundle", plan: "bundle" },
      mode: "payment",
      name: "supaschema pack bundle",
      plan: "bundle",
    },
    {
      amount: 9900,
      currency: "usd",
      metadata: { pack: "bundle", plan: "annual" },
      mode: "subscription",
      name: "supaschema pack bundle annual",
      plan: "annual",
      recurringInterval: "year",
    },
  ];
}

export function stripePriceMap(created: readonly CreatedPlan[]) {
  return Object.fromEntries(
    created.map((plan) => [plan.plan, { mode: plan.mode, price: plan.priceId }])
  );
}

export async function createStripeCatalog(
  fetchImpl: typeof fetch,
  secretKey: string,
  catalog: readonly CatalogPlan[] = recommendedCatalog()
): Promise<CreatedPlan[]> {
  const created: CreatedPlan[] = [];
  const productsByName = await activeProductIndex(fetchImpl, secretKey);
  for (const plan of catalog) {
    const product = await ensureProduct(fetchImpl, secretKey, productsByName, plan);
    const productId = stripeObjectId(product, "products");
    const price = await ensurePrice(fetchImpl, secretKey, productId, plan);
    created.push({
      mode: plan.mode,
      plan: plan.plan,
      priceId: stripeObjectId(price, "prices"),
      productId,
    });
  }
  return created;
}

function stripeObjectId(value: unknown, endpoint: string): string {
  const id = stringAt(value, "id");
  if (id === undefined) {
    throw new Error(`Stripe ${endpoint} object is missing a string id`);
  }
  return id;
}

async function ensureProduct(
  fetchImpl: typeof fetch,
  secretKey: string,
  productsByName: Map<string, object>,
  plan: CatalogPlan
): Promise<object> {
  const existing = productsByName.get(plan.name);
  if (existing !== undefined) {
    return existing;
  }
  const product = await stripePost(fetchImpl, secretKey, "products", {
    name: plan.name,
    ...metadataForm(plan.metadata),
  });
  productsByName.set(plan.name, product);
  return product;
}

async function activeProductIndex(
  fetchImpl: typeof fetch,
  secretKey: string
): Promise<Map<string, object>> {
  const productsByName = new Map<string, object>();
  let startingAfter: string | undefined;
  for (;;) {
    const query: Record<string, string> = { active: "true", limit: "100" };
    if (startingAfter !== undefined) {
      query.starting_after = startingAfter;
    }
    const page = await stripeGet(fetchImpl, secretKey, "products", query);
    const products = arrayOf(at(page, "data"));
    for (const product of products) {
      if (isRecord(product) && typeof product.name === "string" && typeof product.id === "string") {
        productsByName.set(product.name, product);
      }
    }
    if (at(page, "has_more") !== true || products.length === 0) {
      return productsByName;
    }
    const lastId = stringAt(products.at(-1), "id");
    if (lastId === undefined) {
      return productsByName;
    }
    startingAfter = lastId;
  }
}

async function ensurePrice(
  fetchImpl: typeof fetch,
  secretKey: string,
  productId: string,
  plan: CatalogPlan
): Promise<unknown> {
  const existing = await findPrice(fetchImpl, secretKey, productId, plan);
  if (existing !== null) {
    return existing;
  }
  const body: Record<string, string> = {
    currency: plan.currency,
    product: productId,
    unit_amount: String(plan.amount),
  };
  if (plan.recurringInterval !== undefined) {
    body["recurring[interval]"] = plan.recurringInterval;
  }
  return stripePost(fetchImpl, secretKey, "prices", body);
}

async function findPrice(
  fetchImpl: typeof fetch,
  secretKey: string,
  productId: string,
  plan: CatalogPlan
): Promise<unknown> {
  let startingAfter: string | undefined;
  for (;;) {
    const query: Record<string, string> = { active: "true", limit: "100", product: productId };
    if (startingAfter !== undefined) {
      query.starting_after = startingAfter;
    }
    const page = await stripeGet(fetchImpl, secretKey, "prices", query);
    const prices = arrayOf(at(page, "data"));
    const price = prices.find((item) => priceMatchesPlan(item, plan));
    if (price !== undefined) {
      return price;
    }
    if (at(page, "has_more") !== true || prices.length === 0) {
      return null;
    }
    const lastId = stringAt(prices.at(-1), "id");
    if (lastId === undefined) {
      return null;
    }
    startingAfter = lastId;
  }
}

function priceMatchesPlan(price: unknown, plan: CatalogPlan): boolean {
  if (!isRecord(price) || typeof price.id !== "string") {
    return false;
  }
  return (
    price.currency === plan.currency &&
    price.unit_amount === plan.amount &&
    stringAt(price, "recurring", "interval") === plan.recurringInterval
  );
}

async function stripeGet(
  fetchImpl: typeof fetch,
  secretKey: string,
  endpoint: string,
  query: Record<string, string>
): Promise<object> {
  const search = new URLSearchParams(query);
  const response = await fetchImpl(`${stripeApiBase}/${endpoint}?${search.toString()}`, {
    headers: stripeHeaders(secretKey),
    method: "GET",
  });
  return stripeJson(response, endpoint);
}

async function stripePost(
  fetchImpl: typeof fetch,
  secretKey: string,
  endpoint: string,
  body: Record<string, string>
): Promise<object> {
  const response = await fetchImpl(`${stripeApiBase}/${endpoint}`, {
    body: new URLSearchParams(body).toString(),
    headers: { ...stripeHeaders(secretKey), "content-type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return stripeJson(response, endpoint);
}

async function stripeJson(response: Response, endpoint: string): Promise<object> {
  if (!response.ok) {
    throw new Error(`Stripe ${endpoint} returned ${response.status}: ${await response.text()}`);
  }
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null) {
    throw new Error(`Stripe ${endpoint} returned a non-object response`);
  }
  return payload;
}

function stripeHeaders(secretKey: string): Record<string, string> {
  return { authorization: `Bearer ${secretKey}` };
}

function metadataForm(metadata: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [`metadata[${key}]`, value])
  );
}

export async function main(env = process.env, fetchImpl = fetch) {
  const secretKey = env.STRIPE_SECRET_KEY ?? "";
  if (!(secretKey.startsWith("sk_test_") || secretKey.startsWith("sk_live_"))) {
    throw new Error("STRIPE_SECRET_KEY must be a Stripe secret key");
  }
  if (env.STRIPE_CATALOG_APPROVED !== "1") {
    throw new Error("STRIPE_CATALOG_APPROVED=1 is required for catalog creation");
  }
  if (secretKey.startsWith("sk_live_") && env.STRIPE_LIVE_APPROVED !== "1") {
    throw new Error("STRIPE_LIVE_APPROVED=1 is required for live catalog creation");
  }
  const created = await createStripeCatalog(fetchImpl, secretKey);
  console.log(JSON.stringify(stripePriceMap(created)));
  return created;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
