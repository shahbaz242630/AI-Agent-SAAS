# ROLLBACK — 20260901160000_the_words_eva_replies_with

Migration 0035 adds `lead_reply_templates`, the first table the Lead Follow-up
by Email product owns. It creates one table and touches nothing that existed
before it.

| Change    | Detail                                                                  |
| --------- | ----------------------------------------------------------------------- |
| Added     | table `lead_reply_templates`                                            |
| Added     | `lead_reply_templates_organisation_id_idx`                              |
| Added     | `lead_reply_templates_single_automatic_key` (partial unique)            |
| Added     | `lead_reply_templates_live_name_key` (partial unique, `lower(name)`)    |
| Added     | RLS: `ENABLE` + `FORCE`, policy `tenant_isolation` on `app.current_org` |
| Added     | `GRANT SELECT, INSERT, UPDATE` then `REVOKE DELETE` for `eva_app`       |
| Unchanged | every other table, every other policy, every other grant                |

**This is the easiest rollback in the project** — nothing else references the
table, no column was added to an existing one, and no data was back-filled. It
is a `DROP TABLE`.

## Before rolling back

```sql
-- What would be destroyed: the wording each customer edited for themselves.
SELECT organisation_id,
       count(*) FILTER (WHERE deleted_at IS NULL)                    AS live_templates,
       count(*) FILTER (WHERE is_automatic AND deleted_at IS NULL)   AS automatic
FROM lead_reply_templates
GROUP BY organisation_id;
```

⚠️ **A ROW HERE IS A CUSTOMER'S OWN WORDS, AND THE ROLLBACK DOES NOT KEEP
THEM.** Three of them were written by us and are reproducible from
`default-templates.ts`; anything a customer changed is not. The three seeded
defaults come back on the next read after a re-migration, so what is actually
lost is every edit — which is the whole point of the feature.

**If any row differs from the seeded default, copy the table out before
dropping it:**

```sql
CREATE TABLE lead_reply_templates_backup_0035 AS
  SELECT * FROM lead_reply_templates;
```

That backup sits outside RLS and outside the application. Treat it as customer
data: drop it once the templates are restored, or it becomes a copy of
everybody's words that nothing is guarding.

⚠️ **AND CHECK 3.1c-3 HAS NOT SHIPPED YET.** The reply record added later in
3.1c points at the template it used. Once that foreign key exists this stops
being a bare `DROP TABLE` and becomes a rollback that takes the evidence of
what Eva sent along with it — at which point this file is wrong and needs
rewriting alongside that migration.

## Rollback SQL

```sql
BEGIN;

-- Indexes, policy and grants all go with the table; naming them is not needed.
DROP TABLE "lead_reply_templates";

COMMIT;
```

## What the application does after a rollback

Every read of the table disappears with the code that is rolled back alongside
it. If the table is dropped while the NEW api is still running, the templates
screen 500s on every load — the lazy seed on first read is an INSERT naming a
table that is gone — and, once 3.1c-3 ships, no automatic reply is sent at all.

**Roll the code back first, then the schema**, the reverse of the deploy order
(migration → merge → deploy).

⚠️ **THE FAILURE IS LOUD, WHICH IS THE GOOD CASE.** Nothing in the reply path
treats a missing template as "send nothing and carry on" — a customer whose
enquiries silently stopped being answered would find out from the enquirer.
