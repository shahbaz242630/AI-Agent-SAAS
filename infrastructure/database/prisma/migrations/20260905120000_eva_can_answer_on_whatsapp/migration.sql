-- Migration 0044: Eva can answer on WhatsApp (slice 3.4a).
--
-- Migration 0039 gave a wording and a decision a `channel`, and listed exactly
-- one value — `email` — with the note that adding a channel is a migration and
-- that listing `whatsapp` before anything could send on it would permit rows
-- no code path handles. This is that migration, shipped in the same PR as the
-- code that sends, and not a day earlier.
--
-- ⚠️ TWO CHECKS WIDEN IN LOCKSTEP, THE 0027 RULE. A template on a channel Eva
-- cannot decide for, or a decision on a channel with no wording, would each be
-- half a feature; the reply path reads both tables in one transaction.
--
-- ⚠️ NOTHING ELSE CHANGES SHAPE, AND THAT WAS CHECKED RATHER THAN ASSUMED.
-- `lead_reply_decisions.to_address` reads as "recipient" and takes an E.164
-- number (0039 said so); `subject` is already nullable and
-- `lead_reply_decisions_subject_is_email_only_check` keeps it NULL off email;
-- the id Meta gives what Eva sent goes on `messages.provider_message_id`
-- (0041, unique per organisation and channel), not on a new column here.
-- Existing rows are all `email` and satisfy the new CHECKs unchanged.

ALTER TABLE "lead_reply_templates"
  DROP CONSTRAINT "lead_reply_templates_channel_check";

ALTER TABLE "lead_reply_templates"
  ADD CONSTRAINT "lead_reply_templates_channel_check"
    CHECK ("channel" IN ('email', 'whatsapp'));

ALTER TABLE "lead_reply_decisions"
  DROP CONSTRAINT "lead_reply_decisions_channel_check";

ALTER TABLE "lead_reply_decisions"
  ADD CONSTRAINT "lead_reply_decisions_channel_check"
    CHECK ("channel" IS NULL OR "channel" IN ('email', 'whatsapp'));
