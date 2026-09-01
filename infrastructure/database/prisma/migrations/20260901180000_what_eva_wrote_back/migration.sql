-- Slice 3.1c-3 — migration 0036: what Eva wrote back, and why she did not.
--
-- The lead product's SECOND owned table. `lead_reply_templates` (0035) holds
-- the words a customer may send; this holds what actually happened to one
-- enquiry — the decision, and the reply if there was one.
--
-- ⚠️ ONE ROW PER LEAD, AND IT EXISTS EVEN WHEN NOTHING WAS SENT. That is the
-- point of the table, not an edge case. Founder ruling 32 — *"err toward
-- silence; the uncertain middle waits for a human"* — means Eva will often
-- decide NOT to answer, and "Eva stayed silent" and "Eva was never asked" look
-- identical from the outside. A customer opening an unanswered enquiry has to
-- be told which one it was, in a sentence, or the silence reads as a fault.
--
-- ⚠️ SO IT IS NOT CALLED `lead_replies`. A row here is a DECISION, and only
-- sometimes a reply. Naming it for the happy path is how a table ends up with
-- rows that contradict its own name.
--
-- ⚠️ THE BODY THAT WENT OUT IS STORED, NOT JUST THE TEMPLATE ID. A customer
-- edits their templates freely (3.1c-1), so the template's current wording is
-- NOT what was sent last month. Pointing at the template alone would make the
-- record change retrospectively — and this is the record of what a stranger
-- actually received in the customer's name. `lead_evidence` keeps its excerpt
-- for the same reason, and for the same compliance argument.

CREATE TABLE "lead_reply_decisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organisation_id" UUID NOT NULL,
  "lead_id" UUID NOT NULL,

  -- reply | hold | never. What the provider decided (slice 3.1c-2).
  "verdict" TEXT NOT NULL,
  -- Why, in words a customer reads on the enquiry screen.
  "reason" TEXT NOT NULL,
  -- The stable key behind that sentence: `auto-submitted`, `bounce`,
  -- `spam-verdict-gray`. For logs and metrics; never shown to a customer.
  "signal" TEXT NOT NULL,

  -- pending | sent | failed | deferred | not_sent
  --
  -- ⚠️ `not_sent` IS A SUCCESS, NOT A FAILURE. It is the terminal state of a
  -- `hold` or `never` verdict: nothing went wrong, Eva decided correctly that
  -- nothing should go. Folding it into `failed` would fill a customer's screen
  -- with red for the product working as designed.
  "status" TEXT NOT NULL DEFAULT 'pending',
  "failure_reason" TEXT,

  -- ⚠️ NULLABLE, AND NULL IS THE COMMON CASE. No template is chosen unless a
  -- reply is actually composed. ON DELETE RESTRICT because the template rows
  -- are soft-deleted and never hard-deleted (0035 revokes DELETE), so this can
  -- only fire if somebody bypasses the application — in which case failing
  -- loudly is right.
  "template_id" UUID,

  -- What was actually sent. All null until a reply goes out.
  "to_address" TEXT,
  "subject" TEXT,
  "body" TEXT,
  "sent_at" TIMESTAMPTZ(6),
  -- Which mailbox it left from, as text rather than a foreign key: the mailbox
  -- may later be disconnected and its row soft-deleted, and the record of who
  -- a stranger heard from must survive that.
  "sent_from" TEXT,

  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  -- ⚠️ NO `created_by`. Eva decides this on her own, unattended — there is no
  -- person to name, and a column inviting one would eventually be filled with
  -- whoever happened to trigger the webhook.
  "deleted_at" TIMESTAMPTZ(6),

  CONSTRAINT "lead_reply_decisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lead_reply_decisions_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_reply_decisions_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_reply_decisions_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "lead_reply_templates"("id") ON DELETE RESTRICT,

  CONSTRAINT "lead_reply_decisions_verdict_check"
    CHECK ("verdict" IN ('reply', 'hold', 'never')),
  CONSTRAINT "lead_reply_decisions_status_check"
    CHECK ("status" IN ('pending', 'sent', 'failed', 'deferred', 'not_sent')),

  /**
   * ⚠️ A SENT REPLY MUST CARRY WHAT WAS SENT. Without this, a bug that loses
   * the body still records `sent`, and the compliance record says a stranger
   * received something without saying what. The database refuses that state
   * rather than trusting every future code path not to produce it.
   */
  CONSTRAINT "lead_reply_decisions_sent_is_complete_check"
    CHECK (
      "status" <> 'sent'
      OR ("to_address" IS NOT NULL AND "body" IS NOT NULL AND "sent_at" IS NOT NULL)
    ),
  /** And a reply can only have been sent if the verdict allowed one. */
  CONSTRAINT "lead_reply_decisions_only_reply_sends_check"
    CHECK ("status" <> 'sent' OR "verdict" = 'reply')
);

CREATE INDEX "lead_reply_decisions_organisation_id_idx"
  ON "lead_reply_decisions"("organisation_id");

/**
 * ⚠️ ONE DECISION PER LEAD, AND THIS IS THE IDEMPOTENCY KEY.
 *
 * Resend retries a webhook that does not answer 200 — "immediately, then a few
 * more times over the next 36 hours". Intake is already idempotent on
 * `provider_message_id`, but the reply is a SECOND effect, and without this a
 * retried delivery would send a stranger the same automatic reply twice in the
 * customer's name. Partial on `deleted_at` so a soft-deleted row does not
 * block a deliberate re-run.
 */
CREATE UNIQUE INDEX "lead_reply_decisions_one_per_lead_key"
  ON "lead_reply_decisions"("lead_id")
  WHERE "deleted_at" IS NULL;

/** The review queue's query (3.1c-4): what is waiting for a human. */
CREATE INDEX "lead_reply_decisions_waiting_idx"
  ON "lead_reply_decisions"("organisation_id", "created_at" DESC)
  WHERE "verdict" = 'hold' AND "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- Row-level security — the same tenant boundary as every other table.
-- ---------------------------------------------------------------------------
--
-- ⚠️ NOT OPTIONAL. RLS is the model here (the service-role key is deliberately
-- never used), so a table without a policy is readable across tenants by the
-- application role. This one holds the words sent to a named stranger.

ALTER TABLE "lead_reply_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_reply_decisions" FORCE ROW LEVEL SECURITY;

-- The setting is `app.current_org`, and the NULLIF guards an empty string
-- casting to uuid. Copied from `inbound_addresses` (0029), the pattern.
CREATE POLICY tenant_isolation ON "lead_reply_decisions"
  USING ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON "lead_reply_decisions" TO eva_app;

-- ⚠️ THE REVOKE IS THE RULE; THE GRANT ABOVE ADDS AND NEVER REMOVES.
-- Default privileges already hand `eva_app` everything on a table `eva`
-- creates, so listing three verbs removes nothing. This is what makes deletion
-- impossible — and it matters more here than on most tables: this is the record
-- that a specific message was sent to a specific person on a specific day, in
-- a business's name. Ruling 38 keeps evidence of what happened.
REVOKE DELETE ON "lead_reply_decisions" FROM eva_app;
