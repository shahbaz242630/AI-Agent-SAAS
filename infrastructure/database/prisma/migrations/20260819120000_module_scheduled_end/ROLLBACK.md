# ROLLBACK — 20260819120000_module_scheduled_end

Migration 0024 adds `organisation_modules.ends_at` — when a product switched off
mid-period actually stops. Founder ruling 2026-08-19: switching a product off
stops the bill from the next cycle, and must not take away time already paid
for.

Additive only: one nullable column and one CHECK constraint. No table is created
or dropped, no existing column is altered, and **no data is rewritten** — every
existing row keeps `NULL`, which means "not ending", and that is true of all of
them.

| Table                  | Changed                                        |
| ---------------------- | ---------------------------------------------- |
| `organisation_modules` | **+ `ends_at`** `TIMESTAMPTZ(6)` NULL          |
| `organisation_modules` | **+ `organisation_modules_ends_at_chk`** CHECK |

## Rollback SQL

```sql
ALTER TABLE "organisation_modules"
  DROP CONSTRAINT IF EXISTS "organisation_modules_ends_at_chk";
ALTER TABLE "organisation_modules" DROP COLUMN IF EXISTS "ends_at";
```

## Notes

- **Nothing is lost today, and that will stop being true.** The API does not
  write this column yet: with no billing period to compute from (Paddle is not
  wired up), switching a product off still happens immediately and `ends_at`
  stays `NULL`. Rolling back now discards nothing. **Once Paddle sets a period
  end, this column is the only record that a customer has cancelled**, and
  dropping it would silently convert every pending cancellation back into an
  active subscription — a customer who cancelled keeps being billed. Capture the
  table before dropping the column from that point on.

- **⚠️ THE CHECK CONSTRAINT IS DOING REAL WORK, NOT TIDINESS.**
  `CHECK (ends_at IS NULL OR enabled)` is what forces "the end arrived" to be a
  single statement — set `enabled = false` and clear `ends_at` together.
  Dropping the constraint makes it possible to leave a disabled row advertising
  a future end date, which is a screen telling a customer their product is still
  running when it is not. That is the failure family this project keeps finding.

- **⚠️ THE APPLICATION CODE MUST MOVE WITH THE COLUMN.** `EntitlementsService`
  selects `organisationModule` rows through Prisma, which selects every scalar
  field by default. Dropping the column while the API still expects it breaks
  the Products screen and every entitlement read behind it. Revert the API in
  the same change, not afterwards.

- **The web app degrades honestly rather than lying.** `ModuleStatusDto.endsAt`
  is already read by the Products screen, which says "stops now" when it is
  `NULL` and "stays on until <date>" when it is set. With the column gone the
  DTO is always `NULL`, so the screen says "stops now" — which matches what the
  API would then actually do. No wording promises anything the code cannot keep.

- **No privilege changes.** `organisation_modules` already carries RLS
  enabled+forced, its `tenant_isolation` policy and its `eva_app` grants. Adding
  a column and a CHECK does not disturb them, and
  `scripts/verify-supabase-acl.sql` has nothing new to assert. Nothing to
  re-grant in either direction.
