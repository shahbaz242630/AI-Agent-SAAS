# ROLLBACK — 20260728074025_email_accounts

Migration 0013 (Slice 1.6) creates `email_accounts` (connected Microsoft 365
mailboxes; AES-256-GCM-encrypted OAuth tokens), with RLS enabled+forced, the
`tenant_isolation` policy, `eva_app` grants, CHECK constraints on
`provider`/`health_status`, and a partial unique index enforcing one LIVE
connection per organisation.

## Rollback SQL

```sql
DROP TABLE IF EXISTS email_accounts;
```

(Dropping the table drops its indexes, constraints, policy and grants with
it; the `eva_app` grant dies with the table.)

## Notes

- **Data loss:** total for this table — every stored mailbox connection is
  destroyed. Any organisation that connected a mailbox must reconnect (new
  OAuth consent). Acceptable pre-launch; prefer a new corrective migration
  over rolling back once real connections exist (forward-only convention,
  BRD 18).
- Re-applying after rollback recreates the table cleanly — no manual
  follow-up.
