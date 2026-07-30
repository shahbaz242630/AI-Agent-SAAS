-- CreateTable
CREATE TABLE "email_accounts" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'microsoft',
    "email_address" TEXT NOT NULL,
    "display_name" TEXT,
    "access_token_encrypted" TEXT,
    "refresh_token_encrypted" TEXT,
    "token_expires_at" TIMESTAMPTZ(6),
    "scopes" TEXT[],
    "health_status" TEXT NOT NULL DEFAULT 'active',
    "last_health_check_at" TIMESTAMPTZ(6),
    "last_error" TEXT,
    "connected_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "email_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_accounts_organisation_id_idx" ON "email_accounts"("organisation_id");

-- AddForeignKey
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Slice 1.6 — ruling 6: one LIVE mailbox connection per organisation
-- (partial unique index, the 0011 precedent). Soft-deleted rows keep
-- history and do not block reconnect.
CREATE UNIQUE INDEX "email_accounts_live_organisation_key"
  ON "email_accounts"("organisation_id")
  WHERE "deleted_at" IS NULL;

-- Slice 1.6 — CHECK constraints (the 0009 status-CHECK precedent).
ALTER TABLE "email_accounts"
  ADD CONSTRAINT "email_accounts_provider_check" CHECK ("provider" = 'microsoft'),
  ADD CONSTRAINT "email_accounts_health_status_check"
    CHECK ("health_status" IN ('active', 'auth_expired', 'error'));

ALTER TABLE email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_accounts FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON email_accounts
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- Explicit runtime grants (not relying solely on ALTER DEFAULT PRIVILEGES).
GRANT SELECT, INSERT, UPDATE, DELETE ON email_accounts TO eva_app;
