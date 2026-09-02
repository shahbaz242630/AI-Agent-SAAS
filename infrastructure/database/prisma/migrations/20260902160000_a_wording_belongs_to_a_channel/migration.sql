-- Slice 3.2b — migration 0039: a wording belongs to a channel.
--
-- Founder ruling 63 (2026-09-02): **separate reply wordings per channel.** The
-- shipped email default says *"replying to this email is the quickest way to
-- reach us"*, which is literally wrong on WhatsApp. One automatic reply per
-- CHANNEL, not one per organisation.
--
-- ⚠️ NO CHANNEL BUT EMAIL EXISTS YET, AND THAT IS THE POINT OF SHIPPING THIS
-- ALONE. This migration changes an invariant that the whole reply path depends
-- on — "exactly one automatic reply" — from being enforced per organisation to
-- per organisation per channel. Doing that in the same slice that adds WhatsApp
-- would mean a broken reply could be either a schema fault or a channel fault,
-- and telling them apart afterwards is far more expensive than one extra merge.
--
-- ⚠️ THE VOCABULARY IS DELIBERATELY NOT `leads.source`'S. That column says
-- `email_enquiry` and describes how an enquiry ARRIVED. This one describes the
-- medium Eva REPLIES on. They are the same wire in opposite directions, and a
-- reply template called `email_enquiry` would be a lie about its own direction.
-- The mapping between them lives in one function in the code.

-- ---------------------------------------------------------------------------
-- lead_reply_templates
-- ---------------------------------------------------------------------------

-- ⚠️ DEFAULT, THEN DROP THE DEFAULT — migration 0034's precedent. Every existing
-- row was written when email was the only thing Eva could send, so `email` is
-- not a guess, it is the only value those rows could truthfully carry. Dropping
-- the default afterwards is what stops a future INSERT silently picking a
-- channel because somebody forgot to name one.
ALTER TABLE "lead_reply_templates"
  ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'email';

ALTER TABLE "lead_reply_templates" ALTER COLUMN "channel" DROP DEFAULT;

-- ⚠️ ONE VALUE TODAY, AND ADDING A CHANNEL IS A MIGRATION. That is this
-- project's stated position on CHECK constraints (migration 0025: *"adding a
-- product means a migration; that is the point of the constraint"*). Listing
-- `whatsapp`, `messenger` and `instagram` here before anything can produce them
-- would permit rows no code path handles — the migration 0024 `ends_at` trap,
-- where a column holds values that decide nothing.
ALTER TABLE "lead_reply_templates"
  ADD CONSTRAINT "lead_reply_templates_channel_check"
    CHECK ("channel" IN ('email'));

-- ⚠️ BOTH UNIQUE INDEXES WIDEN, AND MISSING EITHER BREAKS A DIFFERENT THING.
--
-- The automatic index is the invariant ruling 55 rests on. Left per-organisation
-- it would forbid a WhatsApp automatic reply the moment an email one existed —
-- so a customer connecting WhatsApp would find they could not switch on the one
-- feature the channel is for, with a unique-violation as the only explanation.
DROP INDEX "lead_reply_templates_single_automatic_key";

CREATE UNIQUE INDEX "lead_reply_templates_single_automatic_key"
  ON "lead_reply_templates"("organisation_id", "channel")
  WHERE "is_automatic" AND "deleted_at" IS NULL;

-- The name index is what makes the lazy seeding idempotent without a
-- bookkeeping column. Left per-organisation, seeding WhatsApp's defaults would
-- collide with email's "Standard reply" and the customer would get a channel
-- with no wordings at all — silently, because the seed swallows conflicts.
DROP INDEX "lead_reply_templates_live_name_key";

CREATE UNIQUE INDEX "lead_reply_templates_live_name_key"
  ON "lead_reply_templates"("organisation_id", "channel", lower("name"))
  WHERE "deleted_at" IS NULL;

-- ---------------------------------------------------------------------------
-- lead_reply_decisions
-- ---------------------------------------------------------------------------
--
-- What Eva decided, and what she sent. It needs the channel for the same reason
-- it stores the body rather than the template id: this is the record of what a
-- stranger actually received, and "by which means" is part of that.
--
-- 🚨 NULLABLE HERE, UNLIKE ON THE TEMPLATES TABLE, AND THE ASYMMETRY IS THE
-- POINT. A template always has a channel — somebody wrote it for one. A
-- DECISION may not: `leads.source` still legally holds the three retired
-- call-shaped values (migration 0027 kept them legal because `lead_evidence` is
-- immutable and one real production lead is a `callback_request`), and there is
-- no channel Eva could answer those on.
--
-- NULL therefore means "no channel could be determined, and nothing was sent" —
-- a state that must be storable, because the alternative is writing `email` on
-- a row where email was never the answer. That is falsifying the one record we
-- keep of what a stranger did or did not receive.
--
-- Existing rows are backfilled to `email` because the email path is the only
-- thing that has ever written this table.
ALTER TABLE "lead_reply_decisions"
  ADD COLUMN "channel" TEXT;

UPDATE "lead_reply_decisions" SET "channel" = 'email' WHERE "channel" IS NULL;

ALTER TABLE "lead_reply_decisions"
  ADD CONSTRAINT "lead_reply_decisions_channel_check"
    CHECK ("channel" IS NULL OR "channel" IN ('email'));

-- ⚠️ AND A NULL CHANNEL CAN NEVER BE A SENT REPLY. If nothing could be
-- determined to answer on, nothing went out — so the row must be terminal and
-- empty-handed. Without this, "we did not know how to reply" and "we replied"
-- are both expressible on the same row.
ALTER TABLE "lead_reply_decisions"
  ADD CONSTRAINT "lead_reply_decisions_null_channel_sent_nothing_check"
    CHECK ("channel" IS NOT NULL OR ("status" <> 'sent' AND "sent_at" IS NULL));

-- ⚠️ `to_address` AND `subject` KEEP THEIR EMAIL NAMES, DELIBERATELY.
--
-- A WhatsApp reply has a recipient (a phone number) and no subject at all.
-- Renaming `to_address` now would touch every read and write of this table for
-- a channel that does not exist yet, and `subject` is already nullable, which is
-- exactly what a channel without one needs. The honest note is here rather than
-- a rename: when WhatsApp lands, `to_address` holds an E.164 number and
-- `subject` stays NULL, and the CHECK below is what stops that being silent.
--
-- Migration 0036 already refuses a `sent` row with no body. This adds the rule
-- that only email may carry a subject, so a WhatsApp row that somehow acquired
-- one is a fault at write time rather than a puzzle in the audit trail later.
ALTER TABLE "lead_reply_decisions"
  ADD CONSTRAINT "lead_reply_decisions_subject_is_email_only_check"
    CHECK ("channel" = 'email' OR "subject" IS NULL);
