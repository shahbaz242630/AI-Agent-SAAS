-- Slice 0.3 — login-path identity resolution (BRD 9.4/15).
-- The API authenticates via Supabase JWTs whose `sub` is the AUTH user id
-- (users.auth_user_id), while every other RLS policy keys on the APP user id
-- (users.id via app.current_user). Resolving auth_user_id -> users.id is the
-- one read that cannot declare an app-user context yet, so it gets its own
-- narrow policy: SELECT-only, keyed to a dedicated GUC, still fail closed
-- (missing/empty context => NULL => no rows).

CREATE POLICY auth_user_resolution ON users
  FOR SELECT
  USING (auth_user_id = NULLIF(current_setting('app.current_auth_user', true), '')::uuid);
