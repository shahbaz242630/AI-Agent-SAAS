/**
 * Where Supabase sends somebody after they click a link in one of its emails.
 *
 * ⚠️ THIS EXISTS BECAUSE THE SIGN-UP CONFIRMATION LINK WENT NOWHERE, AND IT WAS
 * FOUND BY WALKING THE REAL FLOW ON PRODUCTION (2026-08-10). `signUp` was
 * called without any redirect at all, so Supabase fell back to the project's
 * Site URL — the marketing page — and handed it a `?code=` that page has no
 * idea what to do with. The account WAS confirmed, because that happens on
 * Supabase's side before the redirect; the customer was simply dropped on a
 * landing page with no sign that anything had worked, and had to go and find
 * the sign-in link themselves.
 *
 * ⚠️ EVERY EMAIL LINK MUST COME BACK THROUGH `/auth/confirm`. That route is the
 * only thing that turns a token into a session. A redirect that points anywhere
 * else — the site root, `/sign-in`, `/app` — throws the token away, and does it
 * silently, because landing on a real page that renders fine looks like success.
 *
 * Kept as a pure function of `origin` so staging and production each ask for
 * their own, and so a test can state the rule without a browser.
 */
export function emailReturnUrl(origin: string, next: string): string {
  return `${origin}/auth/confirm?next=${encodeURIComponent(next)}`;
}

/** Where each kind of email should land once its token has been spent. */
export const EMAIL_RETURN = {
  /** Confirming a new account: straight in. `/app` sends a new account on to setup. */
  signUp: "/app",
  /** A recovery link: the screen that sets a password without asking for the old one. */
  passwordReset: "/new-password",
} as const;
