-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "reference" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "job_title" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppression_list" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "suppression_list_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organisation_role_permissions" (
    "id" UUID NOT NULL,
    "organisation_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,
    "permission_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "created_by" UUID,

    CONSTRAINT "organisation_role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_organisation_id_idx" ON "customers"("organisation_id");

-- CreateIndex
CREATE INDEX "contacts_organisation_id_idx" ON "contacts"("organisation_id");

-- CreateIndex
CREATE INDEX "contacts_customer_id_idx" ON "contacts"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "suppression_list_organisation_id_channel_value_key" ON "suppression_list"("organisation_id", "channel", "value");

-- CreateIndex
CREATE UNIQUE INDEX "organisation_role_permissions_organisation_id_role_id_permi_key" ON "organisation_role_permissions"("organisation_id", "role_id", "permission_key");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "suppression_list" ADD CONSTRAINT "suppression_list_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_role_permissions" ADD CONSTRAINT "organisation_role_permissions_organisation_id_fkey" FOREIGN KEY ("organisation_id") REFERENCES "organisations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organisation_role_permissions" ADD CONSTRAINT "organisation_role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- Slice 1.1 hand-written section: RLS + suppression permanence -----------
-- Supabase auto-enables RLS on new public tables (lesson of migration 0004),
-- so every new table ships its policies in the same migration. Pattern follows
-- 20260722170433_rls_tenant_isolation: ENABLE + FORCE (owner bypass trap),
-- tenant context arrives via set_config('app.current_org', ...) per transaction.

ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers FORCE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE suppression_list ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppression_list FORCE ROW LEVEL SECURITY;
ALTER TABLE organisation_role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE organisation_role_permissions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON customers
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

CREATE POLICY tenant_isolation ON contacts
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

CREATE POLICY tenant_isolation ON suppression_list
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

CREATE POLICY tenant_isolation ON organisation_role_permissions
  USING (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid)
  WITH CHECK (organisation_id = NULLIF(current_setting('app.current_org', true), '')::uuid);

-- Suppression list permanence (BRD hard rule): the runtime role loses UPDATE
-- and DELETE on suppression_list, so "permanent" is enforced by Postgres
-- itself, not only by the absence of app code paths. SELECT + INSERT remain
-- (send paths check it; do-not-contact requests add to it). The owner role
-- keeps full rights for migrations/maintenance.
REVOKE UPDATE, DELETE ON suppression_list FROM eva_app;
