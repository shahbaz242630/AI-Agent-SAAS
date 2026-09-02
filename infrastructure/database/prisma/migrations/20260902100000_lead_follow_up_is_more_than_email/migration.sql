-- Slice 3.2a — migration 0038: the lead product is no longer an email product.
--
-- Founder ruling 2026-09-02: lead follow-up becomes ONE feature covering email,
-- WhatsApp, Facebook Messenger and Instagram DMs, sold together rather than as
-- separate channel purchases. `lead_follow_up_email` was named on 2026-08-19
-- (migration 0025) to distinguish answering an enquiry by EMAIL from answering
-- one by CALL. That distinction survives — `lead_follow_up_voice` is still a
-- separate product, ruling 14 — but the line between them is no longer
-- "email versus phone", it is "typed channels versus a phone call".
--
-- ⚠️ RENAMED NOW BECAUSE THERE IS EXACTLY ONE ROW IN THE WORLD THAT HOLDS THE
-- OLD VALUE. Production carries a single `organisation_modules` row on
-- `lead_follow_up_email` — the founder's test organisation, enabled by hand
-- (handoff §7) — and no `email_accounts` row at all. Counted before writing
-- this, not assumed. Every later day is a day where that number is larger and
-- some of those rows belong to somebody who is paying us.
--
-- ⚠️ THE VALUE IS A CHECK ON TWO TABLES, NOT ONE. `organisation_modules` has
-- guarded the product list since migration 0018; `email_accounts` gained the
-- same guard on 2026-09-01 (migration 0034), when a mailbox started belonging
-- to a product. A rename that moved the data and updated one constraint would
-- leave the other refusing the new value — and it would only fail the first
-- time somebody connected a mailbox, long after this migration looked fine.

-- ─────────────────────────────────────────────────────────────────────────────
-- organisation_modules — which products an organisation holds.
-- ─────────────────────────────────────────────────────────────────────────────

-- The CHECK has to come off before any row can be moved to a value it does not
-- yet permit. Dropped, data moved, re-added — in that order, one transaction.
-- This is migration 0025's own shape, which did this exact rename once before.
ALTER TABLE "organisation_modules"
  DROP CONSTRAINT IF EXISTS "organisation_modules_module_key_check";

UPDATE "organisation_modules"
   SET "module_key" = 'lead_follow_up'
 WHERE "module_key" = 'lead_follow_up_email';

ALTER TABLE "organisation_modules"
  ADD CONSTRAINT "organisation_modules_module_key_check"
    CHECK ("module_key" IN (
      'email_credit_controller',
      'voice_credit_controller',
      'lead_follow_up',
      'lead_follow_up_voice',
      'ai_receptionist'
    ));

-- ─────────────────────────────────────────────────────────────────────────────
-- email_accounts — which product a connected mailbox belongs to (migration 0034).
-- ─────────────────────────────────────────────────────────────────────────────
--
-- ⚠️ EXPECTED TO MOVE NOTHING, AND WRITTEN ANYWAY. Production holds one mailbox
-- and it is Invoice Chasing's; no lead mailbox has ever been connected on any
-- environment. But a developer's database, staging, or the founder's own
-- account between this migration and the next deploy may hold one, and a rename
-- that silently orphaned it would leave a customer's connected mailbox filed
-- against a product that no longer exists — invisible until they tried to send.
ALTER TABLE "email_accounts"
  DROP CONSTRAINT IF EXISTS "email_accounts_module_key_check";

UPDATE "email_accounts"
   SET "module_key" = 'lead_follow_up'
 WHERE "module_key" = 'lead_follow_up_email';

ALTER TABLE "email_accounts"
  ADD CONSTRAINT "email_accounts_module_key_check"
    CHECK ("module_key" IN (
      'email_credit_controller',
      'voice_credit_controller',
      'lead_follow_up',
      'lead_follow_up_voice',
      'ai_receptionist'
    ));

-- ─────────────────────────────────────────────────────────────────────────────
-- ⚠️ WHAT THIS MIGRATION DELIBERATELY DOES NOT TOUCH.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `leads.source` carries `email_enquiry`, and it stays. That column records HOW
-- an enquiry actually arrived, which is a fact about the message and not a name
-- for the product — and it is about to matter more, not less: a WhatsApp
-- enquiry will carry a different value, and the two must stay tellable apart
-- forever. Renaming it to match the product would destroy exactly the
-- distinction the next slice is built on.
--
-- `lead_evidence.channel` is the same idea and stays for the same reason.
