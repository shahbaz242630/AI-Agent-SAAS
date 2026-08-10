"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
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
 * OURS rather than Supabase's. `updateUser({ password })` accepts any live
 * session, so without this a stolen or borrowed session — an unlocked laptop —
 * could change the password and lock the owner out of their own account. We
 * check it by signing in with it first, which is the only way to verify a
 * password we deliberately never store.
 *
 * ⚠️ THAT ALSO MEANS `new` IS NOT A WEAKER DOOR INTO `change`. It cannot be
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
  const [done, setDone] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const supabase = createClient();

    if (mode === "change") {
      const { error: reauthError } = await supabase.auth.signInWithPassword({
        email,
        password: current,
      });
      if (reauthError) {
        // Deliberately not the API's wording: "Invalid login credentials" is
        // about signing in, and this person is already signed in.
        setError("That current password isn't right. Try again.");
        setPending(false);
        return;
      }
    }

    const { error: updateError } = await supabase.auth.updateUser({ password: next });
    if (updateError) {
      setError(updateError.message);
      setPending(false);
      return;
    }

    // The session's tokens changed underneath the server components.
    router.refresh();
    setDone(true);
    setPending(false);
  }

  if (done) {
    return (
      <>
        <SuccessDisc />
        <AuthHeading
          title={mode === "change" ? "Password changed" : "Password set"}
          subtitle="You're still signed in on this device."
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
