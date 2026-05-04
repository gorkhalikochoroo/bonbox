# How to enable Stripe billing (5 minutes)

You do 4 things in the Stripe dashboard, paste 4 values into Render env vars,
and the upgrade flow goes live. Until you do this, the SubscriptionPage falls
back to the waitlist-join flow gracefully (no broken UX).

## Step 1 — Get your API keys (1 min)

Stripe Dashboard → **Developers → API keys**

Copy these two:

| Stripe label             | Render env var key       | Example (don't use)        |
| ------------------------ | ------------------------ | -------------------------- |
| Publishable key          | `STRIPE_PUBLISHABLE_KEY` | `pk_live_51N...`           |
| Secret key               | `STRIPE_SECRET_KEY`      | `sk_live_51N...`           |

> Use **test keys** (`pk_test_...` / `sk_test_...`) until you've done end-to-end
> testing. Switch to live keys when you're ready to charge real money.

## Step 2 — Create the Pro product (2 min)

Stripe Dashboard → **Products → + Add product**

- **Name**: `BonBox Pro`
- **Description**: `Founding-member access to all BonBox Pro features. Cancel anytime.`
- **Pricing**:
  - **Recurring**: Yes
  - **Price**: `139.00`
  - **Currency**: `DKK`
  - **Billing period**: Monthly
- **Trial**: handled in code (14 days passed via `subscription_data.trial_period_days`).
  You don't need to set Stripe-side trial duration here.

After saving, click the product → click the **price row** → copy the **Price ID**:

| Stripe label | Render env var key      | Example (don't use) |
| ------------ | ----------------------- | ------------------- |
| Price ID     | `STRIPE_PRICE_ID_PRO`   | `price_1N...`       |

## Step 3 — Create the webhook endpoint (1 min)

Stripe Dashboard → **Developers → Webhooks → + Add endpoint**

- **Endpoint URL**: `https://bonbox-api.onrender.com/api/billing/stripe/webhook`
- **API version**: latest (default)
- **Events to listen for** (select these 5):
  - `checkout.session.completed`
  - `customer.subscription.created`
  - `customer.subscription.updated`
  - `customer.subscription.deleted`
  - `invoice.payment_failed`

Click **Add endpoint**. On the next page, click **Reveal signing secret** and copy:

| Stripe label   | Render env var key      | Example (don't use) |
| -------------- | ----------------------- | ------------------- |
| Signing secret | `STRIPE_WEBHOOK_SECRET` | `whsec_...`         |

## Step 4 — Paste into Render (1 min)

Render dashboard → `bonbox-api` → **Environment** → **Edit**

Add these 4 entries:

```
STRIPE_SECRET_KEY      sk_live_...   (or sk_test_... for testing)
STRIPE_PUBLISHABLE_KEY pk_live_...
STRIPE_WEBHOOK_SECRET  whsec_...
STRIPE_PRICE_ID_PRO    price_...
```

Click **Save, rebuild, and deploy**.

When deploy finishes (~2 min), the SubscriptionPage's "Choose Pro" button
flips from waitlist-join to a real Stripe Checkout flow.

## How to test (test mode only)

1. Set the test-mode keys in Render (sk_test, pk_test, etc.)
2. Open BonBox → Subscription → click "Choose Pro"
3. You'll be redirected to Stripe Checkout
4. Use test card: `4242 4242 4242 4242` / any future date / any CVC / any postcode
5. Complete checkout → you'll be redirected back to /subscription?success=1
6. Stripe sends a webhook to your backend
7. Wait ~5 sec → refresh /subscription → "Current plan" should now say Pro
8. Check Render logs to see the webhook event came in:
   ```
   Stripe webhook received: type=checkout.session.completed id=evt_...
   Stripe webhook received: type=customer.subscription.created id=evt_...
   ```

## How payment is enforced server-side

The user's `plan` column ONLY flips to `pro` when:
1. Stripe sends a webhook with valid `Stripe-Signature` header
2. The signature verifies against your `STRIPE_WEBHOOK_SECRET`
3. The event is one of the allowlisted types
4. The subscription's `status` is `active` or `trialing`

**No public API path can grant Pro.** Even if someone forges `/billing/me` or
`/billing/stripe/checkout-session` requests, they cannot mutate plan state
without a valid Stripe webhook signature.

## iOS App Store compliance

Apple requires apps to use IAP for digital subscriptions (30% tax). Code path:

1. `frontend/src/services/api.js` sends `X-BonBox-Platform: ios` header on
   every request from the Capacitor iOS shell
2. `routers/billing.py` rejects checkout-session requests where this header
   is `ios` with a 403 + `redirect_to_web: true`
3. `SubscriptionPage.jsx` ALSO checks `isNative` and opens
   `https://bonbox.dk/subscription` in the system browser instead

Both layers must agree before a Stripe session can be created. The user
upgrades on web; their account becomes Pro; their iOS app reflects it.

## What's already implemented

- ✅ User model has `stripe_customer_id`, `stripe_subscription_id`,
  `subscription_status`, `subscription_period_end`
- ✅ `services/stripe_billing.py` — checkout sessions, billing portal sessions,
  webhook handler with signature verification, customer auto-creation
- ✅ `routers/billing.py` — POST `/checkout-session`, POST `/portal-session`,
  POST `/webhook`, plus extended GET `/me` returning Stripe state
- ✅ `SubscriptionPage.jsx` — real Stripe Checkout flow with iOS guard +
  graceful waitlist fallback when Stripe isn't configured yet
- ✅ Multi-layer defense — signature verify, rate limits, tenant isolation,
  iOS-IAP guard, idempotent event handling
- ✅ Render `render.yaml` declares the 4 STRIPE_* env-var slots

## What's left for you

- [ ] 4 env vars in Render (this doc, Steps 1–4)
- [ ] Test the flow with `4242 4242 4242 4242`
- [ ] Switch to live keys when ready to charge real customers
