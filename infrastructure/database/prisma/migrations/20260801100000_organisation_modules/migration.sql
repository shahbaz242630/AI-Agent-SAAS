-- Slice 1.6a — migration 0017: module entitlements, and mailbox seats.
--
-- Two things that look separate and are not. `organisation_modules` records
-- which of the four products an organisation holds; `seats` on the same row
-- records how many units of it they have paid for. For the email credit
-- controller a unit is a connected mailbox, which is why the index surgery on
-- `email_accounts` lives in this migration rather than a second one.
--
-- Absence of a row means NOT ENTITLED. Fail closed (scope §3.1).

-- CreateTable
CREATE TABLE "organisation_modules" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "module_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "source" TEXT NOT NULL DEFAULT 'manual',
    -- Deliberately NOT nullable-means-unlimited. Fail-closed is the rule, and a
    -- NULL that silently means "infinite" is the exact shape of a future
    -- incident. If we ever sell unlimited it gets an explicit sentinel.
    "seats" INTEGER NOT NULL DEFAULT 1,
    "enabled_at" TIMESTAMPTZ(6),
    "disabled_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "organisation_modules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "organisation_modules_organisation_id_idx" ON "organisation_modules"("organisation_id");

-- AddForeignKey
ALTER TABLE "organisation_modules" ADD CONSTRAINT "organisation_modules_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One live row per (organisation, module) — the 0011/0013 partial-index
-- precedent. Soft-deleted rows keep history and do not block re-enabling.
CREATE UNIQUE INDEX "organisation_modules_live_module_key"
  ON "organisation_modules"("organisation_id", "module_key")
  WHERE "deleted_at" IS NULL;

-- CHECK constraints (the 0009 status-CHECK precedent).
ALTER TABLE "organisation_modules"
  ADD CONSTRAINT "organisation_modules_module_key_check"
    CHECK ("module_key" IN (
      'email_credit_controller',
      'voice_credit_controller',
      'lead_follow_up_agent',
      'ai_receptionist'
    )),
  ADD CONSTRAINT "organisation_modules_source_check"
    CHECK ("source" IN ('subscription', 'manual', 'trial')),
  ADD CONSTRAINT "organisation_modules_seats_check" CHECK ("seats" >= 1);

ALTER TABLE organisation_modules ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_modules FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON organisation_modules
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- Explicit runtime grants. Since migrations 0014–0016 removed every default
-- privilege, a new table is created with NO grants at all — this line is
-- load-bearing, not belt-and-braces. Omit it and every query fails at runtime.
GRANT SELECT, INSERT, UPDATE, DELETE ON organisation_modules TO eva_app;

-- ---------------------------------------------------------------------------
-- THE ROLLOUT RISK. Every organisation that already exists must be granted the
-- email credit controller here, in this migration. Miss it and the entire
-- product 402s the moment this deploys — every existing customer locked out of
-- invoices, imports, reminders and their mailbox at once.
-- ---------------------------------------------------------------------------
INSERT INTO organisation_modules (id, organisation_id, module_key, enabled, source, seats, enabled_at, updated_at)
SELECT
  gen_random_uuid(),
  o.id,
  'email_credit_controller',
  true,
  'manual',
  1,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM organisations o
WHERE o.deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Mailbox seats (slice 1.6a Task 7a) — SUPERSEDES slice 1.6 ruling 6.
--
-- Ruling 6 ("one live mailbox per organisation, replace in place") was enforced
-- by a database index, and the application never checked. Connecting a second
-- mailbox did not fail: handleCallback found the existing live row and
-- OVERWROTE it, so a customer silently lost their first mailbox. Correct under
-- ruling 6, completely wrong under a seat model.
-- ---------------------------------------------------------------------------

-- 1. The old constraint goes. It is exactly the index step 3 needs, so it is
--    moving to the column that should have carried it, not being removed.
DROP INDEX "email_accounts_live_organisation_key";

-- 2. One ADDRESS cannot occupy two seats. Case-insensitive, because Microsoft
--    is: reconnecting Sara@acme.com must reuse the row created for
--    sara@acme.com rather than consume a second seat.
CREATE UNIQUE INDEX "email_accounts_live_address_key"
  ON "email_accounts"("organisation_id", lower("email_address"))
  WHERE "deleted_at" IS NULL;

-- 3. Exactly one primary per organisation — the mailbox 1.7 sends from until
--    per-customer routing exists.
ALTER TABLE "email_accounts"
  ADD COLUMN "is_primary" BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX "email_accounts_single_primary_key"
  ON "email_accounts"("organisation_id")
  WHERE "is_primary" AND "deleted_at" IS NULL;

-- Backfill: every mailbox connected today becomes its organisation's primary.
-- Deploy must be a ZERO-BEHAVIOUR-CHANGE event — before this migration each
-- organisation had at most one live mailbox, so each gets exactly one primary
-- and nothing a customer can observe changes.
UPDATE email_accounts
SET is_primary = true
WHERE deleted_at IS NULL;
