-- CreateTable
CREATE TABLE "invoice_documents" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "original_filename" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "content" BYTEA NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "extracted_fields" JSONB,
    "extraction_error" TEXT,
    "invoice_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "invoice_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "invoice_documents_organisation_id_idx" ON "invoice_documents"("organisation_id");

-- AddForeignKey
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_documents" ADD CONSTRAINT "invoice_documents_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Slice 1.4 hand-written section: invariants + RLS -----------------------
-- (Pattern follows 20260725100330_imports: every new table ships its
-- constraints, policies and grants in the SAME migration — the 0004 lesson.)

-- The stored document statuses (plan §3): 'confirmed' IS a stored state here
-- (unlike 1.3 imports) — the document row outlives confirm as the retained
-- PDF + extraction evidence. Status changes only via the invoice-documents
-- module status machine (the 1.2/1.3 pattern).
ALTER TABLE "invoice_documents"
  ADD CONSTRAINT "invoice_documents_status_chk" CHECK ("status" IN (
    'uploaded', 'extracted', 'confirmed', 'failed'
  ));

ALTER TABLE invoice_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoice_documents FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON invoice_documents
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- Explicit runtime grants (not relying solely on ALTER DEFAULT PRIVILEGES).
GRANT SELECT, INSERT, UPDATE, DELETE ON invoice_documents TO eva_app;
