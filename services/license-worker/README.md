# supaschema license worker (M30 / M31 / X51)

Cloudflare Worker for the hands-off monetization loop and hosted schema-contract registry. It creates repo-bound Stripe Checkout Sessions, mints repo-bound Ed25519 access tokens on verified Stripe `checkout.session.completed` and `checkout.session.async_payment_succeeded` webhooks, serves the minted token back to the buyer, and stores repo-bound schema contracts authenticated by that same token. Token issuance and verification are self-contained in this Worker; the MIT package has no entitlement dependency or per-run server call.

The signing/verification logic and the full self-serve loop are implemented here. What remains is operator deployment, which needs Cloudflare, Stripe, and signing-key state that must not live in the repo.

## Routes

- `GET /checkout?repo=acme/app&plan=bundle` redirects the buyer into the GitHub App user-authorization flow instead of creating a session from the raw query: it validates the repo/plan shape and the operator price map, then 302s to GitHub with a purpose-bound, randomly unique, signed ten-minute state token bound to the initiating browser by a secure, HttpOnly, SameSite cookie. The buyer never sets the licensed repo directly. The price and mode come from the operator `STRIPE_PRICE_MAP`, never the query, so a buyer cannot self-select a price. Subscription expiry comes from Stripe's paid-through boundary; `intervalDays` applies only to one-time `payment` prices and defaults to 365 days. Dynamic payment methods are used; `payment_method_types` is never sent. The `success_url` carries `{CHECKOUT_SESSION_ID}` so the buyer lands on a page that can call `/license`.
- `GET /auth/github/callback` verifies the state type, signature, nonce, and expiry, exchanges the GitHub App user code, and checks the authenticated user's repository permission (`GET /repos/{owner}/{repo}/collaborators/{user}/permission`, requiring admin or write). The GitHub App must be installed on each eligible repository and needs only repository Metadata read access; no classic OAuth `repo` scope is requested. Only then does the Worker create the Checkout Session server-side, with `metadata.repo` set to the verified repo and `metadata.github_user` to the authenticated login. Non-collaborators get 403; no Stripe session is created on any denial path.
- `GET /contracts?repo=acme/app&name=main` retrieves a schema contract when the request carries an unexpired repo-bound license token in `Authorization`.
- `PUT /contracts?repo=acme/app&name=main` stores a schema contract when the request carries an unexpired repo-bound token in `Authorization`. The payload must match the `SchemaContract` JSON shape from `src/contract/schema.ts`.
- `DELETE /contracts?repo=acme/app&name=main` deletes a schema contract when the request carries an unexpired repo-bound license token in `Authorization`.
- `POST /webhook` verifies the Stripe signature over the raw body, then mints a repo-bound token keyed by the Checkout session id on `checkout.session.completed` or `checkout.session.async_payment_succeeded` (delayed payment methods complete unpaid first). A Stripe retry returns the stored token, never a second mint. For subscription prices, the Worker retrieves the matching Stripe Subscription Item and sets token expiry to its Basil `current_period_end`. A later `invoice.paid` renewal (`billing_reason` = `subscription_cycle`) matches the configured price in the invoice lines and advances expiry exactly to `period.end`; a SQLite-backed Durable Object keyed by the original Checkout session serializes renewal state so overlapping, duplicate, or stale invoices cannot shorten it. Subscription ids come from the Basil (`2025-03-31.basil`) `invoice.parent.subscription_details.subscription` shape with the legacy top-level `invoice.subscription` field as fallback for older endpoint versions.
- `GET /license?session_id=cs_test_123` lets the buyer retrieve their token after the success redirect, or returns `404 { "pending": true }` until the webhook has stored it. The token never returns to Stripe. The checkout redirects to the private, no-index success page at `https://supaschema.com/license`; that page polls this Worker at `https://license.supaschema.com/license`, displays the token, and lets the buyer copy it. Responses carry `Access-Control-Allow-Origin` scoped to the configured success-page origin, and `OPTIONS` preflights return 204.

## Code map

- `src/signed-token.ts` - the shared Ed25519 signed-token codec with strict token-type verification.
- `src/issue.ts` - purpose-bound license token issuance, verification, claims, and repository/expiry authorization.
- `src/webhook.ts` - `verifyStripeSignature` (raw-body HMAC-SHA256, replay window, constant-time compare).
- `src/stripe-api.ts` - authenticated Stripe REST GET/POST transport.
- `src/checkout.ts` - `parsePlanCatalog` (operator `STRIPE_PRICE_MAP`), `createCheckoutSession`, `successUrlWithSessionId`.
- `src/oauth-state.ts` - atomic, expiring OAuth-state consumption shared by the Worker and its Durable Object.
- `src/store.ts` - `WorkerStore` interface (Cloudflare KV bindings satisfy it) and `createMemoryStore` for tests.
- `src/subscription-renewal.ts` - atomic per-Checkout-session renewal state and monotonic paid-through enforcement.
- `src/index.ts` - the Worker router (`handleLicenseWorker`) dispatching `/checkout`, `/contracts`, `/webhook`, `/license`.
- `src/worker.ts` - the Cloudflare entry point plus the renewal and OAuth-state Durable Objects.
- `scripts/stripe/create-catalog.mts` - one-shot product/price catalog creation owner; it emits the `STRIPE_PRICE_MAP` JSON consumed by the Worker.

## Deployment Handoff

1. Generate the signing keypair (keep the private key secret):
   ```bash
   keydir="$(mktemp -d)"
   openssl genpkey -algorithm ed25519 -out "$keydir/supaschema_license_private.pem"
   openssl pkey -in "$keydir/supaschema_license_private.pem" -pubout -out "$keydir/supaschema_license_public.pem"
   cat "$keydir/supaschema_license_public.pem"
   ```
2. The Worker derives the public key from `SUPASCHEMA_LICENSE_PRIVATE_KEY` at startup and uses it to verify contract-route bearer tokens; no package key embedding is required.
3. Keep `services/license-worker/wrangler.toml` as the canonical Worker config. It declares `LICENSE_KV` and `CONTRACT_KV` without ids, provisions the SQLite-backed `SUBSCRIPTION_RENEWALS` and `OAUTH_STATES` Durable Object namespaces, and publishes the Worker on the `license.supaschema.com` custom domain used by the success page.
4. Create the Stripe catalog with the approved prices:
   ```bash
   STRIPE_CATALOG_APPROVED=1 node scripts/stripe/create-catalog.mts
   ```
5. Register a GitHub App with callback URL `https://<worker-origin>/auth/github/callback`, grant repository Metadata read access, and install it on every repository eligible for licensing. Use the App's client id and secret for the existing OAuth-named Worker bindings; the authorization request deliberately sends no classic OAuth scopes. Then set the Worker secrets and deployment-specific plan map in Cloudflare:
   ```bash
   wrangler secret put GITHUB_OAUTH_CLIENT_ID --config services/license-worker/wrangler.toml
   wrangler secret put GITHUB_OAUTH_CLIENT_SECRET --config services/license-worker/wrangler.toml
   wrangler secret put SUPASCHEMA_LICENSE_PRIVATE_KEY --config services/license-worker/wrangler.toml < "$keydir/supaschema_license_private.pem"
   wrangler secret put STRIPE_WEBHOOK_SECRET --config services/license-worker/wrangler.toml
   wrangler secret put STRIPE_SECRET_KEY --config services/license-worker/wrangler.toml
   wrangler secret put STRIPE_PRICE_MAP --config services/license-worker/wrangler.toml
   ```
6. Run `wrangler deploy --config services/license-worker/wrangler.toml` from the repository root (the root `wrangler.toml` targets the docs Worker), then add the Worker `/webhook` URL as a Stripe webhook endpoint subscribed to `checkout.session.completed`, `checkout.session.async_payment_succeeded`, and (for subscription-mode prices) `invoice.paid`.
7. Link buyers to `/checkout` with a repo and plan query. The Worker routes them through GitHub OAuth first and binds the issued license to the repo they provably write to via `metadata.repo`, `metadata.plan`, and `metadata.github_user`.

Provisioning the Cloudflare account, the Stripe account, the restricted key, the GitHub App, and the signing key is the operator's responsibility. This repo intentionally contains none of them.
