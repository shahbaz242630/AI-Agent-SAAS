# ROLLBACK — 20260820120000_leads

Migration 0026 creates the foundation of Lead Follow-up by Email: the lead
record, the evidence that proves the person contacted us first, and the
immutable consent-text versions that evidence can cite.

Three new tables. Nothing existing is altered, so the rollback is a clean drop.

| Table           | Created                                                      |
| --------------- | ------------------------------------------------------------ |
| `consent_texts` | Immutable consent wording, versioned per organisation        |
| `leads`         | The enquiry, its contact details and its status              |
| `lead_evidence` | One row per lead: channel, ids, timestamps, verbatim excerpt |

## Rollback SQL

```sql
-- Order matters: lead_evidence references both of the others.
DROP TABLE IF EXISTS "lead_evidence";
DROP TABLE IF EXISTS "leads";
DROP TABLE IF EXISTS "consent_texts";
```

Policies, indexes, constraints and grants are all owned by these tables and go
with them; nothing needs dropping separately.

## Notes

- **⚠️ THIS ROLLBACK DESTROYS COMPLIANCE EVIDENCE, WHICH IS THE WHOLE POINT OF
  THE TABLES.** BRD 4.3 requires stored proof that each lead initiated contact
  with the business, because lead follow-up is marketing-adjacent under PECR.
  Dropping `lead_evidence` does not merely lose data — it removes our ability
  to show why anyone was contacted. **Export all three tables before running
  this**, even in a hurry, even on staging while prod and staging still share
  one database (founder ruling 2026-08-09).

- **`lead_evidence` and `consent_texts` are UPDATE-less by grant, not by
  trigger.** `eva_app` holds `SELECT, INSERT` on both and nothing else, so the
  database refuses to change a row for every caller, forever. A rollback that
  recreates these tables **must not** re-grant `UPDATE`: the immutability is
  the grant, and a well-meaning `GRANT ALL` during a restore silently removes
  it with nothing failing.

- **Cascade still works without `DELETE`.** Referential actions run with the
  privileges of the constraint owner, so deleting a lead still removes its
  evidence. What is impossible is deleting evidence on its own and leaving a
  lead that looks contactable but cannot prove it.

- **The CHECK constraints are deliberately narrow.** `source` and `channel`
  allow only the three channels a person can log by hand today, and `status`
  allows only `new` and `do_not_contact`. Slice 3.1b widens the source CHECK to
  include `email` when there is a mailbox reader to produce one; 3.1c widens
  the status CHECK when Eva can actually answer. Rolling back to a state where
  those values exist in data but not in the CHECK would fail on re-application
  — check the data before re-applying a widened migration.

- **No `deleted_at` on `lead_evidence` or `consent_texts`.** Both are records
  of something that happened; a soft-delete flag on a compliance record is a
  way of pretending it did not.
