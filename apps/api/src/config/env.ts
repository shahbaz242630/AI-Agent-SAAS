import { z } from "zod";

/** Environment variables required by the API process. Validated at boot — fail fast. */
export const apiEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
  WEB_ORIGIN: z.string().url().default("http://localhost:3000"),
  // Supabase Auth (Slice 0.3): access tokens are verified against the project
  // JWKS at ${SUPABASE_URL}/auth/v1/.well-known/jwks.json.
  SUPABASE_URL: z.string().url(),
  // Public anon key — present for parity with the web app; may be empty in dev.
  SUPABASE_ANON_KEY: z.string().default(""),
  // Runtime database connection as the eva_app role (NOBYPASSRLS) — RLS applies.
  APP_DATABASE_URL: z.string().url().default("postgresql://eva_app:eva_app@localhost:5432/eva"),
  // Sentry DSN (Slice 0.4) — empty disables Sentry; always disabled in tests.
  SENTRY_DSN_API: z.string().default(""),
  // Shared secret for internal service-to-service endpoints (Slice 1.5, plan
  // §7.8: the Trigger.dev reconcile sweep calls POST /internal/reminders/
  // reconcile). Required, minimum 32 chars; compared in constant time.
  INTERNAL_API_SECRET: z.string().min(32),
  // Slice 1.6 — Outlook connection. Token encryption at rest (ruling 2):
  // 32 bytes, base64 (generate: openssl rand -base64 32).
  TOKEN_ENCRYPTION_KEY: z.string().refine((value) => Buffer.from(value, "base64").length === 32, {
    message: "TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded",
  }),
  // HS256 signing secret for the OAuth state JWT (ruling 4).
  OAUTH_STATE_SECRET: z.string().min(32),
  // Multi-tenant Entra app registration (plan §10); tenant "common" = any org directory.
  MICROSOFT_CLIENT_ID: z.string().min(1),
  MICROSOFT_CLIENT_SECRET: z.string().min(1),
  MICROSOFT_TENANT: z.string().min(1).default("common"),
  MICROSOFT_OAUTH_REDIRECT_URI: z.string().url(),
  /**
   * Slice 3.1b — the domain a customer's enquiries are delivered to (ruling
   * 25: an address WE own, never their mailbox). Ruling 34 starts this on
   * Resend's free `<id>.resend.app` and moves it to a domain we own before the
   * first sale.
   *
   * ⚠️ OPTIONAL AT BOOT, AND REFUSED AT USE — NOT THE OTHER WAY AROUND, AND
   * NOT DEFAULTED. Two failure modes were available here and both are worse
   * than this one. Making it REQUIRED means an API that will not start until
   * every environment has it, and merging auto-deploys staging against
   * production's database — so a missing value takes the whole product down to
   * ship a feature nobody has switched on yet. Giving it a plausible DEFAULT is
   * worse still: addresses would be issued on a domain that receives nothing,
   * printed on a customer's website, and every enquiry sent to one would
   * vanish with no error anywhere. Unset, the front door simply cannot be
   * opened and says so.
   */
  INBOUND_EMAIL_DOMAIN: z.string().default(""),
  /**
   * Slice 3.1b — reading the message itself. Resend's `email.received` webhook
   * carries METADATA ONLY: no body, no headers, no attachments. Turning an
   * arrival into a lead therefore takes a second, authenticated call, and this
   * is what authenticates it.
   */
  RESEND_API_KEY: z.string().default(""),
  /**
   * Slice 3.1b — the Svix signing secret for the inbound webhook (`whsec_…`).
   *
   * ⚠️ UNSET MEANS REFUSE EVERYTHING, NEVER ACCEPT EVERYTHING. This value is
   * the ONLY authentication on a route the public internet can reach: there is
   * no JWT, no session and no organisation on an inbound webhook. An empty
   * secret that fell through to "no verification configured, allow it" would
   * turn the front door into an open one, and it would do so silently on
   * exactly the environment where somebody forgot to set it. `InboundWebhook`
   * refuses when this is empty, and a test proves it.
   */
  RESEND_WEBHOOK_SECRET: z.string().default(""),
  /**
   * Slice 3.1b step 3 — Gmail sending (ruling 25: the CHEAP scope).
   *
   * ⚠️ OPTIONAL AT BOOT AND REFUSED AT USE, THE SAME SHAPE AS THE INBOUND
   * DOMAIN AND FOR THE SAME REASON. Required would mean the API refuses to
   * start on any environment without Google credentials — including the one
   * running the product we already sell. A default is impossible here anyway:
   * there is no plausible client id.
   *
   * Unset, the Gmail card stays as it has always been — greyed out, "soon" —
   * and no authorize URL can be built. Microsoft is untouched either way.
   */
  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GOOGLE_OAUTH_REDIRECT_URI: z
    .string()
    .default("http://localhost:3001/integrations/google/callback"),
  /**
   * Slice 3.2c — receiving WhatsApp. Optional at boot, refused at use: the same
   * shape as `RESEND_WEBHOOK_SECRET` and Google's pair above, and for the same
   * reason. Required would stop the API starting on every environment that has
   * no WhatsApp app, which today is all of them but one developer's laptop.
   *
   * `META_APP_SECRET` signs every webhook Meta sends us; the guard refuses
   * everything while it is empty, and a test proves it. `WHATSAPP_VERIFY_TOKEN`
   * is a string WE invent and Meta echoes back during the subscription
   * handshake — it proves the GET came from a configuration we made rather than
   * from anyone who guessed the URL.
   *
   * ⚠️ THE APP ID IS NOT A SECRET AND THE OTHER TWO ARE. The id appears in
   * public consent screens; the secret and any access token do not, and
   * `.env` is where they live — never a commit, never a message.
   */
  META_APP_ID: z.string().default(""),
  META_APP_SECRET: z.string().default(""),
  WHATSAPP_VERIFY_TOKEN: z.string().default(""),
  /**
   * Slice 3.4a — sending on WhatsApp. A System User access token from OUR
   * business portfolio, with `whatsapp_business_messaging`; it is what Meta's
   * Get Started prescribes for a test number, and it is a secret like the app
   * secret above. Optional at boot, refused at use: with it empty the sender
   * records every reply as deferred ("not configured") rather than failing
   * the enquiry, and nothing reaches Meta.
   *
   * ⚠️ ONE TOKEN FOR EVERY CONNECTION IS THE TEST-NUMBER SHAPE, NOT THE
   * CUSTOMER SHAPE. Meta's partner guide has a Tech Provider send with a
   * BUSINESS token per onboarded customer, exchanged from the code Embedded
   * Signup returns. That token belongs on the customer's connection row,
   * encrypted, exactly as a mailbox's does — and the connect screen slice
   * puts it there. Until then this is the only credential the sender has.
   */
  WHATSAPP_ACCESS_TOKEN: z.string().default(""),
});

export type ApiEnv = z.infer<typeof apiEnvSchema>;
