-- Migration 0045: a wording belongs to a playbook (slice 3.5a, ruling 93).
--
-- Until today one flag picked the wording Eva sends — `is_automatic`, one per
-- organisation per channel — and every other wording a customer kept was
-- stored and read by nothing. The founder's question of 2026-09-05 (*"how is
-- out of hours activated? shouldn't there be a toggle?"*) has no answer in
-- that shape: there is nothing to toggle, and "Out of hours" is a name, not a
-- behaviour.
--
-- 🔑 THE SHAPE FROM HERE: A PLAYBOOK IS ONE THING EVA DOES ON HER OWN, WITH A
-- SWITCH, AND A WORDING BELONGS TO ONE PLAYBOOK ON ONE CHANNEL (blueprint
-- §3.6, ruling 71: "on/off, a wording box per channel, one or two numbers,
-- and nothing else"). `lead_playbooks` holds the switch; `playbook_key` on a
-- wording says which card it is the words of. The instant reply — today's
-- automatic wording — is the first playbook; the out-of-hours reply is the
-- second; the nudge, the quote chase and the owner alert are CHECK-admitted
-- now and arrive with the slices that run them (3.5c, 3.5d), because a key the
-- database refuses is a migration per card.
--
-- ⚠️ `is_automatic` IS DROPPED, NOT KEPT BESIDE THE NEW COLUMN. Two columns
-- saying one thing is how a screen comes to lie: `playbook_key = 'instant_reply'`
-- IS "the wording Eva sends the moment an enquiry arrives", and a second flag
-- that could disagree with it would need a CHECK, a test and an explanation.
-- The partial unique index that enforced "one automatic per channel" is
-- replaced by one that enforces "one wording per playbook per channel".
--
-- ⚠️ THE BACKFILL BINDS BY MEANING, THEN BY NAME. Every live automatic wording
-- becomes the instant reply — that is exactly what it was. A live wording still
-- called "Out of hours" (the seed's own name; a customer who renamed theirs
-- kept the name a customer chose) becomes the out-of-hours reply. Everything
-- else keeps a NULL key: kept, not deleted, and invisible to the new screen,
-- because a wording bound to no behaviour is one nothing reads — which is what
-- it always was. The switch rows are written for every organisation that has
-- a wording to switch: instant reply ON (it was sending), out of hours OFF
-- (it never did anything, and nothing new sends by surprise).
--
-- ⚠️ THE NUMBERS ON A CARD ARE NOT HERE. `delay_hours`, `max_touches` and the
-- like arrive with the playbook that reads them (3.5c) — a column with one
-- value that nothing reads is the `endsAt` trap.

-- ---------------------------------------------------------------------------
-- The switch per behaviour.
-- ---------------------------------------------------------------------------

CREATE TABLE "lead_playbooks" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organisation_id" UUID NOT NULL,
  -- Which behaviour. The five the blueprint names for Lead Follow-up; the
  -- CHECK is the list, and adding a card is a migration.
  "key" TEXT NOT NULL,
  -- ⚠️ DEFAULT OFF. A row that exists but was never switched on must mean
  -- silence, so that nothing a later slice seeds can start sending by itself.
  -- The instant reply is the one exception, switched on by the backfill below
  -- and by the seed, because it is the thing the product has always done.
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  "created_by" UUID,
  "deleted_at" TIMESTAMPTZ(6),

  CONSTRAINT "lead_playbooks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "lead_playbooks_organisation_id_fkey"
    FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE,
  CONSTRAINT "lead_playbooks_key_check"
    CHECK ("key" IN ('instant_reply', 'after_hours', 'no_reply_nudge', 'quote_chase', 'owner_alert'))
);

CREATE INDEX "lead_playbooks_organisation_id_idx" ON "lead_playbooks"("organisation_id");

-- One switch per behaviour per organisation, among the live rows.
CREATE UNIQUE INDEX "lead_playbooks_live_key_key"
  ON "lead_playbooks"("organisation_id", "key")
  WHERE "deleted_at" IS NULL;

-- Row-level security: the same tenant boundary as every other table, the
-- 0035 pattern (`app.current_org`, with the NULLIF that stops an empty string
-- throwing on the cast).
ALTER TABLE "lead_playbooks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "lead_playbooks" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "lead_playbooks"
  USING ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK ("organisation_id" = NULLIF(current_setting('app.current_org', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON "lead_playbooks" TO eva_app;

-- ⚠️ THE REVOKE IS THE RULE; THE GRANT ABOVE DOES NOTHING ON ITS OWN (0035).
-- A switch is retired with `deleted_at`, never destroyed: the audit trail says
-- when a behaviour was switched on and off, and the row it names must exist.
REVOKE DELETE ON "lead_playbooks" FROM eva_app;

-- ---------------------------------------------------------------------------
-- A wording says which card it belongs to.
-- ---------------------------------------------------------------------------

ALTER TABLE "lead_reply_templates" ADD COLUMN "playbook_key" TEXT;

-- The same list as `lead_playbooks_key_check`, and the two widen in lockstep
-- (the 0044 rule): a wording for a card that cannot exist is half a feature.
ALTER TABLE "lead_reply_templates"
  ADD CONSTRAINT "lead_reply_templates_playbook_key_check"
    CHECK ("playbook_key" IS NULL
      OR "playbook_key" IN ('instant_reply', 'after_hours', 'no_reply_nudge', 'quote_chase', 'owner_alert'));

-- One wording per playbook per channel among the live rows — the successor of
-- `lead_reply_templates_single_automatic_key`, which said "one automatic
-- wording per channel". A card has one box per channel; two rows for one box
-- is not a state the database will hold.
CREATE UNIQUE INDEX "lead_reply_templates_live_playbook_key"
  ON "lead_reply_templates"("organisation_id", "channel", "playbook_key")
  WHERE "deleted_at" IS NULL AND "playbook_key" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The backfill: what was automatic is the instant reply; what was called
-- "Out of hours" is the out-of-hours reply; the switches follow the wordings.
-- ---------------------------------------------------------------------------

-- BACKFILL BEGIN
UPDATE "lead_reply_templates"
SET "playbook_key" = 'instant_reply'
WHERE "is_automatic" AND "deleted_at" IS NULL;

-- By the seed's name, among the live wordings not already bound. A customer
-- who promoted "Out of hours" to automatic has it as the instant reply above
-- and gets no out-of-hours wording — which is what they chose.
-- `lead_reply_templates_live_name_key` is one name per organisation per
-- channel among live rows, so this binds at most one per channel.
UPDATE "lead_reply_templates"
SET "playbook_key" = 'after_hours'
WHERE "playbook_key" IS NULL
  AND "deleted_at" IS NULL
  AND lower(btrim("name")) = 'out of hours';

-- The switches. Instant reply ON wherever a wording was sending; out of hours
-- OFF wherever its wording exists, so the card is there to switch on once
-- opening hours are set. `created_by` NULL: nobody pressed anything.
INSERT INTO "lead_playbooks" ("organisation_id", "key", "enabled", "updated_at")
SELECT DISTINCT "organisation_id", 'instant_reply', true, now()
FROM "lead_reply_templates"
WHERE "playbook_key" = 'instant_reply' AND "deleted_at" IS NULL;

INSERT INTO "lead_playbooks" ("organisation_id", "key", "enabled", "updated_at")
SELECT DISTINCT "organisation_id", 'after_hours', false, now()
FROM "lead_reply_templates"
WHERE "playbook_key" = 'after_hours' AND "deleted_at" IS NULL;
-- BACKFILL END

-- ---------------------------------------------------------------------------
-- The old flag goes, and its index with it.
-- ---------------------------------------------------------------------------

DROP INDEX "lead_reply_templates_single_automatic_key";

ALTER TABLE "lead_reply_templates" DROP COLUMN "is_automatic";
