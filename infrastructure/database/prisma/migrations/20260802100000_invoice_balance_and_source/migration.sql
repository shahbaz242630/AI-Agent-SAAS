-- Migration 0019: what Eva needs to chase, and nothing more.
--
-- Written after reviewing a real accounting package (Zoho Books) against this
-- schema — see docs/DATA-MODEL-REVIEW.md. Founder ruling that governs every
-- choice here: "Eva is only a follow-up agent, not an accountant, so we only
-- need the data Eva needs to follow up."
--
-- The important one is `amount_paid_minor_units`. `invoices.status` has allowed
-- 'partially_paid' since migration 0006, but there has never been a number to
-- go with it — so a customer who part-pays a 30,000 invoice would be chased by
-- Eva for the full 30,000. That is not a cosmetic defect: it damages our
-- customer's relationship with THEIR debtor. Every mature system chases the
-- balance (Zoho's own reminder template interpolates {{Balance}}, never the
-- invoice total).
--
-- Deliberately NOT added: line items, tax/VAT summaries, credit notes,
-- payments-as-rows. All of those are accounting. The customer's own ledger nets
-- refunds, credit notes and part payments into one outstanding figure, and
-- importing that figure is both simpler and more correct than reconstructing it.

-- --- invoices ---------------------------------------------------------------

ALTER TABLE "invoices"
  -- Balance is DERIVED (amount - paid), never stored: a stored balance is a
  -- third number that can disagree with the other two.
  ADD COLUMN "amount_paid_minor_units" INTEGER NOT NULL DEFAULT 0,
  -- Changes chasing behaviour, not just reporting: someone who paid something
  -- three days ago must not get the same message as someone who has paid
  -- nothing in ninety days.
  ADD COLUMN "last_payment_at" TIMESTAMPTZ(6),
  -- The DEBTOR's own reference (Zoho calls it Order Number; real invoices in
  -- the founder's account carry values like QT-000202). Quoting it back cuts
  -- "which invoice is this?" replies — exactly the friction Eva removes.
  -- Distinct from customers.reference, which is OUR customer's account ref.
  ADD COLUMN "customer_reference" TEXT,
  -- Free text, not an enum: every accounting package words these differently
  -- and we are importing theirs, not authoring our own.
  ADD COLUMN "payment_terms" TEXT,
  -- ONE line of context ("Bathroom renovation, final"), populated from the
  -- first line item on import. NOT line items. A bare "AED 30,000" makes a weak
  -- chaser, especially for a business that invoices per completed project.
  ADD COLUMN "description" TEXT,
  -- Provenance. NOTE: this is not the same idea as organisation_modules.source
  -- (which records how a product was paid for). Here it records which system a
  -- row came from, and it is half of the identity used to re-sync rather than
  -- duplicate.
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "external_id" TEXT;

ALTER TABLE "invoices"
  -- Overpayment is ALLOWED (founder ruling): refusing an import because a
  -- debtor paid too much is an accounting objection, and we are not
  -- accountants. Balance simply clamps at zero and Eva stops chasing. Hence
  -- >= 0 only, and deliberately NOT <= amount_minor_units.
  ADD CONSTRAINT "invoices_amount_paid_check" CHECK ("amount_paid_minor_units" >= 0),
  ADD CONSTRAINT "invoices_source_check"
    CHECK ("source" IN ('manual', 'csv', 'pdf', 'zoho', 'xero', 'quickbooks', 'sage'));

-- Re-syncing the same remote invoice must UPDATE, never duplicate. Partial so
-- that manually created rows (external_id IS NULL) are unconstrained, and
-- soft-deleted history never blocks a re-import — the 0011/0013/0017 precedent.
CREATE UNIQUE INDEX "invoices_external_ref_key"
  ON "invoices"("organisation_id", "source", "external_id")
  WHERE "external_id" IS NOT NULL AND "deleted_at" IS NULL;

-- --- customers --------------------------------------------------------------

ALTER TABLE "customers"
  -- The customer's default terms; the invoice carries what was actually agreed.
  ADD COLUMN "payment_terms" TEXT,
  ADD COLUMN "source" TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN "external_id" TEXT;

ALTER TABLE "customers"
  ADD CONSTRAINT "customers_source_check"
    CHECK ("source" IN ('manual', 'csv', 'pdf', 'zoho', 'xero', 'quickbooks', 'sage'));

CREATE UNIQUE INDEX "customers_external_ref_key"
  ON "customers"("organisation_id", "source", "external_id")
  WHERE "external_id" IS NOT NULL AND "deleted_at" IS NULL;

-- --- organisation_settings --------------------------------------------------

-- How the debtor actually pays. A chasing email that does not answer "how do I
-- pay you?" is half a product. Organisation-level rather than per-invoice: the
-- bank account rarely differs per invoice, and storing it once avoids importing
-- the same block of text a thousand times.
--
-- NOT a payment link and NOT card details — Eva never touches the customer's
-- money, and nothing here may ever hold a credential.
ALTER TABLE "organisation_settings"
  ADD COLUMN "payment_instructions" TEXT;

-- No GRANTs needed: every table altered here already exists with RLS enabled +
-- forced, its tenant_isolation policy, and its eva_app grants. Adding a column
-- inherits all of it. (Contrast a NEW table, which since 0014-0016 is created
-- with no privileges at all and must grant explicitly.)
