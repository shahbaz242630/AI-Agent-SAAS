-- Slice 3.3a — migration 0041: the spine.
--
-- The shared lead system underneath every product (blueprint §3.2, founder
-- rulings 66 and 67, 2026-09-03): the PERSON, the handles that reach them, the
-- THREAD per handle, the canonical MESSAGE whoever wrote it, the STAGES an
-- enquiry moves through, and the ACTIVITIES that are not messages. `leads`
-- becomes the ENQUIRY — one per piece of potential work — and points at the
-- person instead of being the person.
--
-- ⚠️ THIS MIGRATION CHANGES NO BEHAVIOUR. Nothing in the API writes these
-- tables until 3.3b; nothing on a screen reads them until 3.3c. What it does is
-- give every row that already exists its place in the new shape, so that the
-- first normaliser finds a person to attach to rather than inventing one beside
-- the customer's invoice history. The backfill is at the bottom, between
-- markers, because a test re-runs that exact text against fixtures — a fresh
-- CI database has zero rows when this runs, so "every old lead has a person"
-- is an assertion that cannot fail there (`schema-conventions.spec.ts` says the
-- same of 0020).
--
-- ⚠️ ONLY THE COLUMNS SOMETHING WILL WRITE. The blueprint lists `value_amount`,
-- `lost_reason`, `won_at`, `assigned_user_id`, `automation_paused_until`,
-- `custom_fields`, `do_not_automate`, `merged_into_id`. None arrives here. A
-- column whose only value is the one nothing sets is the `endsAt` trap
-- (migration 0024): a promise on a screen that nothing keeps. They come with
-- the slice that writes them (3.5 the engine, 3.10 the CRM).
--
-- Every table below: `organisation_id` NOT NULL, ENABLE + FORCE row-level
-- security, the `tenant_isolation` policy, and an explicit REVOKE — because the
-- default privileges hand `eva_app` all four verbs on anything the owner
-- creates and a GRANT only ever adds (0026, 0035, 0037, 0040).

-- ---------------------------------------------------------------------------
-- people — the human. One row per person per organisation.
-- ---------------------------------------------------------------------------
--
-- Named `people` and not `contacts`, because `contacts` already means "a person
-- at a client" in Invoice Chasing and has for eleven sessions.
--
-- ⚠️ NO UNIQUE ON EMAIL OR PHONE HERE. A handle is unique on
-- `person_identities`; `primary_email` / `primary_phone` are a convenience for
-- screens and are copied from the identities, never the other way round.
--
-- ⚠️ TWO ORGANISATIONS, ONE HUMAN: TWO ROWS. There is no cross-tenant lookup,
-- ever (blueprint §3.3 rule 8). RLS makes it structural.
CREATE TABLE "people" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organisation_id" UUID NOT NULL REFERENCES "organisations"("id") ON DELETE CASCADE,
  "display_name"    TEXT NOT NULL,
  -- Lowercased; the CHECK refuses anything else so a screen never shows two
  -- spellings of one address.
  "primary_email"   TEXT,
  -- E.164 with the plus, or nothing. A national-format number with no country
  -- is ambiguous and is not stored here; the raw snapshot on `leads` keeps it.
  "primary_phone"   TEXT,
  -- Set when this person IS a client — by the backfill below for clients that
  -- already carry a handle, and by the CRM when it converts one (3.10).
  "customer_id"     UUID REFERENCES "customers"("id") ON DELETE SET NULL,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_by"      UUID,
  "deleted_at"      TIMESTAMPTZ(6),

  CONSTRAINT "people_display_name_check"
    CHECK (length(btrim("display_name")) > 0),
  CONSTRAINT "people_primary_email_check"
    CHECK ("primary_email" IS NULL OR "primary_email" = lower("primary_email")),
  CONSTRAINT "people_primary_phone_check"
    CHECK ("primary_phone" IS NULL OR "primary_phone" ~ '^\+[1-9][0-9]{6,14}$')
);

CREATE INDEX "people_organisation_id_idx" ON "people"("organisation_id");
CREATE INDEX "people_customer_id_idx"
  ON "people"("organisation_id", "customer_id")
  WHERE "customer_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- person_identities — every handle that reaches a person.
-- ---------------------------------------------------------------------------
--
-- 🚨 ONE HANDLE, ONE PERSON, PER ORGANISATION — AND THE INDEX IS THE RULE.
-- "Never steal a handle" (blueprint §3.3 rule 4) is a unique index, not a
-- convention: a second person cannot claim an address that belongs to a first,
-- so the normaliser in 3.3b either finds the owner or raises a suggestion for a
-- human. Not partial on status: a handle marked inactive (a changed WhatsApp
-- number) still belongs to the person it belonged to.
--
-- ⚠️ THREE KINDS, AND ADDING ONE IS A MIGRATION. `email`, `phone` (E.164) and
-- `wa_id` (WhatsApp's own id, digits) are the handles a code path can produce
-- today. Messenger PSIDs and Instagram IGSIDs are scoped to the Page that
-- received them and need a `channel_connection_id` on this table; that column
-- arrives with the channel, not before — the 0040 rule (a generic SHAPE with a
-- narrow VALUE SET).
--
-- `verification`: how we know this handle is theirs. `inbound` means a message
-- ARRIVED from it — proof of control. `none` means somebody typed it (a form, an
-- import, a client record). Auto-linking on `none` is how a typo merges two
-- strangers; 3.3b links on `inbound` only.
CREATE TABLE "person_identities" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organisation_id" UUID NOT NULL REFERENCES "organisations"("id") ON DELETE CASCADE,
  "person_id"       UUID NOT NULL REFERENCES "people"("id") ON DELETE CASCADE,
  "kind"            TEXT NOT NULL,
  "value"           TEXT NOT NULL,
  "verification"    TEXT NOT NULL DEFAULT 'none',
  "status"          TEXT NOT NULL DEFAULT 'active',
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_by"      UUID,

  CONSTRAINT "person_identities_kind_check"
    CHECK ("kind" IN ('email', 'phone', 'wa_id')),
  CONSTRAINT "person_identities_verification_check"
    CHECK ("verification" IN ('none', 'inbound')),
  CONSTRAINT "person_identities_status_check"
    CHECK ("status" IN ('active', 'inactive')),
  -- The value is normalised BEFORE it gets here, and the database refuses a
  -- row that is not: a mixed-case email or a phone with spaces would be a
  -- second identity for the same handle, which is the duplicate the unique
  -- index below exists to prevent.
  CONSTRAINT "person_identities_value_check"
    CHECK (
      ("kind" = 'email' AND "value" = lower("value")
        AND "value" ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')
      OR ("kind" = 'phone' AND "value" ~ '^\+[1-9][0-9]{6,14}$')
      OR ("kind" = 'wa_id' AND "value" ~ '^[0-9]{6,15}$')
    )
);

CREATE UNIQUE INDEX "person_identities_handle_key"
  ON "person_identities"("organisation_id", "kind", "value");
CREATE INDEX "person_identities_person_id_idx" ON "person_identities"("person_id");

-- ---------------------------------------------------------------------------
-- pipeline_stages — where an enquiry is.
-- ---------------------------------------------------------------------------
--
-- Per organisation, because a custom stage is theirs. The eight SYSTEM stages
-- carry a `system_key` and are what automation reads (3.5); custom stages have
-- none and are cosmetic — Jobber's rule, and the one that keeps the engine
-- honest (blueprint §3.2). Seeded for every organisation by the backfill
-- below, and for a new organisation on its first lead write (3.3b, the
-- `ensureDefaultTemplates` precedent).
CREATE TABLE "pipeline_stages" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organisation_id" UUID NOT NULL REFERENCES "organisations"("id") ON DELETE CASCADE,
  "system_key"      TEXT,
  "name"            TEXT NOT NULL,
  "position"        INTEGER NOT NULL,
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_by"      UUID,
  "deleted_at"      TIMESTAMPTZ(6),

  CONSTRAINT "pipeline_stages_system_key_check"
    CHECK ("system_key" IS NULL OR "system_key" IN (
      'new', 'contacted', 'qualified', 'quoted', 'booked', 'done', 'reviewed', 'lost'
    )),
  CONSTRAINT "pipeline_stages_name_check"
    CHECK (length(btrim("name")) > 0),
  CONSTRAINT "pipeline_stages_position_check"
    CHECK ("position" >= 1),
  -- A system stage cannot be retired: the engine would be reading a stage that
  -- no longer exists.
  CONSTRAINT "pipeline_stages_system_stage_is_permanent_check"
    CHECK ("system_key" IS NULL OR "deleted_at" IS NULL)
);

CREATE INDEX "pipeline_stages_organisation_id_idx" ON "pipeline_stages"("organisation_id");
CREATE UNIQUE INDEX "pipeline_stages_system_key_key"
  ON "pipeline_stages"("organisation_id", "system_key")
  WHERE "system_key" IS NOT NULL;
CREATE UNIQUE INDEX "pipeline_stages_live_name_key"
  ON "pipeline_stages"("organisation_id", lower("name"))
  WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- conversations — one thread per reply handle.
-- ---------------------------------------------------------------------------
--
-- ⚠️ PER HANDLE, NOT PER PERSON (blueprint §8: "one thread per person" is on
-- the do-not-build list). Replies, windows and provider threading are all
-- properties of a handle: Jane's WhatsApp and Jane's email are two threads
-- with two reply rules, and the 360 view joins them AFTER the fact.
--
-- 🔑 `reply_window_expires_at` IS WHY THE SPINE COMES BEFORE THE WHATSAPP REPLY
-- (ruling 73). Meta permits a free-form reply only within 24 hours of the
-- person's last message; outside it only an approved template may go, at a
-- per-message charge from 2026-10-01. That window is a fact about the pair
-- (their number, OUR number) — which is why a WhatsApp thread also names the
-- `channel_connection_id` it arrived at, and the unique index below is per
-- handle AND per asset.
--
-- ⚠️ TWO STATES, NOT FOUR. `pending` and `snoozed` are engine states (3.5) and
-- would be columns nothing sets today.
--
-- `lead_id` is the enquiry currently being worked in this thread. A repeat
-- customer gets a new lead each time and the thread is repointed (ruling 67).
CREATE TABLE "conversations" (
  "id"                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organisation_id"         UUID NOT NULL REFERENCES "organisations"("id") ON DELETE CASCADE,
  "person_id"               UUID NOT NULL REFERENCES "people"("id") ON DELETE CASCADE,
  "person_identity_id"      UUID NOT NULL REFERENCES "person_identities"("id"),
  "channel"                 TEXT NOT NULL,
  -- Which of OUR assets this thread lives on. Required for WhatsApp (the
  -- window is per number pair); null for email, where the sending mailbox is
  -- resolved at send time, every time (ruling 1's rule, one channel over).
  "channel_connection_id"   UUID REFERENCES "channel_connections"("id"),
  "status"                  TEXT NOT NULL DEFAULT 'open',
  "lead_id"                 UUID REFERENCES "leads"("id") ON DELETE SET NULL,
  -- The provider's own thread handle: the RFC Message-ID a reply must quote
  -- to thread in the person's mail client. Null on WhatsApp, which threads by
  -- number.
  "provider_thread_id"      TEXT,
  "last_inbound_at"         TIMESTAMPTZ(6),
  "last_outbound_at"        TIMESTAMPTZ(6),
  "reply_window_expires_at" TIMESTAMPTZ(6),
  "resolved_at"             TIMESTAMPTZ(6),
  "created_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at"              TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_by"              UUID,

  CONSTRAINT "conversations_channel_check"
    CHECK ("channel" IN ('email', 'whatsapp')),
  CONSTRAINT "conversations_status_check"
    CHECK ("status" IN ('open', 'resolved')),
  CONSTRAINT "conversations_resolved_at_check"
    CHECK (("status" = 'resolved') = ("resolved_at" IS NOT NULL)),
  CONSTRAINT "conversations_asset_check"
    CHECK (("channel" = 'whatsapp') = ("channel_connection_id" IS NOT NULL)),
  -- Email has no reply window. A value here on an email thread would be a
  -- number a screen might believe.
  CONSTRAINT "conversations_window_check"
    CHECK ("channel" <> 'email' OR "reply_window_expires_at" IS NULL)
);

CREATE INDEX "conversations_organisation_id_idx" ON "conversations"("organisation_id");
CREATE INDEX "conversations_person_id_idx" ON "conversations"("person_id");
CREATE INDEX "conversations_lead_id_idx"
  ON "conversations"("lead_id")
  WHERE "lead_id" IS NOT NULL;

-- One OPEN thread per handle per asset. COALESCE for the same reason as
-- migration 0040's asset key: NULLs do not collide in a unique index, and an
-- email thread has no asset. Partial, so a resolved thread does not block the
-- next one. Prisma cannot express it; this file is the only record.
CREATE UNIQUE INDEX "conversations_open_thread_key"
  ON "conversations"(
    "organisation_id",
    "person_identity_id",
    COALESCE("channel_connection_id", '00000000-0000-0000-0000-000000000000'::uuid)
  )
  WHERE "status" = 'open';

-- ---------------------------------------------------------------------------
-- messages — the canonical message, whoever wrote it.
-- ---------------------------------------------------------------------------
--
-- ⚠️ THE RAW TABLES STAY. `inbound_messages` and `inbound_channel_messages` are
-- the delivery exactly as it arrived and remain the evidence (ruling 38, and
-- Meta keeps no history). This is the SECOND write: one shape for every
-- channel, so a timeline is one query and a reply window is one column. Every
-- row points back at the raw row it was made from, and `(source_table,
-- source_id)` is unique — one canonical row per delivery, which is also what
-- makes the backfill below re-runnable.
--
-- ⚠️ WRITTEN ONCE. `eva_app` holds SELECT and INSERT and nothing else. A
-- message is what somebody said; editing it afterwards is the thing a
-- compliance record must not allow.
--
-- ⚠️ ONLY THE VALUES A CODE PATH PRODUCES. `note` and `event` directions,
-- `template` / `call` / `review` content types, `ai_disclosed`, `category` and
-- `cost_class` all belong to the slices that write them (3.4 the reply, 3.5
-- the engine, 3.6 the phone). Adding a value is a migration.
CREATE TABLE "messages" (
  "id"                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organisation_id"     UUID NOT NULL REFERENCES "organisations"("id") ON DELETE CASCADE,
  "conversation_id"     UUID NOT NULL REFERENCES "conversations"("id") ON DELETE CASCADE,
  -- Denormalised from the thread so the timeline is one index scan.
  "person_id"           UUID NOT NULL REFERENCES "people"("id") ON DELETE CASCADE,
  "channel"             TEXT NOT NULL,
  "direction"           TEXT NOT NULL,
  "sender_kind"         TEXT NOT NULL,
  "content_type"        TEXT NOT NULL,
  -- Email only (CHECK below). WhatsApp has no subject, and the reply record
  -- already enforces that on its own table (0039).
  "subject"             TEXT,
  "body_text"           TEXT,
  -- The provider's id: Resend's, Meta's `wamid`, or nothing for a reply whose
  -- provider id was never recorded.
  "provider_message_id" TEXT,
  "source_table"        TEXT NOT NULL,
  "source_id"           UUID NOT NULL,
  -- ⚠️ THEIR CLOCK, NOT OURS — `leads.received_at`'s rule. When it was sent,
  -- from the channel's own record.
  "occurred_at"         TIMESTAMPTZ(6) NOT NULL,
  "created_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "messages_channel_check"
    CHECK ("channel" IN ('email', 'whatsapp')),
  CONSTRAINT "messages_direction_check"
    CHECK ("direction" IN ('inbound', 'outbound')),
  CONSTRAINT "messages_sender_kind_check"
    CHECK ("sender_kind" IN ('person', 'user', 'assistant')),
  -- An inbound message is from the person; an outbound one never is.
  CONSTRAINT "messages_sender_matches_direction_check"
    CHECK (("direction" = 'inbound') = ("sender_kind" = 'person')),
  CONSTRAINT "messages_content_type_check"
    CHECK ("content_type" IN ('text', 'media', 'other')),
  CONSTRAINT "messages_subject_is_email_only_check"
    CHECK ("channel" = 'email' OR "subject" IS NULL),
  CONSTRAINT "messages_source_table_check"
    CHECK ("source_table" IN ('inbound_messages', 'inbound_channel_messages', 'lead_reply_decisions'))
);

CREATE INDEX "messages_organisation_id_idx" ON "messages"("organisation_id");
CREATE INDEX "messages_timeline_idx" ON "messages"("person_id", "occurred_at" DESC);
CREATE INDEX "messages_conversation_idx" ON "messages"("conversation_id", "occurred_at");
CREATE UNIQUE INDEX "messages_source_key" ON "messages"("source_table", "source_id");
-- Per channel, like 0040: two providers could mint the same id.
CREATE UNIQUE INDEX "messages_provider_message_key"
  ON "messages"("organisation_id", "channel", "provider_message_id")
  WHERE "provider_message_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- activities — everything on a timeline that is not a message.
-- ---------------------------------------------------------------------------
--
-- One polymorphic table, because "products post activities instead of
-- importing each other" (blueprint §3.2) only works if there is one place to
-- post to. Two kinds today: a human's note (3.3c gives the enquiry screen the
-- box) and a stage change (3.3b sets the first stage; 3.5 moves it). The rest
-- — `call_attempt`, `handoff`, `appointment`, `invoice`, `review_reply` — come
-- with the products that post them.
--
-- ⚠️ IT EXISTS NOW, BEFORE ITS FIRST WRITER, FOR ONE REASON: the
-- `person_timeline` view below unions it with `messages`, and a view that
-- changes shape when the first activity kind lands would change every reader
-- with it. The 0026 precedent (`consent_texts` created because evidence
-- references it).
CREATE TABLE "activities" (
  "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "organisation_id" UUID NOT NULL REFERENCES "organisations"("id") ON DELETE CASCADE,
  "person_id"       UUID NOT NULL REFERENCES "people"("id") ON DELETE CASCADE,
  "lead_id"         UUID REFERENCES "leads"("id") ON DELETE SET NULL,
  "kind"            TEXT NOT NULL,
  "actor_kind"      TEXT NOT NULL,
  "actor_user_id"   UUID REFERENCES "users"("id") ON DELETE SET NULL,
  -- One line a screen can show without knowing the kind.
  "summary"         TEXT NOT NULL,
  "properties"      JSONB NOT NULL DEFAULT '{}'::jsonb,
  "happened_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "created_at"      TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "activities_kind_check"
    CHECK ("kind" IN ('note', 'stage_changed')),
  CONSTRAINT "activities_actor_kind_check"
    CHECK ("actor_kind" IN ('user', 'assistant', 'system')),
  -- A human actor is named; a machine one is not.
  CONSTRAINT "activities_actor_user_check"
    CHECK (("actor_kind" = 'user') = ("actor_user_id" IS NOT NULL)),
  CONSTRAINT "activities_summary_check"
    CHECK (length(btrim("summary")) > 0)
);

CREATE INDEX "activities_organisation_id_idx" ON "activities"("organisation_id");
CREATE INDEX "activities_timeline_idx" ON "activities"("person_id", "happened_at" DESC);
CREATE INDEX "activities_lead_id_idx"
  ON "activities"("lead_id")
  WHERE "lead_id" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- leads — the enquiry, pointing at the person.
-- ---------------------------------------------------------------------------
--
-- Three pointers. The as-captured snapshot (`contact_name`, `contact_email`,
-- `contact_phone`, `enquiry`, `source`) STAYS, because form data is dirty and
-- the record of what somebody typed is worth keeping beside the person we
-- resolved them to.
--
-- ⚠️ ALL THREE NULLABLE, AND `pipeline_stage_id` DELIBERATELY SO. The API that
-- creates leads today does not set a stage; 3.3b does. A NOT NULL here would
-- break every enquiry that arrives between this migration and that deploy.
-- The backfill sets it for every lead that exists; a later migration makes it
-- NOT NULL once every writer supplies it.
--
-- NO ACTION rather than SET NULL on `person_id` and `origin_conversation_id`:
-- an enquiry silently losing its person is the bug nobody would see. Neither
-- can be hard-deleted by the application anyway (REVOKE below), and an
-- organisation delete still cascades cleanly because NO ACTION is checked at
-- the end of the statement, when the leads are gone too.
ALTER TABLE "leads"
  ADD COLUMN "person_id"              UUID REFERENCES "people"("id"),
  ADD COLUMN "pipeline_stage_id"      UUID REFERENCES "pipeline_stages"("id"),
  ADD COLUMN "origin_conversation_id" UUID REFERENCES "conversations"("id");

CREATE INDEX "leads_person_id_idx"
  ON "leads"("person_id")
  WHERE "person_id" IS NOT NULL;
CREATE INDEX "leads_pipeline_stage_id_idx"
  ON "leads"("organisation_id", "pipeline_stage_id");

-- ---------------------------------------------------------------------------
-- leads.source / lead_evidence.channel — a WhatsApp can be an enquiry.
-- ---------------------------------------------------------------------------
--
-- The 0027 rule, unchanged: the CHECK permits the value, the application
-- refuses it until a code path produces it (3.3b's WhatsApp normaliser). The
-- two CHECKs move together because they are the same fact seen from two sides.
ALTER TABLE "leads" DROP CONSTRAINT "leads_source_check";
ALTER TABLE "leads"
  ADD CONSTRAINT "leads_source_check"
    CHECK ("source" IN (
      'email_enquiry',
      -- 3.3b: a message that arrived on the customer's connected WhatsApp.
      'whatsapp_enquiry',
      -- Retired 2026-08-21, kept legal for the records that already exist.
      'missed_call', 'existing_customer', 'callback_request'
    ));

ALTER TABLE "lead_evidence" DROP CONSTRAINT "lead_evidence_channel_check";
ALTER TABLE "lead_evidence"
  ADD CONSTRAINT "lead_evidence_channel_check"
    CHECK ("channel" IN (
      'email_enquiry',
      'whatsapp_enquiry',
      'missed_call', 'existing_customer', 'callback_request'
    ));

-- ---------------------------------------------------------------------------
-- person_timeline — the 360 view, as a view.
-- ---------------------------------------------------------------------------
--
-- 🚨 `security_invoker = true` IS THE WHOLE SECURITY OF THIS VIEW. A view runs
-- with its OWNER's privileges by default, and the owner is the migrations
-- role — which `tenant_isolation` does not bind and which can read every
-- tenant's messages. Without this option, `SELECT * FROM person_timeline` as
-- `eva_app` would return every organisation's timeline regardless of
-- `app.current_org`. With it, the view runs as the caller and the policies on
-- `messages` and `activities` apply. Postgres 15+; local and CI run 16,
-- production 17. `rls.spec.ts` proves it: tenant A reads an empty timeline for
-- tenant B's person.
CREATE VIEW "person_timeline" WITH (security_invoker = true) AS
  SELECT
    m."organisation_id",
    m."person_id",
    'message'::text      AS "item_type",
    m."id"               AS "item_id",
    m."channel",
    m."direction"        AS "detail",
    m."sender_kind"      AS "actor_kind",
    m."subject",
    m."body_text"        AS "summary",
    m."conversation_id",
    NULL::uuid           AS "lead_id",
    m."occurred_at"      AS "happened_at"
  FROM "messages" m
  UNION ALL
  SELECT
    a."organisation_id",
    a."person_id",
    'activity'::text,
    a."id",
    NULL::text,
    a."kind",
    a."actor_kind",
    NULL::text,
    a."summary",
    NULL::uuid,
    a."lead_id",
    a."happened_at"
  FROM "activities" a;

-- ---------------------------------------------------------------------------
-- Row-level security — forced, on every table.
-- ---------------------------------------------------------------------------
ALTER TABLE "people" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "people" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "people"
  USING ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE "person_identities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "person_identities" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "person_identities"
  USING ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE "pipeline_stages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "pipeline_stages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "pipeline_stages"
  USING ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE "conversations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "conversations" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "conversations"
  USING ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE "messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "messages" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "messages"
  USING ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE "activities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "activities" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "activities"
  USING ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Grants — and the REVOKE is the rule, not the GRANT.
-- ---------------------------------------------------------------------------
--
-- ⚠️ DEFAULT PRIVILEGES ALREADY GAVE `eva_app` EVERYTHING ON A TABLE THE OWNER
-- CREATES. Listing verbs below removes nothing; only an explicit REVOKE
-- narrows it (0035's lesson, 0037's, 0040's).
GRANT SELECT, INSERT, UPDATE ON "people" TO eva_app;
-- A person is retired with `deleted_at`, never destroyed: their messages and
-- enquiries are evidence.
REVOKE DELETE ON "people" FROM eva_app;

GRANT SELECT, INSERT, UPDATE ON "person_identities" TO eva_app;
-- A handle is marked inactive, never removed — the unique index is what
-- stops it being claimed by somebody else afterwards.
REVOKE DELETE ON "person_identities" FROM eva_app;

GRANT SELECT, INSERT, UPDATE ON "pipeline_stages" TO eva_app;
REVOKE DELETE ON "pipeline_stages" FROM eva_app;

GRANT SELECT, INSERT, UPDATE ON "conversations" TO eva_app;
REVOKE DELETE ON "conversations" FROM eva_app;

-- Written once. What somebody said cannot be edited or removed afterwards.
GRANT SELECT, INSERT ON "messages" TO eva_app;
REVOKE UPDATE, DELETE ON "messages" FROM eva_app;

-- Likewise: a note or a stage change is a record of something that happened.
GRANT SELECT, INSERT ON "activities" TO eva_app;
REVOKE UPDATE, DELETE ON "activities" FROM eva_app;

-- ⚠️ A VIEW IS A RELATION, AND THE DEFAULT PRIVILEGES APPLY TO IT TOO. The
-- first draft of this migration granted SELECT here and `grants.spec.ts`
-- found `eva_app` holding INSERT, UPDATE and DELETE on the view as well — the
-- same trap as every table above, one relation kind over. A UNION view is not
-- updatable anyway, but a grant that says otherwise is a lie waiting for the
-- day the view is simplified.
GRANT SELECT ON "person_timeline" TO eva_app;
REVOKE INSERT, UPDATE, DELETE ON "person_timeline" FROM eva_app;

-- ---------------------------------------------------------------------------
-- BACKFILL — every row that already exists finds its place in the spine.
-- ---------------------------------------------------------------------------
--
-- Runs as the migrations role, which bypasses RLS (the 0017 and 0034
-- precedent — both backfilled across every organisation). Idempotent: every
-- INSERT skips what a previous run created, so `schema-conventions.spec.ts`
-- can run this exact text twice against fixtures and assert the second run
-- creates nothing.
--
-- Where people come from, in priority order when two records share a handle:
--
--   1. clients (`customers`) with an email or phone — the person who has an
--      invoice history, so a known customer's WhatsApp lands on THEM;
--   2. the people at those clients (`contacts`);
--   3. the enquiries (`leads`) — the as-captured contact details;
--   4. the WhatsApp senders (`inbound_channel_messages`).
--
-- A record whose handle was already won by a higher-priority record attaches
-- its OTHER handles to that record's person, one level deep: a WhatsApp from a
-- number the client book knows becomes a `wa_id` on the client's person, not a
-- stranger. Typed handles (1–3) are `verification = 'none'`; an email enquiry's
-- address and a WhatsApp sender's number are `inbound`, because the message
-- itself proves control.
--
-- Phones: only values that normalise to E.164 without guessing a country —
-- a leading `+` or `00`. A national-format number stays on the lead's snapshot
-- and gets no identity here; 3.3b's normaliser knows the connection's country.
--
-- BACKFILL BEGIN

-- 1. The eight system stages, for every organisation that exists.
INSERT INTO "pipeline_stages" ("organisation_id", "system_key", "name", "position")
SELECT o."id", s."key", s."name", s."position"
FROM "organisations" o
CROSS JOIN (VALUES
  ('new', 'New', 1),
  ('contacted', 'Contacted', 2),
  ('qualified', 'Qualified', 3),
  ('quoted', 'Quoted', 4),
  ('booked', 'Booked', 5),
  ('done', 'Done', 6),
  ('reviewed', 'Reviewed', 7),
  ('lost', 'Lost', 8)
) AS s("key", "name", "position")
WHERE o."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "pipeline_stages" p
    WHERE p."organisation_id" = o."id" AND p."system_key" = s."key"
  );

-- 2. Every candidate handle, normalised, with the record it came from.
CREATE TEMP TABLE "spine_handles" AS
WITH raw AS (
  SELECT c."organisation_id", 'customer'::text AS "origin", 1 AS "priority", c."id" AS "origin_id",
         c."name" AS "display_name", c."id" AS "customer_id",
         c."email" AS "raw_email", c."phone" AS "raw_phone", NULL::text AS "raw_wa_id",
         c."created_at"
  FROM "customers" c
  WHERE c."deleted_at" IS NULL
  UNION ALL
  SELECT ct."organisation_id", 'contact', 2, ct."id",
         ct."name", ct."customer_id",
         ct."email", ct."phone", NULL,
         ct."created_at"
  FROM "contacts" ct
  WHERE ct."deleted_at" IS NULL
  UNION ALL
  SELECT l."organisation_id", 'lead', 3, l."id",
         NULLIF(btrim(COALESCE(l."contact_name", '')), ''), l."customer_id",
         l."contact_email", l."contact_phone", NULL,
         l."created_at"
  FROM "leads" l
  WHERE l."deleted_at" IS NULL
  UNION ALL
  SELECT m."organisation_id", 'whatsapp', 4, m."id",
         NULLIF(btrim(COALESCE(m."from_display_name", '')), ''), NULL,
         NULL, '+' || m."from_identifier", m."from_identifier",
         m."created_at"
  FROM "inbound_channel_messages" m
  WHERE m."channel" = 'whatsapp' AND m."status" IN ('received', 'converted')
),
normalised AS (
  SELECT
    "organisation_id", "origin", "priority", "origin_id", "display_name", "customer_id", "created_at",
    CASE
      WHEN lower(btrim("raw_email")) ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
      THEN lower(btrim("raw_email"))
    END AS "email",
    CASE
      WHEN regexp_replace(COALESCE("raw_phone", ''), '[^0-9+]', '', 'g') ~ '^\+[1-9][0-9]{6,14}$'
      THEN regexp_replace("raw_phone", '[^0-9+]', '', 'g')
      WHEN regexp_replace(COALESCE("raw_phone", ''), '[^0-9+]', '', 'g') ~ '^00[1-9][0-9]{6,14}$'
      THEN '+' || substr(regexp_replace("raw_phone", '[^0-9+]', '', 'g'), 3)
    END AS "phone",
    CASE
      WHEN "raw_wa_id" ~ '^[0-9]{6,15}$' THEN "raw_wa_id"
    END AS "wa_id"
  FROM raw
)
SELECT * FROM normalised
WHERE "email" IS NOT NULL OR "phone" IS NOT NULL OR "wa_id" IS NOT NULL;

-- 3. One winner per handle, skipping handles a person already holds.
CREATE TEMP TABLE "spine_winners" AS
SELECT DISTINCT ON ("organisation_id", "kind", "value")
  "organisation_id", "kind", "value", "origin", "origin_id"
FROM (
  SELECT "organisation_id", 'email'::text AS "kind", "email" AS "value", "origin", "priority", "origin_id", "created_at"
  FROM "spine_handles" WHERE "email" IS NOT NULL
  UNION ALL
  SELECT "organisation_id", 'phone', "phone", "origin", "priority", "origin_id", "created_at"
  FROM "spine_handles" WHERE "phone" IS NOT NULL
  UNION ALL
  SELECT "organisation_id", 'wa_id', "wa_id", "origin", "priority", "origin_id", "created_at"
  FROM "spine_handles" WHERE "wa_id" IS NOT NULL
) h
WHERE NOT EXISTS (
  SELECT 1 FROM "person_identities" pi
  WHERE pi."organisation_id" = h."organisation_id" AND pi."kind" = h."kind" AND pi."value" = h."value"
)
ORDER BY "organisation_id", "kind", "value", "priority", "created_at", "origin_id";

-- 4. Each record's anchor: the record that won its email, else its phone, else
--    its WhatsApp id, else itself. Then the anchor's anchor, which is as deep
--    as a chain can go (a record that won an email handle holds that email, so
--    it anchors to itself).
CREATE TEMP TABLE "spine_anchors" AS
WITH first_hop AS (
  SELECT
    h."organisation_id", h."origin", h."origin_id",
    COALESCE(we."origin", wp."origin", ww."origin", h."origin") AS "anchor_origin",
    COALESCE(we."origin_id", wp."origin_id", ww."origin_id", h."origin_id") AS "anchor_id"
  FROM "spine_handles" h
  LEFT JOIN "spine_winners" we
    ON we."organisation_id" = h."organisation_id" AND we."kind" = 'email' AND we."value" = h."email"
  LEFT JOIN "spine_winners" wp
    ON wp."organisation_id" = h."organisation_id" AND wp."kind" = 'phone' AND wp."value" = h."phone"
  LEFT JOIN "spine_winners" ww
    ON ww."organisation_id" = h."organisation_id" AND ww."kind" = 'wa_id' AND ww."value" = h."wa_id"
)
SELECT
  a."organisation_id", a."origin", a."origin_id",
  b."anchor_origin" AS "root_origin", b."anchor_id" AS "root_id"
FROM first_hop a
JOIN first_hop b
  ON b."organisation_id" = a."organisation_id" AND b."origin" = a."anchor_origin" AND b."origin_id" = a."anchor_id";

-- 5. One person per root that won at least one handle.
CREATE TEMP TABLE "spine_people" AS
SELECT DISTINCT ON (r."organisation_id", r."root_origin", r."root_id")
  gen_random_uuid() AS "id",
  r."organisation_id", r."root_origin" AS "origin", r."root_id" AS "origin_id",
  COALESCE(h."display_name", h."email", h."phone") AS "display_name",
  h."customer_id",
  h."email" AS "primary_email",
  h."phone" AS "primary_phone"
FROM "spine_anchors" r
JOIN "spine_handles" h
  ON h."organisation_id" = r."organisation_id" AND h."origin" = r."root_origin" AND h."origin_id" = r."root_id"
WHERE EXISTS (
  SELECT 1 FROM "spine_winners" w
  JOIN "spine_anchors" wa
    ON wa."organisation_id" = w."organisation_id" AND wa."origin" = w."origin" AND wa."origin_id" = w."origin_id"
  WHERE wa."root_origin" = r."root_origin" AND wa."root_id" = r."root_id" AND wa."organisation_id" = r."organisation_id"
)
ORDER BY r."organisation_id", r."root_origin", r."root_id";

INSERT INTO "people" ("id", "organisation_id", "display_name", "customer_id", "primary_email", "primary_phone")
SELECT "id", "organisation_id", "display_name", "customer_id", "primary_email", "primary_phone"
FROM "spine_people";

-- 6. Every won handle becomes an identity on its root's person.
INSERT INTO "person_identities" ("organisation_id", "person_id", "kind", "value", "verification")
SELECT
  w."organisation_id", p."id", w."kind", w."value",
  CASE
    -- Proof of control is proof whoever won the handle: an address a delivery
    -- arrived from, or a number a WhatsApp came from, is theirs even when the
    -- client book typed it first.
    WHEN w."kind" = 'email' AND EXISTS (
      SELECT 1 FROM "inbound_messages" im
      JOIN "leads" l ON l."id" = im."lead_id"
      WHERE l."organisation_id" = w."organisation_id"
        AND lower(btrim(l."contact_email")) = w."value"
    ) THEN 'inbound'
    WHEN w."kind" IN ('phone', 'wa_id') AND EXISTS (
      SELECT 1 FROM "inbound_channel_messages" m
      WHERE m."organisation_id" = w."organisation_id"
        AND m."status" IN ('received', 'converted')
        AND (m."from_identifier" = w."value" OR '+' || m."from_identifier" = w."value")
    ) THEN 'inbound'
    ELSE 'none'
  END
FROM "spine_winners" w
JOIN "spine_anchors" a
  ON a."organisation_id" = w."organisation_id" AND a."origin" = w."origin" AND a."origin_id" = w."origin_id"
JOIN "spine_people" p
  ON p."organisation_id" = a."organisation_id" AND p."origin" = a."root_origin" AND p."origin_id" = a."root_id";

-- 7. Every enquiry points at its person: by its email, else by its phone.
UPDATE "leads" l
SET "person_id" = pi."person_id"
FROM "spine_handles" h
JOIN "person_identities" pi
  ON pi."organisation_id" = h."organisation_id"
 AND ((pi."kind" = 'email' AND pi."value" = h."email") OR (pi."kind" = 'phone' AND pi."value" = h."phone"))
WHERE h."origin" = 'lead' AND h."origin_id" = l."id"
  AND l."person_id" IS NULL
  AND pi."kind" = (CASE WHEN h."email" IS NOT NULL THEN 'email' ELSE 'phone' END);

-- 8. Email threads: one open thread per sender address that has an enquiry,
--    pointing at that address's NEWEST enquiry, threaded on the first
--    message's RFC id.
INSERT INTO "conversations" ("organisation_id", "person_id", "person_identity_id", "channel", "status", "lead_id", "provider_thread_id", "created_at")
SELECT DISTINCT ON (l."organisation_id", pi."id")
  l."organisation_id", pi."person_id", pi."id", 'email', 'open', l."id",
  (SELECT im2."rfc_message_id" FROM "inbound_messages" im2
     JOIN "leads" l2 ON l2."id" = im2."lead_id"
    WHERE l2."person_id" = pi."person_id" AND lower(btrim(l2."contact_email")) = pi."value"
    ORDER BY im2."received_at" ASC LIMIT 1),
  (SELECT min(im3."received_at") FROM "inbound_messages" im3
     JOIN "leads" l3 ON l3."id" = im3."lead_id"
    WHERE l3."person_id" = pi."person_id" AND lower(btrim(l3."contact_email")) = pi."value")
FROM "inbound_messages" im
JOIN "leads" l ON l."id" = im."lead_id"
JOIN "person_identities" pi
  ON pi."organisation_id" = l."organisation_id" AND pi."kind" = 'email' AND pi."value" = lower(btrim(l."contact_email"))
WHERE l."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "conversations" c
    WHERE c."organisation_id" = l."organisation_id" AND c."person_identity_id" = pi."id" AND c."status" = 'open'
  )
ORDER BY l."organisation_id", pi."id", l."received_at" DESC;

-- 9. Every email delivery that became an enquiry is a message on its thread.
INSERT INTO "messages" ("organisation_id", "conversation_id", "person_id", "channel", "direction", "sender_kind", "content_type", "subject", "body_text", "provider_message_id", "source_table", "source_id", "occurred_at")
SELECT
  im."organisation_id", c."id", c."person_id", 'email', 'inbound', 'person',
  CASE WHEN im."text_body" IS NOT NULL OR im."html_body" IS NOT NULL THEN 'text' ELSE 'other' END,
  im."subject", im."text_body", im."provider_message_id", 'inbound_messages', im."id", im."received_at"
FROM "inbound_messages" im
JOIN "leads" l ON l."id" = im."lead_id"
JOIN "person_identities" pi
  ON pi."organisation_id" = l."organisation_id" AND pi."kind" = 'email' AND pi."value" = lower(btrim(l."contact_email"))
JOIN "conversations" c
  ON c."organisation_id" = l."organisation_id" AND c."person_identity_id" = pi."id" AND c."channel" = 'email' AND c."status" = 'open'
WHERE NOT EXISTS (
  SELECT 1 FROM "messages" m WHERE m."source_table" = 'inbound_messages' AND m."source_id" = im."id"
);

-- 10. WhatsApp threads: one open thread per sender per number of ours, with
--     the 24-hour window measured from their newest message. It may already
--     have expired; that is the truth, not a fault.
INSERT INTO "conversations" ("organisation_id", "person_id", "person_identity_id", "channel", "channel_connection_id", "status", "created_at")
SELECT DISTINCT ON (m."organisation_id", pi."id", m."connection_id")
  m."organisation_id", pi."person_id", pi."id", 'whatsapp', m."connection_id", 'open', m."received_at"
FROM "inbound_channel_messages" m
JOIN "person_identities" pi
  ON pi."organisation_id" = m."organisation_id" AND pi."kind" = 'wa_id' AND pi."value" = m."from_identifier"
WHERE m."channel" = 'whatsapp' AND m."status" IN ('received', 'converted')
  AND NOT EXISTS (
    SELECT 1 FROM "conversations" c
    WHERE c."organisation_id" = m."organisation_id" AND c."person_identity_id" = pi."id"
      AND c."channel_connection_id" = m."connection_id" AND c."status" = 'open'
  )
ORDER BY m."organisation_id", pi."id", m."connection_id", m."received_at" ASC;

-- 11. Every WhatsApp delivery is a message on its thread.
INSERT INTO "messages" ("organisation_id", "conversation_id", "person_id", "channel", "direction", "sender_kind", "content_type", "body_text", "provider_message_id", "source_table", "source_id", "occurred_at")
SELECT
  m."organisation_id", c."id", c."person_id", 'whatsapp', 'inbound', 'person',
  CASE
    WHEN m."message_type" = 'text' THEN 'text'
    WHEN m."message_type" IN ('image', 'audio', 'video', 'document', 'sticker') THEN 'media'
    ELSE 'other'
  END,
  m."text_body", m."provider_message_id", 'inbound_channel_messages', m."id", m."received_at"
FROM "inbound_channel_messages" m
JOIN "person_identities" pi
  ON pi."organisation_id" = m."organisation_id" AND pi."kind" = 'wa_id' AND pi."value" = m."from_identifier"
JOIN "conversations" c
  ON c."organisation_id" = m."organisation_id" AND c."person_identity_id" = pi."id"
 AND c."channel_connection_id" = m."connection_id" AND c."status" = 'open'
WHERE m."channel" = 'whatsapp' AND m."status" IN ('received', 'converted')
  AND NOT EXISTS (
    SELECT 1 FROM "messages" x WHERE x."source_table" = 'inbound_channel_messages' AND x."source_id" = m."id"
  );

-- 12. Every reply Eva actually sent is an outbound message on the enquiry's
--     thread. `lead_reply_decisions` is the lead product's own table; the
--     migration reads it as data, which the architecture walls do not govern.
INSERT INTO "messages" ("organisation_id", "conversation_id", "person_id", "channel", "direction", "sender_kind", "content_type", "subject", "body_text", "source_table", "source_id", "occurred_at")
SELECT
  d."organisation_id", c."id", c."person_id", d."channel", 'outbound', 'assistant', 'text',
  d."subject", d."body", 'lead_reply_decisions', d."id", d."sent_at"
FROM "lead_reply_decisions" d
JOIN "leads" l ON l."id" = d."lead_id"
JOIN "person_identities" pi
  ON pi."organisation_id" = l."organisation_id" AND pi."kind" = 'email' AND pi."value" = lower(btrim(l."contact_email"))
JOIN "conversations" c
  ON c."organisation_id" = l."organisation_id" AND c."person_identity_id" = pi."id" AND c."channel" = 'email' AND c."status" = 'open'
WHERE d."status" = 'sent' AND d."channel" = 'email' AND d."sent_at" IS NOT NULL AND d."deleted_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "messages" x WHERE x."source_table" = 'lead_reply_decisions' AND x."source_id" = d."id"
  );

-- 13. The thread's clocks, from its messages.
UPDATE "conversations" c
SET
  "last_inbound_at"  = s."last_inbound_at",
  "last_outbound_at" = s."last_outbound_at",
  "reply_window_expires_at" = CASE
    WHEN c."channel" = 'whatsapp' THEN s."last_inbound_at" + interval '24 hours'
  END
FROM (
  SELECT
    "conversation_id",
    max("occurred_at") FILTER (WHERE "direction" = 'inbound')  AS "last_inbound_at",
    max("occurred_at") FILTER (WHERE "direction" = 'outbound') AS "last_outbound_at"
  FROM "messages"
  GROUP BY "conversation_id"
) s
WHERE s."conversation_id" = c."id";

-- 14. Every enquiry that arrived as a delivery remembers the thread it opened.
UPDATE "leads" l
SET "origin_conversation_id" = c."id"
FROM "inbound_messages" im
JOIN "person_identities" pi
  ON pi."kind" = 'email'
JOIN "conversations" c
  ON c."person_identity_id" = pi."id" AND c."channel" = 'email' AND c."status" = 'open'
WHERE im."lead_id" = l."id"
  AND pi."organisation_id" = l."organisation_id" AND pi."value" = lower(btrim(l."contact_email"))
  AND l."origin_conversation_id" IS NULL;

-- 15. Every enquiry gets a stage: `contacted` if Eva has answered it, else
--     `new`. `do_not_contact` is a status, not a stage, and stays where it is.
UPDATE "leads" l
SET "pipeline_stage_id" = p."id"
FROM "pipeline_stages" p
WHERE p."organisation_id" = l."organisation_id"
  AND p."system_key" = CASE WHEN l."first_responded_at" IS NOT NULL THEN 'contacted' ELSE 'new' END
  AND l."pipeline_stage_id" IS NULL;

DROP TABLE "spine_people";
DROP TABLE "spine_anchors";
DROP TABLE "spine_winners";
DROP TABLE "spine_handles";

-- BACKFILL END
