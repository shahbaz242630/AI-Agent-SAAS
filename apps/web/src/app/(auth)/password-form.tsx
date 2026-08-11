"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { setPassword } from "./set-password";
import {
  AuthError,
  AuthField,
  AuthHeading,
  AuthPrimaryLink,
  AuthSubmit,
  SuccessDisc,
} from "./auth-frame";

/**
 * Setting a password, in the two situations where somebody does.
 *
 * `change` — signed in and they know the current one.
 * `new`    — they just followed a recovery link, so by definition they do not.
 *
 * ⚠️ THE CURRENT-PASSWORD FIELD IS RE-AUTHENTICATION, NOT VALIDATION, and it is
 * OURS rather than Supabase's — `updateUser({ password })` accepts any live
 * session, so without it a borrowed one could lock the owner out of their own
 * account. That, and ending every OTHER session afterwards, both live in
 * `set-password.ts`, where a test can reach them; this file is the form.
 *
 * ⚠️ `new` IS NOT A WEAKER DOOR INTO `change`. It cannot be
 * reached without a session Supabase itself just minted from a link sent to the
 * account's own address. The real hardening for both is Supabase's "Secure
 * password change" setting, which requires a recent sign-in at the API level —
 * a dashboard toggle, recorded in the handoff, not something this file can do.
 */
export function PasswordForm({ mode, email }: { mode: "change" | "new"; email: string }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState<{ otherSessionsEnded: boolean } | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const outcome = await setPassword(createClient(), {
      mode,
      email,
      currentPassword: current,
      newPassword: next,
    });

    if (!outcome.ok) {
      setError(outcome.error);
      setPending(false);
      return;
    }

    // The session's tokens changed underneath the server components.
    router.refresh();
    setDone({ otherSessionsEnded: outcome.otherSessionsEnded });
    setPending(false);
  }

  if (done) {
    return (
      <>
        <SuccessDisc />
        <AuthHeading
          title={mode === "change" ? "Password changed" : "Password set"}
          /**
           * ⚠️ THE SECOND SENTENCE IS NOW TRUE, WHICH IS WHY IT IS HERE. "Signs
           * out your other devices" was written for these screens on 2026-08-10
           * and deliberately cut, because we had not checked and we do not state
           * facts we have not checked. `setPassword` ends the other sessions and
           * reports whether it managed it, so the screen can say what actually
           * happened rather than what we hoped.
           */
          subtitle={
            done.otherSessionsEnded
              ? "You're still signed in on this device. Anywhere else you were signed in has been signed out."
              : "You're still signed in on this device. We couldn't sign out your other devices — try changing it again in a moment."
          }
        />
        <AuthPrimaryLink href="/app">Back to Eva</AuthPrimaryLink>
      </>
    );
  }

  return (
    <>
      <AuthHeading
        title={mode === "change" ? "Change your password" : "Choose a new password"}
        subtitle={
          mode === "change" ? `Signed in as ${email}` : `Setting a new password for ${email}`
        }
      />
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        {mode === "change" && (
          <AuthField
            id="current-password"
            label="Current password"
            name="current-password"
            type="password"
            autoComplete="current-password"
            required
            placeholder="••••••••"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
          />
        )}
        <AuthField
          id="new-password"
          label="New password"
          name="new-password"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
          autoFocus={mode === "new"}
          placeholder="At least 6 characters"
          value={next}
          onChange={(event) => setNext(event.target.value)}
        />
        {error && <AuthError>{error}</AuthError>}
        <AuthSubmit pending={pending}>
          {pending ? "Saving…" : mode === "change" ? "Change password" : "Set password"}
        </AuthSubmit>
      </form>
    </>
  );
}
