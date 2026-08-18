# ROLLBACK — 20260812130000_user_last_seen_at

Migration 0023 adds `users.last_seen_at` — the timestamp behind the two-day idle
sign-out (founder's request, 2026-08-12).

Additive only: one nullable column. No table is created or dropped, no existing
column is altered, no constraint is added, and **no data is rewritten** — every
existing row keeps `NULL`, which the application reads as "fresh, stamp it on
the next request" (`isSessionIdle` in `@eva/types`).

| Table   | Changed                                    |
| ------- | ------------------------------------------ |
| `users` | **+ `last_seen_at`** `TIMESTAMPTZ(6)` NULL |

## Rollback SQL

```sql
ALTER TABLE "users" DROP COLUMN IF EXISTS "last_seen_at";
```

## Notes

- **⚠️ ROLLING BACK REMOVES THE IDLE SIGN-OUT ENTIRELY, AND NOTHING SAYS SO.**
  Without the column there is no record of when anybody was last active, so
  sessions live until the customer signs out — which is the behaviour Supabase
  gives us on the free plan, and precisely what this migration was raised to
  change. It fails **open**, not closed: nobody is locked out, everybody stays
  signed in forever. That is the safer direction to fail in, and it is still a
  security control silently disappearing.

- **⚠️ THE APPLICATION CODE MUST MOVE WITH THE COLUMN.** `UsersService`
  selects the whole row via Prisma, which selects all scalar fields by default —
  dropping the column while the code still expects it breaks **every
  authenticated request**, not an edge case, because `resolveOrProvision` is on
  the path of every data read in the product. Revert the API in the same change,
  not afterwards.

- **The browser half degrades on its own.** The proxy's `eva_seen` cookie is an
  experience, not the rule — it keeps working with or without this column, and
  simply stops being backed by anything the server can verify. Clearing it is
  not required; it expires on its own terms and is ignored once the code is
  reverted.

- **Losing the data costs nothing.** `last_seen_at` is not a customer's choice
  and nothing is stored in terms of it — no invoice, reminder or membership
  refers to it. It is re-derived from ordinary use within minutes of the column
  coming back, so unlike a settings column there is nothing worth capturing
  before dropping it.

- **No privilege changes.** `users` already carries RLS enabled+forced, the
  `tenant_isolation` and `auth_user_resolution` policies, and its `eva_app`
  grants. Adding a column does not disturb them; the row's own
  `WITH CHECK (id = app.current_user)` is what lets a user stamp itself, and it
  was already there. Nothing to re-grant in either direction.
