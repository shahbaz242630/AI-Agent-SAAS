-- Slice 3.0 — migration 0025: lead follow-up is TWO products, not one.
--
-- Founder ruling 2026-08-19: chasing a new enquiry by EMAIL and chasing one by
-- PHONE are separate purchases. They need different machinery (a mailbox versus
-- a voice stack), they will not cost the same, and a plumber who wants his
-- enquiries emailed back should not be sold a telephony bill.
--
-- `module_key` is guarded by a CHECK (migration 0018 precedent), so the list of
-- products is a database constraint and not merely a TypeScript union. Adding a
-- product means a migration; that is the point of the constraint.

-- The CHECK has to come off before any row can be moved to a value it does not
-- yet permit. Dropped, data moved, re-added — in that order, one transaction.
ALTER TABLE "organisation_modules"
  DROP CONSTRAINT IF EXISTS "organisation_modules_module_key_check";

-- ⚠️ MAPPED, NOT DELETED, AND THE DISTINCTION MATTERS.
--
-- `lead_follow_up_agent` was a placeholder: nothing was ever built behind it and
-- `PERMISSION_MODULE` granted it nothing. But it WAS switchable-on before
-- 2026-08-18 — that is exactly the phantom-products defect, where the screen
-- offered a live "Turn on" button for a product that did not exist. So a row may
-- survive in an environment this agent cannot read (production is not queried
-- from here), and a migration that assumed otherwise would fail on the one
-- database that matters.
--
-- Deleting the row would silently take away an entitlement somebody may have
-- paid attention to. Mapping it onto the email variant keeps the record and
-- costs nothing: neither product is built, so neither grants any capability.
-- Local `eva` had zero such rows when this was written; this statement is
-- therefore expected to affect nothing, and is here because "expected" is not
-- "guaranteed".
UPDATE "organisation_modules"
   SET "module_key" = 'lead_follow_up_email'
 WHERE "module_key" = 'lead_follow_up_agent';

ALTER TABLE "organisation_modules"
  ADD CONSTRAINT "organisation_modules_module_key_check"
    CHECK ("module_key" IN (
      'email_credit_controller',
      'voice_credit_controller',
      'lead_follow_up_email',
      'lead_follow_up_voice',
      'ai_receptionist'
    ));
