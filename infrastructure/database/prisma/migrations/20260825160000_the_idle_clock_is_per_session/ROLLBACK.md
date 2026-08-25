# ROLLBACK — 20260825160000_the_idle_clock_is_per_session

Migration 0033 adds `user_sessions` — one activity stamp per (user, Supabase
session), which is what makes the two-day idle rule judge a session on its own
history instead of on its owner's.

Additive only: one new table, its unique index, its foreign key and its RLS
policy. **No existing table is altered and no data is rewritten.**
`users.last_seen_at` and `users.last_session_id` are both left exactly as they
are.

| Table           | Changed                                                               |
| --------------- | --------------------------------------------------------------------- |
| `user_sessions` | **new** — `id`, `user_id`, `session_id`, `last_seen_at`, `created_at` |

## Rollback SQL

```sql
DROP TABLE IF EXISTS "user_sessions";
```

## Notes

- **🚨 NOTHING SHOULD EVER PRUNE THIS TABLE, AND A "CLEANUP" JOB WOULD BE A
  SECURITY REGRESSION.** A session with no row is treated as a **new sign-in and
  admitted** — that is what lets a genuine returning customer back in. So
  deleting the row for a session that has gone quiet does not tidy anything up:
  it hands that exact session a fresh clock, which is the opposite of what the
  row was doing. The rows are ~100 bytes and bounded by the number of sign-ins
  that have ever happened. **Leave them.**

- **⚠️ ROLLING BACK RE-OPENS THE SECOND-DEVICE HOLE.** Without this table the
  rule falls back to `users.last_session_id`, one column shared by every session
  the person has, so two live sessions overwrite each other and neither is ever
  judged idle. That is not a hypothetical: a five-day-old session was measured
  alive on production on 2026-08-25 and would have been admitted. It fails
  **open**, quietly, and only for the accounts an attacker actually has.

- **⚠️ THE APPLICATION CODE MUST MOVE WITH THE TABLE.** `UsersService` reads and
  writes it on the path of **every authenticated request**. Dropping the table
  while the code expects it breaks the whole API, not an edge case. Revert the
  API in the same change, not afterwards.

- **Everyone is admitted once after this ships, deliberately.** The table starts
  empty, so the first request from each live session finds no row, is read as a
  new sign-in, and gets a row. That is the same one-time amnesty migrations 0023
  and 0032 shipped with. It cannot be avoided: we have no record of when those
  sessions were last used, and inventing one would assert something untrue.

- **⚠️ AND IT DOES NOT RETROACTIVELY REFUSE OLD SESSIONS.** A session that has
  been idle for a week is admitted once, then starts its clock from that moment.
  If a session is known to be compromised, ending it in Supabase is the remedy —
  this table is a rule, not a revocation list.

- **No privilege changes needed.** `ALTER DEFAULT PRIVILEGES` from migration
  `20260722170433` already grants `eva_app` SELECT/INSERT/UPDATE/DELETE on new
  tables in `public`, so the table is reachable the moment it exists — checked,
  not assumed. RLS is what constrains it, and it is enabled and forced here.

- **Losing the data costs nothing lasting.** No invoice, reminder, lead or
  membership refers to a session row. Everyone signs in again, and the clocks
  restart.
