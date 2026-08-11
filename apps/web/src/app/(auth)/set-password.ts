/**
 * Setting a password, as a decision rather than an event handler.
 *
 * ⚠️ EXTRACTED SO A TEST CAN REACH IT. The web app has no DOM test environment
 * — components are rendered with `renderToStaticMarkup` — so anything left
 * inside `onSubmit` is untestable by construction, and the standing rule earned
 * three times over (`bookMoneyPanel`, `routeKind`, `emailReturnUrl`) is to move
 * the breakable decision somewhere a test can state it.
 */

/** The slice of the Supabase client this needs — structural, so a test passes a
 *  plain object and the real client satisfies it unchanged. */
export interface PasswordClient {
  auth: {
    signInWithPassword(credentials: {
      email: string;
      password: string;
    }): Promise<{ error: { message: string } | null }>;
    updateUser(attributes: { password: string }): Promise<{ error: { message: string } | null }>;
    signOut(options: { scope: "others" }): Promise<{ error: { message: string } | null }>;
  };
}

export interface SetPasswordRequest {
  /** `change` — signed in and they know the current one.
   *  `new` — they followed a recovery link, so by definition they do not. */
  mode: "change" | "new";
  email: string;
  currentPassword: string;
  newPassword: string;
}

export type SetPasswordOutcome =
  { ok: true; otherSessionsEnded: boolean } | { ok: false; error: string };

export async function setPassword(
  client: PasswordClient,
  request: SetPasswordRequest,
): Promise<SetPasswordOutcome> {
  /**
   * ⚠️ THE CURRENT-PASSWORD CHECK IS RE-AUTHENTICATION, NOT VALIDATION, and it
   * is OURS rather than Supabase's. `updateUser({ password })` accepts any live
   * session, so without this a borrowed one — an unlocked laptop — could change
   * the password and lock the owner out of their own account. We verify it by
   * signing in with it, the only way to check a password we deliberately never
   * store.
   */
  if (request.mode === "change") {
    const { error } = await client.auth.signInWithPassword({
      email: request.email,
      password: request.currentPassword,
    });
    // Deliberately not the API's wording: "Invalid login credentials" is about
    // signing in, and this person is already signed in.
    if (error) return { ok: false, error: "That current password isn't right. Try again." };
  }

  const { error: updateError } = await client.auth.updateUser({ password: request.newPassword });
  if (updateError) return { ok: false, error: updateError.message };

  /**
   * ⚠️ EVERY OTHER SESSION IS ENDED HERE, AND SUPABASE WILL NOT DO IT FOR US.
   * Changing a password does not revoke existing sessions in Supabase — it is
   * not the default and there is an open issue asking for it (supabase/auth
   * #797). That gap is the "unexpired session" attack from the 2022
   * account-pre-hijacking study (arXiv 2205.10174): someone whose password has
   * been stolen changes it, believes they are safe, and the thief's session
   * carries on working indefinitely. It applies at least as much to `new` —
   * a person resetting a password they fear was compromised is the exact case.
   *
   * `scope: "others"` keeps THIS device signed in, which is what the screen
   * says happens.
   *
   * ⚠️ A FAILURE HERE IS REPORTED, NEVER SWALLOWED. The password really did
   * change, so this is not an error — but "your other devices are signed out"
   * would be a false statement about security, and today's whole lesson is that
   * a quiet failure costs more than a loud one. The caller says which of the
   * two happened.
   */
  const { error: signOutError } = await client.auth.signOut({ scope: "others" });
  return { ok: true, otherSessionsEnded: !signOutError };
}
