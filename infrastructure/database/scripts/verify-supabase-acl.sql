-- Hosted-privilege verification (Slice 1.6, security gap G-012).
--
-- WHY THIS EXISTS: the db suite's ACL tests run against local Docker, and
-- migration 0015 makes them meaningful there — but they can only catch grants
-- WE write. They cannot see Supabase changing its own platform defaults, or a
-- privilege applied through the dashboard. That drift is only observable on the
-- hosted database, so it needs a check that runs there.
--
-- Every query below must return ZERO rows. Anything returned is a finding.
--
-- HOW TO RUN (cloud runs PG 17.6, so a PG17 client is required — the Docker
-- Compose container ships pg_dump/psql 16 and will refuse):
--
--   $line = (Get-Content ".env" | Where-Object { $_ -match '^CLOUD_DATABASE_URL=' })
--   $env:PGURL = ($line -replace '^CLOUD_DATABASE_URL=','').Trim()
--   docker run --rm -e PGURL -v "${PWD}\infrastructure\database\scripts:/s" `
--     postgres:17-alpine sh -c 'psql "$PGURL" -f /s/verify-supabase-acl.sql'
--
-- Pass the URL via `-e PGURL` (inherited from the host environment), never as a
-- docker argument: PowerShell 5.1 mangles native arguments, and inline `-c
-- "SQL WITH SPACES"` silently loses its quotes the same way. Hence a file.

\pset pager off

\echo == FINDING IF ANY ROWS: API roles hold table privileges ==
SELECT c.relname AS table_name, r.rolname AS role, a.privilege_type
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) a
JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND r.rolname IN ('anon', 'authenticated', 'service_role')
ORDER BY c.relname, r.rolname;

\echo == FINDING IF ANY ROWS: API roles hold function EXECUTE (migration 0012) ==
SELECT p.proname AS function_name, r.rolname AS role
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(p.proacl) a
JOIN pg_roles r ON r.oid = a.grantee
WHERE n.nspname = 'public' AND a.privilege_type = 'EXECUTE'
  AND r.rolname IN ('anon', 'authenticated', 'service_role')
ORDER BY p.proname, r.rolname;

\echo == FINDING IF ANY ROWS: default privileges would re-grant on future objects ==
SELECT pg_get_userbyid(d.defaclrole) AS granted_by,
       CASE d.defaclobjtype WHEN 'r' THEN 'tables' WHEN 'S' THEN 'sequences'
            WHEN 'f' THEN 'functions' END AS obj_type,
       d.defaclacl::text AS acl
FROM pg_default_acl d
JOIN pg_namespace n ON n.oid = d.defaclnamespace
WHERE n.nspname = 'public'
  AND d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  AND d.defaclacl::text ~ '(anon|authenticated|service_role)=';

\echo == FINDING IF ANY ROWS: tenant table without RLS enabled AND forced ==
-- The lock behind the privilege model. `roles` is a global lookup table and
-- `_prisma_migrations` is Prisma's own bookkeeping; neither is tenant-owned.
SELECT c.relname AS table_name, c.relrowsecurity AS rls_enabled,
       c.relforcerowsecurity AS rls_forced
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname NOT IN ('roles', '_prisma_migrations')
  AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
ORDER BY c.relname;

\echo == FINDING IF ANY ROWS: tenant table with no policy at all ==
SELECT c.relname AS table_name
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname NOT IN ('_prisma_migrations')
  AND NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.tablename = c.relname)
ORDER BY c.relname;

\echo == FINDING IF ANY ROWS: PUBLIC (pseudo-role) holds privileges in public schema ==
-- Postgres grants EXECUTE on new functions to PUBLIC by default; migration 0016
-- removed that default. aclexplode reports PUBLIC as grantee 0.
SELECT 'function' AS kind, p.proname AS name, a.privilege_type
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(p.proacl) a
WHERE n.nspname = 'public' AND a.grantee = 0
UNION ALL
SELECT 'table', c.relname, a.privilege_type
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(c.relacl) a
WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.grantee = 0
ORDER BY kind, name;

\echo == FINDING IF ANY ROWS: eva_app cannot read/write a tenant table ==
-- Not a privilege-count check: suppression_events deliberately holds only
-- SELECT + INSERT (migration 20260724061409 revokes UPDATE/DELETE so
-- do-not-contact entries are permanent), so counting to 4 would flag correct
-- design. Assert the floor the runtime actually needs instead.
SELECT c.relname AS table_name,
       has_table_privilege('eva_app', c.oid, 'SELECT') AS can_select,
       has_table_privilege('eva_app', c.oid, 'INSERT') AS can_insert
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r'
  AND c.relname NOT IN ('_prisma_migrations', 'roles')
  AND NOT (has_table_privilege('eva_app', c.oid, 'SELECT')
           AND has_table_privilege('eva_app', c.oid, 'INSERT'))
ORDER BY c.relname;

\echo == FINDING IF ANY ROWS: eva_app lost EXECUTE on a function it needs ==
-- The daily reminder-reconcile sweep enumerates organisations through
-- list_active_organisations() as eva_app (SECURITY DEFINER, migration 0010).
-- Migration 0016 revokes function EXECUTE broadly, so assert the one grant that
-- must survive — otherwise the nightly worker run fails at 06:17 UTC.
SELECT p.proname AS function_name,
       has_function_privilege('eva_app', p.oid, 'EXECUTE') AS eva_app_can_execute
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'list_active_organisations'
  AND NOT has_function_privilege('eva_app', p.oid, 'EXECUTE');

\echo == FINDING IF ANY ROWS: suppression_events is no longer append-only ==
-- BRD compliance: a do-not-contact entry must never be editable or erasable by
-- the runtime role.
SELECT 'suppression_events' AS table_name,
       has_table_privilege('eva_app', 'suppression_events', 'UPDATE') AS can_update,
       has_table_privilege('eva_app', 'suppression_events', 'DELETE') AS can_delete
WHERE has_table_privilege('eva_app', 'suppression_events', 'UPDATE')
   OR has_table_privilege('eva_app', 'suppression_events', 'DELETE');
