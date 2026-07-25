-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "contact_id" UUID,
    "invoice_number" TEXT NOT NULL,
    "amount_minor_units" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'GBP',
    "issue_date" DATE NOT NULL,
    "due_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoices_organisation_id_idx" ON "invoices"("organisation_id");

-- CreateIndex
CREATE INDEX "invoices_customer_id_idx" ON "invoices"("customer_id");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Slice 1.2 hand-written section: invariants + RLS -----------------------
-- (Pattern follows 20260724061409_crm_core: every new table ships its
-- constraints, policies and grants in the SAME migration — the 0004 lesson.)

-- Money is positive integer minor units (BRD 10).
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_amount_positive_chk" CHECK ("amount_minor_units" > 0);

-- The nine STORED statuses (plan §7.1): due_soon/due_today/overdue are
-- computed at read time and never stored. Status changes only via the
-- invoices module state machine (BRD 4.1 hard rule).
ALTER TABLE "invoices"
  ADD CONSTRAINT "invoices_status_chk" CHECK ("status" IN (
    'draft', 'active', 'paused', 'cancelled', 'promise_to_pay',
    'disputed', 'partially_paid', 'paid', 'written_off'
  ));

-- Invoice numbers are unique per organisation among LIVE rows, so a
-- soft-deleted (e.g. cancelled-then-deleted draft) invoice's number can be
-- reused. Duplicates surface to the API as a friendly 409.
CREATE UNIQUE INDEX "invoices_organisation_id_invoice_number_key"
  ON "invoices"("organisation_id", "invoice_number")
  WHERE "deleted_at" IS NULL;

ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoices
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- Explicit runtime grants (not relying solely on ALTER DEFAULT PRIVILEGES).
GRANT SELECT, INSERT, UPDATE, DELETE ON invoices TO eva_app;
