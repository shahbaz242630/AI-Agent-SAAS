-- Closing the hole ruling 37's first cut deliberately left open (#116, §9f):
-- the idle clock could not tell a thief from a second device.
--
-- WHAT WAS WRONG. `users.last_session_id` is ONE column, so two live sessions
-- take turns overwriting it and each then looks "new" to the other — meaning
-- neither is ever judged idle. Measured on production 2026-08-25: an auth
-- session created on 20 August, unused for five days, was still alive in
-- Supabase and would have been admitted on sight, because its id simply
-- differed from the one the column happened to be holding. That is the exact
-- session the two-day rule exists to refuse.
--
-- WHAT THIS IS. One row per (user, Supabase session), each with its OWN
-- activity stamp. A session is now judged on its own history and nobody else's:
-- the laptop being busy no longer vouches for the phone that was stolen.
--
-- ⚠️ `session_id` IS TEXT AND NOT A UUID, FOR THE SAME REASON AS 0032. The
-- value is a claim minted by somebody else's system; a type error here would be
-- a 500 on the sign-in path, which is the blast radius we are shrinking.
--
-- ⚠️ NOTHING PRUNES THIS TABLE, AND THAT IS DELIBERATE. See ROLLBACK.md:
-- deleting a row does not tidy up, it RE-OPENS the door that row was closing —
-- a session with no row is treated as a new sign-in and admitted. The rows are
-- tiny and bounded by sign-ins.
CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "session_id" TEXT NOT NULL,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- The lookup every authenticated request makes, and the guarantee that one
-- session cannot end up with two clocks.
CREATE UNIQUE INDEX "user_sessions_user_id_session_id_key"
    ON "user_sessions"("user_id", "session_id");

ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS, enabled AND forced — forced closes the table-owner bypass, since
-- migrations and any hand-run script connect as the owner.
--
-- ⚠️ THE POLICY IS "YOUR OWN SESSIONS", NOT THE TENANT ONE. Every other table
-- here keys on `app.current_org`, but a session belongs to a PERSON, not to an
-- organisation, and a colleague in the same organisation has no business
-- reading which devices you are signed in on. Fails closed: no context means
-- NULL means no rows.
ALTER TABLE "user_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user_sessions" FORCE ROW LEVEL SECURITY;

CREATE POLICY user_own_sessions ON "user_sessions"
  USING (user_id = NULLIF(current_setting('app.current_user', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.current_user', true), '')::uuid);

-- The login-path READ, and it exists to buy back a network round trip.
--
-- ⚠️ WHY A SECOND POLICY AT ALL. Resolving the caller reads `users` under
-- `app.current_auth_user` (the JWT `sub`), because the app-user id is not known
-- yet — that is the existing `auth_user_resolution` policy from migration
-- 20260722173000. The idle check needs this session's stamp at the same moment.
-- Without this policy that read cannot join, so it has to open its OWN
-- transaction: BEGIN, set_config, SELECT, COMMIT — four round trips on EVERY
-- authenticated request. Measured on production 2026-08-25, a round trip to the
-- database is ~10ms while a request touching no database at all is 3ms, so that
-- is roughly +40ms on everything a signed-in customer does. With this policy the
-- stamp comes back on the query that was already being made, for nothing.
--
-- ⚠️ IT GRANTS NO AUTHORITY THAT `auth_user_resolution` DOES NOT ALREADY GRANT.
-- Same GUC, same identity, same fail-closed shape (missing context => NULL =>
-- no rows), and the subquery it leans on is itself still subject to `users`'
-- own policies. It is "your own sessions, on the way in".
--
-- ⚠️ SELECT ONLY, AND THAT IS LOAD-BEARING. Writes stay behind
-- `user_own_sessions` and `app.current_user`, so freshening or deleting a
-- session row still requires the app-user context. Those are the two attacks
-- that would let a refused session back in, and `rls.spec.ts` holds them down.
CREATE POLICY session_auth_resolution ON "user_sessions"
  FOR SELECT
  USING (
    user_id IN (
      SELECT id FROM users
       WHERE auth_user_id = NULLIF(current_setting('app.current_auth_user', true), '')::uuid
    )
  );
