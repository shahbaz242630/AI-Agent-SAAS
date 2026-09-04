-- Slice 3.3d — migration 0042: a do-not-contact is a consent event.
--
-- The last of the four 3.3 PRs (ruling 75), deferred to the end on purpose
-- (ruling 78) because nothing in 3.3a–c reads this table and it is the one
-- table the product on sale — Invoice Chasing — consults before every send.
-- Blueprint §2.5 ("compliance as data") and §3.2: consent is a typed record
-- per channel per purpose, never a boolean, with a basis, evidence, a
-- jurisdiction and an expiry. The do-not-contact log already IS an append-only
-- event log whose current state is the newest row (0028); this migration
-- widens it into that record instead of building a second one beside it.
--
-- ⚠️ BEHAVIOUR DOES NOT CHANGE FOR THE CUSTOMER. Every existing row keeps its
-- meaning: a `suppress` becomes an `opted_out` event whose `purpose` is `all`
-- — every message, on every product, which is exactly what "do not contact"
-- has always meant here (the invoice chaser, a service message, obeys it; so
-- would marketing). A `correct` becomes `corrected`. The newest row still
-- wins; the runtime role still cannot UPDATE or DELETE; the reason on a
-- correction is still demanded by the database. `suppression.ts` is repointed
-- and asks the same questions with the new words.
--
-- ⚠️ `purpose = 'all'` IS A DECISION, WRITTEN DOWN HERE. The blueprint names
-- two purposes, `service` and `marketing`, because CONSENT is granted for one
-- or the other — a person who ticked "send me offers" did not consent to
-- anything else. An OPT-OUT is different: "do not contact me" names no
-- purpose, it names everything, and the BRD hard rule says it "applies across
-- all channels". A third value, `all`, is the honest record of that, and a
-- reader asking "may Eva contact this person at all?" looks at `all` and
-- nothing else. A marketing-only opt-out (which several jurisdictions
-- recognise while service messages continue) will be `purpose = 'marketing'`
-- and is the engine's business (3.5), not the do-not-contact path's.
-- Consent cannot be `all` — a CHECK below says so — because there is no such
-- thing as consenting to everything for every purpose.
--
-- ⚠️ THE OLD NAME STAYS, AS A VIEW, IN THE OLD SHAPE. Hand SQL, the ACL
-- verification script and any reader not yet repointed see `suppression_events`
-- with `action` = `suppress` / `correct`, showing only the do-not-contact rows
-- (`purpose = 'all'`). It is `security_invoker` and SELECT-only for `eva_app` —
-- the 3.3a lesson, twice over: a view runs as its owner unless told otherwise,
-- and a view gets the same default grants as a table.
--
-- Production held FOUR rows when this was written (2 suppress, 2 correct, one
-- organisation); all four are the founder's own do-not-contact and its
-- correction, both channels. Nothing is moved; the words on one column change.

-- ---------------------------------------------------------------------------
-- 1. The table takes its name. Lossless: rows, RLS, the policy, the grants,
--    the foreign key and the index all follow a RENAME.
-- ---------------------------------------------------------------------------

ALTER TABLE "suppression_events" RENAME TO "consent_events";

ALTER TABLE "consent_events" RENAME CONSTRAINT "suppression_events_pkey"
  TO "consent_events_pkey";
ALTER TABLE "consent_events" RENAME CONSTRAINT "suppression_events_organisation_id_fkey"
  TO "consent_events_organisation_id_fkey";
ALTER INDEX "suppression_events_organisation_id_channel_value_created_at_idx"
  RENAME TO "consent_events_organisation_id_channel_value_created_at_idx";

-- ---------------------------------------------------------------------------
-- 2. `action` becomes `state`, and its two words become the consent vocabulary.
-- ---------------------------------------------------------------------------
--
-- The 0028 CHECKs come off first: they name the old values and would refuse
-- the rewrite. The rewrite is one-to-one and the view below maps it back, so
-- nothing that could be read before cannot be read after.

ALTER TABLE "consent_events"
  DROP CONSTRAINT "suppression_events_action_check",
  DROP CONSTRAINT "suppression_events_correction_reason_check";

ALTER TABLE "consent_events" RENAME COLUMN "action" TO "state";

UPDATE "consent_events"
SET "state" = CASE "state"
  WHEN 'suppress' THEN 'opted_out'
  WHEN 'correct'  THEN 'corrected'
  ELSE "state"
END;

-- ⚠️ THE DEFAULT IS THE SAFE DIRECTION, AS 0028's WAS. A row written with no
-- state is an opt-out: nobody gets contacted who asked not to be. The only
-- writers today are `suppression.ts`, which always says which, and the test
-- fixtures that stand in for a person's request.
ALTER TABLE "consent_events" ALTER COLUMN "state" SET DEFAULT 'opted_out';

ALTER TABLE "consent_events"
  -- `opted_in` is admitted by the CHECK and refused by the API — 0027's rule.
  -- Nothing writes consent yet; the engine (3.5) will, and it must not need a
  -- migration to say the one word this table exists for.
  ADD CONSTRAINT "consent_events_state_check"
    CHECK ("state" IN ('opted_in', 'opted_out', 'corrected')),
  -- A correction must say why, at the database layer (0028, carried across).
  ADD CONSTRAINT "consent_events_correction_reason_check"
    CHECK ("state" <> 'corrected' OR "reason" IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 3. The columns the compliance model needs (blueprint §2.5, §3.2).
-- ---------------------------------------------------------------------------
--
-- Every existing row is a do-not-contact request or its correction, recorded
-- by a person at a screen: `purpose = 'all'`, `source = 'user'`, and no basis,
-- evidence, jurisdiction or expiry — an opt-out rests on nothing but itself
-- and never runs out.

ALTER TABLE "consent_events"
  ADD COLUMN "purpose"      TEXT NOT NULL DEFAULT 'all',
  ADD COLUMN "basis"        TEXT,
  ADD COLUMN "source"       TEXT NOT NULL DEFAULT 'user',
  ADD COLUMN "evidence"     JSONB,
  ADD COLUMN "jurisdiction" TEXT,
  ADD COLUMN "expires_at"   TIMESTAMPTZ(6);

ALTER TABLE "consent_events"
  -- `all` is an opt-out's scope; `service` and `marketing` are what consent
  -- is granted for.
  ADD CONSTRAINT "consent_events_purpose_check"
    CHECK ("purpose" IN ('all', 'service', 'marketing')),
  -- ⚠️ CONSENT NAMES A PURPOSE. "Opted in to everything" is not a record any
  -- regulator recognises, and a row like it would make the do-not-contact read
  -- (`purpose = 'all'`, newest row wins) answer "contactable" on the strength
  -- of a consent that never existed.
  ADD CONSTRAINT "consent_events_consent_names_a_purpose_check"
    CHECK (NOT ("state" = 'opted_in' AND "purpose" = 'all')),
  -- The bases the compliance report enumerated (blueprint §2.5 item 1).
  ADD CONSTRAINT "consent_events_basis_check"
    CHECK ("basis" IS NULL OR "basis" IN (
      'solicited', 'service', 'soft_opt_in', 'express', 'express_automated_voice',
      'pewc', 'implied_ebr_purchase', 'implied_ebr_inquiry', 'dca_registered',
      'platform_opt_in'
    )),
  -- ⚠️ CONSENT WITHOUT A BASIS IS THE BOOLEAN THE REPORT FORBIDS; an opt-out
  -- with one is a contradiction. Exactly the opt-ins carry a basis.
  ADD CONSTRAINT "consent_events_basis_on_consent_only_check"
    CHECK (("state" = 'opted_in') = ("basis" IS NOT NULL)),
  -- Where the event came from: a person at a screen, the person's own message
  -- (a STOP), a form they filled in, an import, or Eva herself (a bounce, a
  -- register scrub).
  ADD CONSTRAINT "consent_events_source_check"
    CHECK ("source" IN ('user', 'inbound_message', 'form', 'import', 'system')),
  -- ISO 3166-1 alpha-2, optionally with a 3166-2 subdivision (`US-FL`), because
  -- the rules that differ by state are quiet hours and cure periods, and both
  -- hang off where the person is.
  ADD CONSTRAINT "consent_events_jurisdiction_check"
    CHECK ("jurisdiction" IS NULL OR "jurisdiction" ~ '^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  -- ⚠️ AN OPT-OUT NEVER EXPIRES. "Permanently" is the BRD's word, and this is
  -- where the database keeps it: only a consent can carry an expiry.
  ADD CONSTRAINT "consent_events_expiry_on_consent_only_check"
    CHECK ("expires_at" IS NULL OR "state" = 'opted_in');

-- ---------------------------------------------------------------------------
-- 4. Permanence, re-asserted.
-- ---------------------------------------------------------------------------
--
-- The RENAME carried the 0005 / 0028 REVOKE across — privileges follow the
-- table, not its name. Said again because a GRANT only ever adds and this is
-- the statement `rls.spec.ts` and `grants.spec.ts` hold the table to.

REVOKE UPDATE, DELETE ON "consent_events" FROM eva_app;

-- ---------------------------------------------------------------------------
-- 5. The old name, as a read-only window in the old shape.
-- ---------------------------------------------------------------------------
--
-- 🚨 `security_invoker = true` IS THE SECURITY OF THIS VIEW (0041's lesson). A
-- view runs with its OWNER's privileges by default — the migrations role,
-- which `tenant_isolation` does not bind — so without it `SELECT * FROM
-- suppression_events` as `eva_app` would list every organisation's
-- do-not-contact entries whatever `app.current_org` says. With it, the view
-- runs as the caller and the policy on `consent_events` applies. Postgres 15+;
-- local and CI run 16, production 17.
--
-- Only the do-not-contact rows show here (`purpose = 'all'`): a reader of the
-- old name is asking the old question, and a marketing opt-in must not appear
-- in it as a `correct`. The CASE makes the view non-updatable in any case; the
-- REVOKE makes the grant table tell the truth about that.
CREATE VIEW "suppression_events" WITH (security_invoker = true) AS
  SELECT
    "id",
    "organisation_id",
    CASE "state" WHEN 'opted_out' THEN 'suppress' ELSE 'correct' END AS "action",
    "channel",
    "value",
    "reason",
    "created_at",
    "created_by"
  FROM "consent_events"
  WHERE "purpose" = 'all' AND "state" IN ('opted_out', 'corrected');

-- ⚠️ A VIEW IS A RELATION, AND THE DEFAULT PRIVILEGES APPLY TO IT TOO (0041's
-- first draft found `eva_app` holding INSERT, UPDATE and DELETE on a view it
-- had only granted SELECT on).
GRANT SELECT ON "suppression_events" TO eva_app;
REVOKE INSERT, UPDATE, DELETE ON "suppression_events" FROM eva_app;
