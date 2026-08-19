-- Slice 3.0 — migration 0024: a product can be ON and already cancelled.
--
-- Founder ruling 2026-08-19: the four products are separate purchases, and
-- switching one off must stop the bill from the next cycle. Taking the product
-- away in week three of a month the customer has already paid for is how a
-- chargeback is earned, so switching off schedules an END rather than acting
-- immediately: the product keeps working until the period ends, then stops and
-- is never billed again.
--
-- ⚠️ `enabled = true` WITH `ends_at` SET IS THE NORMAL CANCELLED STATE, not a
-- contradiction. Anything reading only `enabled` will tell a customer who has
-- just cancelled that nothing is changing.
--
-- NULLABLE WITH NO BACKFILL. Every existing row gets NULL, meaning "not ending"
-- — which is true of all of them. There is no billing period to compute from
-- yet (Paddle is not wired up), so the API leaves this NULL and switches off
-- immediately; the column is the shape Paddle's period end will land in, and
-- the screen already reads it. Inventing a date now would put a promise on the
-- screen that nothing could keep.
ALTER TABLE "organisation_modules" ADD COLUMN "ends_at" TIMESTAMPTZ(6);

-- The invariant, in the database rather than only in the service: a scheduled
-- end belongs to a product that is still on. When the end actually arrives,
-- `enabled` goes false and `ends_at` is cleared in the same statement — and
-- this constraint is what forces that to be one statement instead of two,
-- because two is where a crash leaves a disabled row still advertising a
-- future end date.
--
-- `disabled_at` remains the record of when it stopped; `ends_at` is only ever
-- about the future.
ALTER TABLE "organisation_modules"
  ADD CONSTRAINT "organisation_modules_ends_at_chk"
  CHECK ("ends_at" IS NULL OR "enabled");
