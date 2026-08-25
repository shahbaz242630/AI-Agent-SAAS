# ROLLBACK — 20260825140000_the_idle_clock_belongs_to_the_session

Migration 0032 adds `users.last_session_id` — the Supabase session behind
ruling 37, which turns the two-day idle sign-out from a per-USER clock into a
per-SESSION one.

Additive only: one nullable column. No table is created or dropped, no existing
column is altered, no constraint or index is added, and **no data is rewritten**
— every existing row keeps `NULL`, which the application reads as "not this
session", so the next request looks like a new sign-in and is admitted.

| Table   | Changed                             |
| ------- | ----------------------------------- |
| `users` | **+ `last_session_id`** `TEXT` NULL |

## Rollback SQL

```sql
ALTER TABLE "users" DROP COLUMN IF EXISTS "last_session_id";
```

## Notes

- **🚨 ROLLING BACK RESTORES A PERMANENT ACCOUNT LOCKOUT, AND NOTHING SAYS SO.**
  This is the opposite direction of travel from migration 0023's rollback, and
  the difference matters. 0023 failed **open** — drop the column and sessions
  simply live forever. This one fails **closed**: without `last_session_id` the
  idle check has no way to tell a returning customer from a replayed session, so
  it goes back to refusing on a stamp that its own throw prevents anything from
  refreshing. Any customer whose `last_seen_at` is more than two days old can
  then never sign in again. **Do not roll this back to "get to a known good
  state" — the known good state is the defect.**

- **⚠️ THE APPLICATION CODE MUST MOVE WITH THE COLUMN.** `UsersService` reads
  the whole row via Prisma, which selects every scalar field by default, and
  `resolveOrProvision` sits on the path of **every authenticated request** in
  the product. Dropping the column while the code still expects it breaks the
  entire API, not an edge case. Revert the API in the same change, not
  afterwards.

- **If it must come out, unlock people first.** The safe order is: revert the
  API, drop the column, and then clear the stamps that the restored rule would
  refuse — `UPDATE users SET last_seen_at = now() WHERE last_seen_at < now() - interval '2 days'`
  — with an `audit_logs` row recording it. Without that step the rollback
  silently locks out everyone who was away for the weekend.

- **Losing the data costs nothing.** A session id is not a customer's choice and
  nothing is stored in terms of it — no invoice, reminder, lead or membership
  refers to it. It is re-derived from the next request each person makes.

- **No privilege changes.** `users` already carries RLS enabled+forced, the
  `tenant_isolation` and `auth_user_resolution` policies, and its `eva_app`
  grants. Adding a column does not disturb them: the row's own
  `WITH CHECK (id = app.current_user)` is what lets a user stamp itself, and it
  was already there. Grants on this table are table-level, not column-level —
  checked, not assumed — so there is nothing to re-grant in either direction.
