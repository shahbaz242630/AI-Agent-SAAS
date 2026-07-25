-- CreateTable
CREATE TABLE "imports" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "original_filename" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'uploaded',
    "mapping" JSONB NOT NULL,
    "total_rows" INTEGER NOT NULL DEFAULT 0,
    "valid_rows" INTEGER NOT NULL DEFAULT 0,
    "invalid_rows" INTEGER NOT NULL DEFAULT 0,
    "duplicate_rows" INTEGER NOT NULL DEFAULT 0,
    "suppressed_rows" INTEGER NOT NULL DEFAULT 0,
    "created_rows" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_rows" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "import_id" UUID NOT NULL,
    "row_number" INTEGER NOT NULL,
    "raw" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "created_invoice_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,

    CONSTRAINT "import_rows_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "imports_organisation_id_idx" ON "imports"("organisation_id");

-- CreateIndex
CREATE INDEX "import_rows_organisation_id_idx" ON "import_rows"("organisation_id");

-- CreateIndex
CREATE INDEX "import_rows_import_id_idx" ON "import_rows"("import_id");

-- AddForeignKey
ALTER TABLE "imports" ADD CONSTRAINT "imports_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_id_fkey" FOREIGN KEY ("import_id") REFERENCES "imports"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_created_invoice_id_fkey" FOREIGN KEY ("created_invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- --- Slice 1.3 hand-written section: invariants + RLS -----------------------
-- (Pattern follows 20260725072314_invoices: every new table ships its
-- constraints, policies and grants in the SAME migration — the 0004 lesson.)

-- csv | xlsx only — legacy .xls (BIFF) is rejected by the upload path (plan §3).
ALTER TABLE "imports"
  ADD CONSTRAINT "imports_file_type_chk" CHECK ("file_type" IN ('csv', 'xlsx'));

-- The stored import statuses (plan §3): 'confirmed' is not a stored state —
-- confirm runs synchronously to completion (plan §7.8). Status changes only
-- via the imports module status machine (the 1.2 pattern).
ALTER TABLE "imports"
  ADD CONSTRAINT "imports_status_chk" CHECK ("status" IN (
    'uploaded', 'completed', 'failed', 'cancelled'
  ));

-- The staged-row statuses (plan §3).
ALTER TABLE "import_rows"
  ADD CONSTRAINT "import_rows_status_chk" CHECK ("status" IN (
    'valid', 'invalid', 'duplicate', 'suppressed', 'imported', 'skipped'
  ));

ALTER TABLE imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE imports FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON imports
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE import_rows ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_rows FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON import_rows
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- Explicit runtime grants (not relying solely on ALTER DEFAULT PRIVILEGES).
GRANT SELECT, INSERT, UPDATE, DELETE ON imports TO eva_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON import_rows TO eva_app;
