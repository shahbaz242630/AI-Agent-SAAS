-- Migration 0021 — widen the money columns to BIGINT (Slice 1.6c).
--
-- WHY, in one line: a 32-bit INTEGER cannot hold a Vietnamese invoice.
--
-- `amount_minor_units` and `amount_paid_minor_units` were INTEGER, capped at
-- 2,147,483,647 minor units. What that ceiling means depends entirely on the
-- currency's ISO 4217 exponent, and the founder's stated launch list (GCC, USA,
-- Asia) spans all three exponent groups:
--
--   GBP / AED / USD  (2 digits) -> ~21.4 million per invoice.  Fine.
--   KWD / BHD / OMR  (3 digits) -> ~2.1 million dinar.         Fine, 10x less.
--   JPY              (0 digits) -> ~2.1 billion yen.           Fine.
--   VND              (0 digits) -> ~2.1 billion dong ~= $86k.  NOT fine.
--
-- And under the pre-1.6c code, which multiplied every amount by 100 regardless
-- of currency, the Vietnamese ceiling was roughly **$860** per invoice.
--
-- Done NOW because it is free now. Staging holds a handful of invoices, so this
-- rewrite is instantaneous; the same change against live customer money is a
-- migration somebody has to schedule and watch. Same argument the data-model
-- review made for source/external_id: retrofitting after customers have data is
-- the expensive version.
--
-- Both CHECK constraints (`amount_minor_units > 0`,
-- `amount_paid_minor_units >= 0`) are unaffected: widening a column's type
-- preserves its constraints, and BIGINT satisfies both comparisons natively.
--
-- Prisma maps BIGINT to the TypeScript `bigint`, which `JSON.stringify` refuses
-- to serialise. That is handled at the API boundary by `minorUnitsToNumber`
-- (packages/types/src/money.ts), which converts and THROWS rather than silently
-- losing precision beyond Number.MAX_SAFE_INTEGER. No money value reaches a
-- response as a bigint.

ALTER TABLE "invoices"
  ALTER COLUMN "amount_minor_units" TYPE BIGINT,
  ALTER COLUMN "amount_paid_minor_units" TYPE BIGINT;
