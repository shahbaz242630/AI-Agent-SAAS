-- Slice 3.1a follow-up — migration 0027: an email product that only holds
-- email leads.
--
-- ⚠️ FOUNDER RULING 2026-08-21. Lead Follow-up by Email is one mailbox in and
-- a reply out. A business puts a single address on its website and on its
-- enquiry form, so a web-form lead ARRIVES AS EMAIL — there is no second
-- intake pipeline. Phone, WhatsApp and Telegram are a different product
-- (`lead_follow_up_voice`, plus a Twilio stack) and are not built.
--
-- ⚠️ WHAT THIS FIXES IS A SCOPE LEAK THAT SHIPPED. Migration 0026 allowed
-- exactly `missed_call`, `existing_customer` and `callback_request` — all
-- three call-shaped — and 3.1a put them on a form inside the product whose
-- blurb is "Answers new enquiries from your mailbox". A lead with a phone
-- number and no email address was creatable in a product with no way to ring
-- anybody, which is the money-bug family: a screen promising an outcome that
-- cannot happen.
--
-- ⚠️ THIS ADDS A VALUE, IT DOES NOT REMOVE THREE, AND THAT IS DELIBERATE.
-- One real enquiry was logged as `callback_request` on production on
-- 2026-08-20 (lead cc1c3243). `lead_evidence` is immutable by design — the app
-- role holds no UPDATE on it (0026) — because evidence of how somebody got in
-- touch is the thing PECR expects us to be able to show. Narrowing the CHECK
-- would mean either destroying that record or rewriting its channel, and
-- rewriting it is falsifying the proof. So history stays legal here, and the
-- APPLICATION stops producing those values: `LEAD_SOURCES` in @eva/validation
-- is now `['email_enquiry']` alone, and the manual entry form is gone.
--
-- The two CHECKs move together on purpose. `leads.source` and
-- `lead_evidence.channel` are the same fact seen from two sides — the service
-- writes one from the other — so a value legal in one and not the other is a
-- 500 waiting for the first lead that uses it.

-- ---------------------------------------------------------------------------
-- leads.source
-- ---------------------------------------------------------------------------

ALTER TABLE "leads" DROP CONSTRAINT "leads_source_check";

ALTER TABLE "leads"
  ADD CONSTRAINT "leads_source_check"
    CHECK ("source" IN (
      -- The only value this product produces. An enquiry that arrived in the
      -- customer's mailbox, forwarded to an address we own (ruling 25 — we
      -- never require a restricted Google scope, so we do not read their
      -- inbox).
      'email_enquiry',
      -- Retired 2026-08-21, kept legal for the records that already exist.
      -- Lead Follow-up by Call owns these when it is built.
      'missed_call', 'existing_customer', 'callback_request'
    ));

-- ---------------------------------------------------------------------------
-- lead_evidence.channel
-- ---------------------------------------------------------------------------

ALTER TABLE "lead_evidence" DROP CONSTRAINT "lead_evidence_channel_check";

ALTER TABLE "lead_evidence"
  ADD CONSTRAINT "lead_evidence_channel_check"
    CHECK ("channel" IN (
      'email_enquiry',
      'missed_call', 'existing_customer', 'callback_request'
    ));
