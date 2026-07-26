-- CreateTable
CREATE TABLE "reminder_sequences" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "reminder_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reminder_steps" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "sequence_id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "offset_days" INTEGER NOT NULL,
    "action_type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "reminder_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_actions" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "reminder_step_id" UUID NOT NULL,
    "action_type" TEXT NOT NULL,
    "scheduled_date" DATE NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "idempotency_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,

    CONSTRAINT "scheduled_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "human_escalations" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "scheduled_action_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by" UUID,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,

    CONSTRAINT "human_escalations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "reminder_sequences_organisation_id_idx" ON "reminder_sequences"("organisation_id");

-- CreateIndex
CREATE INDEX "reminder_steps_organisation_id_idx" ON "reminder_steps"("organisation_id");

-- CreateIndex
CREATE INDEX "reminder_steps_sequence_id_idx" ON "reminder_steps"("sequence_id");

-- CreateIndex
CREATE INDEX "scheduled_actions_organisation_id_idx" ON "scheduled_actions"("organisation_id");

-- CreateIndex
CREATE INDEX "scheduled_actions_status_scheduled_date_idx" ON "scheduled_actions"("status", "scheduled_date");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_actions_invoice_step_date_key" ON "scheduled_actions"("invoice_id", "reminder_step_id", "scheduled_date");

-- CreateIndex
CREATE UNIQUE INDEX "human_escalations_scheduled_action_id_key" ON "human_escalations"("scheduled_action_id");

-- CreateIndex
CREATE INDEX "human_escalations_organisation_id_idx" ON "human_escalations"("organisation_id");

-- AddForeignKey
ALTER TABLE "reminder_sequences" ADD CONSTRAINT "reminder_sequences_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_steps" ADD CONSTRAINT "reminder_steps_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reminder_steps" ADD CONSTRAINT "reminder_steps_sequence_id_fkey" FOREIGN KEY ("sequence_id") REFERENCES "reminder_sequences"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_actions" ADD CONSTRAINT "scheduled_actions_reminder_step_id_fkey" FOREIGN KEY ("reminder_step_id") REFERENCES "reminder_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_escalations" ADD CONSTRAINT "human_escalations_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_escalations" ADD CONSTRAINT "human_escalations_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "human_escalations" ADD CONSTRAINT "human_escalations_scheduled_action_id_fkey" FOREIGN KEY ("scheduled_action_id") REFERENCES "scheduled_actions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- Slice 1.5 hand-written section: invariants + RLS -----------------------
-- (Pattern follows 20260725151439_invoice_documents: every new table ships
-- its constraints, policies and grants in the SAME migration — the 0004
-- lesson.)

-- The six BRD 4.1 reminder stages (plan §3); offsets are editable per step.
ALTER TABLE "reminder_steps"
  ADD CONSTRAINT "reminder_steps_key_chk" CHECK ("key" IN (
    'pre_due_3', 'due_date', 'overdue_7', 'overdue_14', 'overdue_30',
    'final_escalation'
  ));

ALTER TABLE "reminder_steps"
  ADD CONSTRAINT "reminder_steps_action_type_chk" CHECK ("action_type" IN (
    'email', 'internal_escalation'
  ));

-- The full scheduled-action lifecycle (plan §3, the 1.2 invoice-status
-- precedent): slice 1.5 writes only pending/ready/cancelled; claimed/sent/
-- failed/skipped are driven by 1.7 via conditional-update claim.
ALTER TABLE "scheduled_actions"
  ADD CONSTRAINT "scheduled_actions_status_chk" CHECK ("status" IN (
    'pending', 'ready', 'claimed', 'sent', 'failed', 'skipped', 'cancelled'
  ));

ALTER TABLE "scheduled_actions"
  ADD CONSTRAINT "scheduled_actions_action_type_chk" CHECK ("action_type" IN (
    'email', 'internal_escalation'
  ));

ALTER TABLE "human_escalations"
  ADD CONSTRAINT "human_escalations_status_chk" CHECK ("status" IN (
    'open', 'resolved'
  ));

-- One default sequence per organisation among LIVE rows, so a soft-deleted
-- default can be replaced (the 0006 invoice-number precedent).
CREATE UNIQUE INDEX "reminder_sequences_default_per_org_key"
  ON "reminder_sequences"("organisation_id")
  WHERE "is_default" AND "deleted_at" IS NULL;

-- One step per stage key per sequence among live rows.
CREATE UNIQUE INDEX "reminder_steps_sequence_id_key_key"
  ON "reminder_steps"("sequence_id", "key")
  WHERE "deleted_at" IS NULL;

ALTER TABLE reminder_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_sequences FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON reminder_sequences
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE reminder_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE reminder_steps FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON reminder_steps
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE scheduled_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_actions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON scheduled_actions
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

ALTER TABLE human_escalations ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_escalations FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON human_escalations
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- Explicit runtime grants (not relying solely on ALTER DEFAULT PRIVILEGES).
GRANT SELECT, INSERT, UPDATE, DELETE ON reminder_sequences TO eva_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON reminder_steps TO eva_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON scheduled_actions TO eva_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON human_escalations TO eva_app;
