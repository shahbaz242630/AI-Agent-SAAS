"use client";

import { useState } from "react";
import { EMAIL_RETURN, emailReturnUrl } from "@/lib/auth-redirects";
import { createClient } from "@/lib/supabase/client";
import {
  AuthError,
  AuthField,
  AuthHeading,
  AuthOutlineLink,
  AuthSubmit,
  SuccessDisc,
} from "../auth-frame";

/**
 * "I've forgotten my password" — ask for the address, send the link.
 *
 * ⚠️ THE SENT MESSAGE NEVER CONFIRMS WHETHER THE ACCOUNT EXISTS, and that is
 * not vagueness for its own sake. A page that answers "no account with that
 * address" turns the reset form into a way of asking us which of a list of
 * email addresses banks with Eva. Supabase's own API is deliberately silent
 * for the same reason and returns success either way; the wording matches what
 * the API actually knows.
 *
 * ⚠️ THE ERROR BRANCH IS FOR TRANSPORT FAILURES ONLY — rate limits and
 * outages. It must never grow a branch that reports "unknown address".
 */
export function ResetForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const supabase = createClient();
    /**
     * ⚠️ `redirectTo` MUST BE ON THE ALLOWLIST IN THE SUPABASE DASHBOARD or the
     * link in the email silently falls back to the Site URL and the customer
     * lands on the home page with no way to set a password. Built from
     * `window.location.origin` so staging and production each ask for their own
     * origin rather than one being hard-coded into the other's build.
     */
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: emailReturnUrl(window.location.origin, EMAIL_RETURN.passwordReset),
    });

    if (resetError) {
      setError(resetError.message);
      setPending(false);
      return;
    }
    setSent(true);
    setPending(false);
  }

  if (sent) {
    return (
      <>
        <SuccessDisc tone="sent" />
        <AuthHeading
          title="Check your email"
          subtitle="If an account exists for that address, a reset link is on its way. It's valid for one hour."
        />
        <AuthOutlineLink href="/sign-in">Back to sign in</AuthOutlineLink>
      </>
    );
  }

  return (
    <>
      <AuthHeading
        title="Reset your password"
        subtitle="Tell us your email and we'll send a reset link."
      />
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <AuthField
          id="email"
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          placeholder="you@yourcompany.co.uk"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        {error && <AuthError>{error}</AuthError>}
        <AuthSubmit pending={pending}>{pending ? "Sending…" : "Send reset link"}</AuthSubmit>
      </form>
    </>
  );
}
