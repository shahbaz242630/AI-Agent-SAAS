-- Slice 1.6c task 13: what a new invoice's currency dropdown opens on.
--
-- A DEFAULT, NEVER A RESTRICTION (founder ruling 2026-08-04). Currency stays
-- per invoice; this only decides which one is pre-selected, so a UAE business
-- stops typing AED every time. Nothing reads it to REFUSE a currency.
--
-- NOT NULL with a default, so every existing organisation is backfilled to GBP
-- in the same statement and no row can arrive without an answer. The launch
-- market is the UK, which is why GBP rather than a nullable "unset" — a null
-- would push the choice back onto every caller and they would each pick their
-- own fallback, which is the duplication this column removes.
ALTER TABLE "organisation_settings"
  ADD COLUMN "default_currency" TEXT NOT NULL DEFAULT 'GBP';

-- The money layer indexes its minor-unit table by ISO 4217 code, so a lowercase
-- or malformed code here would silently miss and take the 2-digit fallback —
-- wrong for KWD (3) and JPY (0). Refused at the column instead.
ALTER TABLE "organisation_settings"
  ADD CONSTRAINT "organisation_settings_default_currency_chk"
  CHECK ("default_currency" ~ '^[A-Z]{3}$');
