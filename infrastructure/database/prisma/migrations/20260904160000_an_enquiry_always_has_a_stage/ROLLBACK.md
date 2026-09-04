# ROLLBACK — 20260904160000_an_enquiry_always_has_a_stage

Migration 0043 makes `leads.pipeline_stage_id` NOT NULL. It adds nothing and
changes no row; it refuses to run if any lead has no stage.

| Change  | Detail                                         |
| ------- | ---------------------------------------------- |
| Changed | `leads.pipeline_stage_id`: nullable → NOT NULL |

## Before rolling back

Nothing to check: dropping a NOT NULL loses no data.

## Rollback SQL

```sql
ALTER TABLE "leads" ALTER COLUMN "pipeline_stage_id" DROP NOT NULL;

DELETE FROM "_prisma_migrations"
WHERE migration_name = '20260904160000_an_enquiry_always_has_a_stage';
```

Then redeploy the api at a commit before this migration's PR only if a writer
that omits the stage has to be brought back; every writer on `main` since 3.3b
supplies one, so the api after this PR runs unchanged against the rolled-back
column.
