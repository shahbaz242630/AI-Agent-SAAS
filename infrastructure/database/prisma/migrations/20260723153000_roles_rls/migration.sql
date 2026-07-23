-- 0004 — RLS on the shared `roles` reference table (Slice 0.5, found during
-- the first cloud e2e: POST /organisations 500ed because Supabase's platform
-- default enabled RLS on `roles` with no policy, hiding it from eva_app).
--
-- `roles` is platform reference data (the six BRD Section 7 organisation
-- roles): every runtime query may READ it, nobody below the owner may WRITE
-- it. Enabling RLS here also aligns local/dev with the Supabase cloud
-- behaviour so this bug class fails locally in future.
--
-- Note: ENABLE only, never FORCE — the owner role seeds roles.

-- 1) Enable RLS (idempotent — Supabase cloud already has it on).
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;

-- 2) Read-only access for the runtime role. No INSERT/UPDATE/DELETE policy —
--    writes stay fail-closed by design.
CREATE POLICY roles_read_all ON roles
  FOR SELECT
  USING (true);
