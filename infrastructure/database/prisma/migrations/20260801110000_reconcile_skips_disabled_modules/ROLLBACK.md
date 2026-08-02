# ROLLBACK — 20260801110000_reconcile_skips_disabled_modules

Migration 0018 (Slice 1.6a) narrows `list_active_organisations()` so the
nightly reconcile sweep skips organisations whose `email_credit_controller` is
disabled. Function signature, ownership, `SECURITY DEFINER` hardening and
grants are all unchanged — only the WHERE clause moves.

## Rollback SQL

```sql
-- Restores the migration 0010 body: every organisation with a live active
-- invoice, regardless of entitlement.
CREATE OR REPLACE FUNCTION list_active_organisations()
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT DISTINCT organisation_id
  FROM public.invoices
  WHERE status = 'active' AND deleted_at IS NULL
$$;

REVOKE ALL ON FUNCTION list_active_organisations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION list_active_organisations() TO eva_app;
```

## Notes

- **No data loss** — this is a function body, and nothing stores its output.
- **Rolling back FAILS OPEN, and that is the thing to be careful about.** The
  sweep would resume scheduling reminders for organisations that have switched
  Invoice Chasing off. Nothing sends until slice 1.7 exists, so today the blast
  radius is scheduled rows rather than mail actually leaving — but once 1.7
  ships, a rolled-back deployment means chasing a customer's customers after
  they told us to stop. Fix forward instead.
- Safe to re-apply: `CREATE OR REPLACE` is idempotent and preserves the ACL,
  and the grants are re-issued explicitly either way.
- If this is rolled back while migration 0017 is also rolled back, the function
  would reference a table that no longer exists — roll back 0018 FIRST, or
  simply roll back neither.
