# ROLLBACK — 20260902200000_eva_can_be_reached_on_a_channel

Migration 0040 creates two new tables and touches nothing that existed before
it. Rolling it back is dropping them.

| Change | Detail                                                                                                           |
| ------ | ---------------------------------------------------------------------------------------------------------------- |
| Added  | `channel_connections` — whose channel account belongs to which organisation, for which product                   |
| Added  | `inbound_channel_messages` — every delivery that arrived on a channel, verbatim, idempotent on the provider's id |
| Added  | RLS (forced) with `tenant_isolation` on both, plus the SELECT-only `channel_asset_routing` policy on connections |
| Added  | grants `SELECT, INSERT, UPDATE` to `eva_app` on both; `DELETE` explicitly revoked on both                        |

## Before rolling back

⚠️ **`inbound_channel_messages` IS EVIDENCE OF WHAT A STRANGER SENT, AND META
KEEPS NO HISTORY.** Their documentation says there is no API for fetching past
webhooks. Once these rows are dropped they cannot be recovered from anywhere.
Export them first if any organisation has received a message:

```sql
-- Expect zero if nothing has ever arrived; otherwise export before dropping.
SELECT organisation_id, count(*) FROM inbound_channel_messages GROUP BY organisation_id;
```

## Rolling back

```sql
DROP TABLE IF EXISTS "inbound_channel_messages";
DROP TABLE IF EXISTS "channel_connections";
DELETE FROM "_prisma_migrations" WHERE migration_name = '20260902200000_eva_can_be_reached_on_a_channel';
```

Policies, indexes and grants go with the tables. Nothing else in the schema
references either table, so no other change is needed.
