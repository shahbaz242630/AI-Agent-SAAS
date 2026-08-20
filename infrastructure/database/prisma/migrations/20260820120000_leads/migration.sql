-- Slice 3.1a — migration 0026: the lead record, and the evidence behind it.
--
-- The foundation of Lead Follow-up by Email (`lead_follow_up_email`), and all
-- of its compliance work. It does NOT read a mailbox and does NOT reply: those
-- are 3.1b and 3.1c. What it makes possible is logging an enquiry that arrived
-- some other way, seeing it, and marking somebody do-not-contact.
--
-- ⚠️ BRD 4.3, VERBATIM: "A lead without complete channel-appropriate evidence
-- must never enter the call queue." Lead follow-up is marketing-adjacent under
-- PECR, and the difference between a legal response and an unlawful one is
-- whether we can PROVE the person contacted us first. That is why evidence is
-- a table and not a column, why it is written once, and why the database — not
-- the service — is what refuses to change it.
--
-- ⚠️ ONLY THE STATES AND SOURCES 3.1a CAN ACTUALLY PRODUCE. The BRD lists
-- thirteen lead statuses and eleven sources; almost all of them need a mailbox
-- reader or a voice stack that does not exist. `endsAt` in migration 0024 is
-- the warning here: a column whose only value is the one nothing sets is a
-- promise on a screen that nothing keeps. 3.1b widens the source CHECK when it
-- can create `email` leads; 3.1c widens the status CHECK when Eva can answer.

-- ---------------------------------------------------------------------------
-- consent_texts — immutable versions, so evidence stays provable
-- ---------------------------------------------------------------------------
--
-- BRD 4.3: "Consent text versions must be immutable records so evidence
-- remains provable." A form's wording changes; the wording somebody actually
-- agreed to must not. Nothing in 3.1a writes these (our three sources are all
-- direct inbound contact, which needs no consent text) — the table exists now
-- because `lead_evidence` references it and back-filling a reference into
-- historical evidence later is the thing that cannot be done honestly.

CREATE TABLE "consent_texts" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "consent_texts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "consent_texts_organisation_id_idx" ON "consent_texts"("organisation_id");

-- One row per version per organisation. An edit is a NEW version, never an
-- overwrite — that is what "immutable record" means in practice.
CREATE UNIQUE INDEX "consent_texts_organisation_id_version_key"
  ON "consent_texts"("organisation_id", "version");

ALTER TABLE "consent_texts"
  ADD CONSTRAINT "consent_texts_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "consent_texts_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "consent_texts_body_check" CHECK (length("body") > 0);

-- ---------------------------------------------------------------------------
-- leads
-- ---------------------------------------------------------------------------

CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    -- The BRD channel this enquiry arrived through. All three are logged by
    -- hand today; 3.1b adds 'email' when there is a reader to produce it.
    "source" TEXT NOT NULL,
    "contact_name" TEXT,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    -- What they asked for, as received. Nullable: a missed call has a number
    -- and no words, and inventing a summary would be putting words in a
    -- customer's mouth on a compliance record.
    "enquiry" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    -- ⚠️ THEIR CLOCK, NOT OURS. Speed-to-lead (BRD 4.3) is measured from when
    -- the enquiry HAPPENED, not from when we got round to recording it. A lead
    -- logged by hand on Monday for a call missed on Friday is three days old,
    -- and a response target measured from `created_at` would call it instant.
    "received_at" TIMESTAMPTZ(6) NOT NULL,
    "first_responded_at" TIMESTAMPTZ(6),
    -- Set when this enquiry is recognised as an existing client. Nullable: most
    -- leads are strangers, which is the point of them.
    "customer_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "leads_organisation_id_idx" ON "leads"("organisation_id");
-- The lead book's own ordering: newest enquiry first, per organisation.
CREATE INDEX "leads_organisation_id_received_at_idx"
  ON "leads"("organisation_id", "received_at" DESC);

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- A client can be deleted without taking the enquiry's history with it.
  ADD CONSTRAINT "leads_customer_id_fkey"
    FOREIGN KEY ("customer_id") REFERENCES "customers"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "leads_source_check"
    CHECK ("source" IN ('missed_call', 'existing_customer', 'callback_request')),
  -- 3.1c adds the states that need Eva to answer. Two are all that can occur.
  ADD CONSTRAINT "leads_status_check"
    CHECK ("status" IN ('new', 'do_not_contact')),
  -- ⚠️ SOMETHING TO REACH THEM ON, OR IT IS NOT A LEAD. A record with a name
  -- and no way to answer cannot be followed up, and would sit in the book
  -- forever looking like work nobody did.
  ADD CONSTRAINT "leads_contact_check"
    CHECK ("contact_email" IS NOT NULL OR "contact_phone" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- lead_evidence — written once, never updated
-- ---------------------------------------------------------------------------

CREATE TABLE "lead_evidence" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    -- The provider's own id where one exists (Graph message id, call id). Null
    -- for something a person typed in.
    "external_id" TEXT,
    "sender_address" TEXT,
    "recipient_address" TEXT,
    "subject" TEXT,
    -- ⚠️ WHEN THE ENQUIRY HAPPENED, from the channel's own record. The proof
    -- that they contacted us is worth nothing without the moment they did it.
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,
    "consent_text_id" UUID,
    -- Verbatim, so the evidence outlives the mailbox it came from.
    "raw_excerpt" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "lead_evidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "lead_evidence_organisation_id_idx" ON "lead_evidence"("organisation_id");

-- One evidence row per lead. Not "at most one" by convention — by index.
CREATE UNIQUE INDEX "lead_evidence_lead_id_key" ON "lead_evidence"("lead_id");

ALTER TABLE "lead_evidence"
  ADD CONSTRAINT "lead_evidence_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- Evidence has no life of its own: it belongs to the lead it proves.
  ADD CONSTRAINT "lead_evidence_lead_id_fkey"
    FOREIGN KEY ("lead_id") REFERENCES "leads"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  -- ⚠️ RESTRICT, NOT CASCADE OR SET NULL. Deleting the wording somebody agreed
  -- to must not be allowed to quietly unhook it from the evidence that cites
  -- it; that is precisely the record PECR expects us to still hold.
  ADD CONSTRAINT "lead_evidence_consent_text_id_fkey"
    FOREIGN KEY ("consent_text_id") REFERENCES "consent_texts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "lead_evidence_channel_check"
    CHECK ("channel" IN ('missed_call', 'existing_customer', 'callback_request'));

-- ---------------------------------------------------------------------------
-- Tenant isolation (migration 0008's shape, unchanged)
-- ---------------------------------------------------------------------------

ALTER TABLE consent_texts ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_texts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON consent_texts
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON leads
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE lead_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON lead_evidence
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Runtime grants
-- ---------------------------------------------------------------------------
--
-- Migrations 0014–0016 removed every default privilege, so a new table starts
-- with NO grants at all. These lines are load-bearing: omit one and every
-- query against that table fails at runtime.

GRANT SELECT, INSERT, UPDATE, DELETE ON leads TO eva_app;
GRANT SELECT, INSERT ON lead_evidence TO eva_app;
GRANT SELECT, INSERT ON consent_texts TO eva_app;

-- ⚠️ THE REVOKE IS THE IMMUTABILITY. GRANTING ONLY SELECT+INSERT ABOVE DOES
-- NOTHING ON ITS OWN, AND THAT IS THE TRAP.
--
-- `ALTER DEFAULT PRIVILEGES FOR ROLE eva` hands `eva_app` all four privileges
-- (`arwd`) on every table `eva` creates — check `pg_default_acl`. A GRANT adds;
-- it never subtracts. So the first version of this migration granted
-- SELECT+INSERT, wrote a confident comment about the database refusing to
-- change evidence, and left UPDATE and DELETE sitting there from the default.
-- The comment would have been a lie that nothing failed on, on the one table
-- whose whole job is being provable.
--
-- Caught by reading `information_schema.table_privileges` after applying, which
-- is now a test (`schema-conventions.spec.ts`).
--
-- "Written once, never updated" is a rule a service forgets the day somebody
-- writes a tidy-up script. Revoked here, it is the DATABASE that refuses, for
-- every caller, forever — no trigger, no new pattern, nothing to maintain.
--
-- DELETE goes too, and cascade still works: referential actions run with the
-- privileges of the constraint owner, so deleting a lead still takes its
-- evidence with it. What becomes impossible is deleting evidence on its own,
-- leaving a lead that looks contactable and cannot prove it.
REVOKE UPDATE, DELETE ON lead_evidence FROM eva_app;
REVOKE UPDATE, DELETE ON consent_texts FROM eva_app;
