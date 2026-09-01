-- Slice 3.1c-1 — migration 0035: the words Eva replies with.
--
-- Founder ruling 2026-08-21: *"A new enquiry drops in → Eva replies straight
-- away from a small set of templates (2–3) the customer edits during onboarding
-- for this product. That is the whole feature."* Today the invoice chaser's
-- wording is hardcoded in `reminder-message.ts` and there is nowhere for a
-- customer's own words to live. This is that place.
--
-- ⚠️ THIS IS THE LEAD PRODUCT'S FIRST OWNED TABLE, AND THAT IS THE POINT.
-- `architecture.spec.ts` requires a registered product to own at least one, and
-- until now everything lead-shaped sat in `platform/`. Founder ruling
-- 2026-09-01: **the LEADS stay in platform** — shared, like clients (ruling
-- 15), because Lead Follow-up by CALL is a separate product (ruling 14) and a
-- product's tables are exclusively owned, so a lead owned by the email product
-- could never be read by the call one. What the email product owns is the
-- REPLY. This table.
--
-- ⚠️ THERE IS NO `subject` COLUMN, DELIBERATELY. A reply threads onto the
-- enquiry it answers, so its subject is `Re: ` plus the original — derived, not
-- authored. Letting a customer type one would let them break threading by
-- accident, and the debtor-side equivalent of that (a chaser that starts a new
-- thread every time) is a defect we would have to explain rather than a setting
-- anyone wanted.

CREATE TABLE "lead_reply_templates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organisation_id" UUID NOT NULL,
  -- What the customer calls it in their own list: "Standard reply",
  -- "Out of hours". Never sent to anybody.
  "name" TEXT NOT NULL,
  -- What Eva actually writes. Plain text: the mailbox adapters send text
  -- (`bodyText`), and offering rich text here would promise formatting the
  -- send path does not carry.
  "body" TEXT NOT NULL,
  /**
   * ⚠️ EXACTLY ONE AUTOMATIC TEMPLATE PER ORGANISATION — founder ruling
   * 2026-09-01, "one default reply, others manual". The automatic one is the
   * only thing Eva ever sends on her own; the rest are saved wordings a human
   * picks from the enquiry screen.
   *
   * Enforced by a partial unique index below rather than by application code,
   * for the same reason `email_accounts.is_primary` is: two automatic replies
   * is not a state the database will hold, and NO automatic reply is a state
   * the sender must be able to detect rather than guess at.
   */
  "is_automatic" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "created_by" UUID,
  "deleted_at" TIMESTAMPTZ(6),

  CONSTRAINT "lead_reply_templates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lead_reply_templates_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE,
  -- A template nobody can read is not a template. Empty names and bodies are
  -- refused here as well as in the API, because the API is not the only thing
  -- that has ever written to this database.
  CONSTRAINT "lead_reply_templates_name_check" CHECK (length(btrim("name")) > 0),
  CONSTRAINT "lead_reply_templates_body_check" CHECK (length(btrim("body")) > 0)
);

CREATE INDEX "lead_reply_templates_organisation_id_idx"
  ON "lead_reply_templates"("organisation_id");

-- One automatic reply per organisation, among the live rows.
CREATE UNIQUE INDEX "lead_reply_templates_single_automatic_key"
  ON "lead_reply_templates"("organisation_id")
  WHERE "is_automatic" AND "deleted_at" IS NULL;

-- A customer cannot have two templates by the same name, which is what makes
-- the seeding below idempotent without a second bookkeeping column.
CREATE UNIQUE INDEX "lead_reply_templates_live_name_key"
  ON "lead_reply_templates"("organisation_id", lower("name"))
  WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Row-level security: the same tenant boundary as every other table.
-- ---------------------------------------------------------------------------
--
-- ⚠️ NOT OPTIONAL AND NOT A FORMALITY. RLS is the model here (the service-role
-- key is deliberately never used), so a table without a policy is readable
-- across tenants by the application role — one customer's words in another
-- customer's mouth.

ALTER TABLE "lead_reply_templates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_reply_templates" FORCE ROW LEVEL SECURITY;

-- ⚠️ THE SETTING IS `app.current_org`, AND THE `NULLIF` IS NOT DECORATION.
-- I wrote `app.organisation_id` first, from memory. It is not a name anything
-- sets, so `current_setting` would have returned NULL, every comparison would
-- have been NULL rather than true, and the table would have been invisible to
-- the application with nothing in the code to explain it. The `NULLIF` guards
-- the other end: an empty string cast to uuid throws rather than returning no
-- rows. Copied from `inbound_addresses` (0029), which is the pattern.
CREATE POLICY tenant_isolation ON "lead_reply_templates"
  USING ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON "lead_reply_templates" TO eva_app;

-- ⚠️ THE REVOKE IS THE RULE; THE GRANT ABOVE DOES NOTHING ON ITS OWN.
-- Default privileges already hand `eva_app` everything on a table `eva`
-- creates, and a GRANT only ever ADDS — so listing three verbs above removes
-- nothing, and a reviewer reading only that line would believe DELETE was
-- already impossible. It is this statement that makes it so. Same lesson as
-- `suppression_list` in 0025.
--
-- Deletion is soft, through `deleted_at`. A hard DELETE would take the wording
-- Eva sent somebody out from under the evidence of having sent it — and the
-- reply record added later in 3.1c points at the template it used.
REVOKE DELETE ON "lead_reply_templates" FROM eva_app;
