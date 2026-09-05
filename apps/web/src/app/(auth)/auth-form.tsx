"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { EMAIL_RETURN, emailReturnUrl } from "@/lib/auth-redirects";
import { createClient } from "@/lib/supabase/client";
import {
  AuthError,
  AuthField,
  AuthHeading,
  AuthOutlineLink,
  AuthSubmit,
  SuccessDisc,
} from "./auth-frame";

interface AuthFormProps {
  mode: "sign-in" | "sign-up";
}

const COPY = {
  "sign-in": {
    heading: "Sign in to Eva",
    subtitle: "Good to have you back.",
    submit: "Sign in",
    pending: "Signing in…",
    switchPrompt: "New to Eva?",
    // The word a new visitor looks for (founder, 2026-09-05), not a synonym.
    switchLabel: "Sign up",
    switchHref: "/sign-up",
  },
  "sign-up": {
    heading: "Create your Eva account",
    subtitle: "Two minutes to set up.",
    submit: "Create account",
    pending: "Creating account…",
    switchPrompt: "Already have an account?",
    switchLabel: "Sign in",
    switchHref: "/sign-in",
  },
} as const;

/**
 * Email + password credentials form shared by /sign-in and /sign-up.
 *
 * ⚠️ THE DESIGN'S SIGN-UP SUBTITLE SAID "No card needed." IT IS NOT HERE. That
 * is a pricing promise, and pricing is one of the four things still waiting on
 * the founder — the same reason the landing page is not built. We do not
 * currently take a card, so it is probably true; "probably true" is not a
 * standard for a sentence on the page where somebody hands over their email.
 */
export function AuthForm({ mode }: AuthFormProps) {
  const router = useRouter();
  const copy = COPY[mode];
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const supabase = createClient();

    if (mode === "sign-in") {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
      if (signInError) {
        setError(signInError.message);
        setPending(false);
        return;
      }
      router.push("/app");
      router.refresh();
      return;
    }

    /**
     * ⚠️ `emailRedirectTo` IS NOT OPTIONAL, AND OMITTING IT SHIPPED. Without it
     * Supabase falls back to the project's Site URL — the marketing page — which
     * is handed a `?code=` it cannot spend. Confirmed on production 2026-08-10:
     * the account was created and verified, and the customer landed on a page
     * that said nothing had happened. `/auth/confirm` is the only route that
     * turns the token into a session.
     */
    const { data, error: signUpError } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: emailReturnUrl(window.location.origin, EMAIL_RETURN.signUp) },
    });
    if (signUpError) {
      setError(signUpError.message);
      setPending(false);
      return;
    }
    // Projects with email confirmation disabled return a session immediately —
    // send the user straight into the app; otherwise ask them to confirm.
    if (data.session) {
      router.push("/app");
      router.refresh();
      return;
    }
    setAwaitingConfirmation(true);
    setPending(false);
  }

  if (awaitingConfirmation) {
    return (
      <>
        <SuccessDisc tone="sent" />
        <AuthHeading
          title="Check your email"
          subtitle={
            <>
              We&apos;ve sent a confirmation link to <span className="font-semibold">{email}</span>.
              Confirm your address, then sign in to start using Eva.
            </>
          }
        />
        <AuthOutlineLink href="/sign-in">Back to sign in</AuthOutlineLink>
      </>
    );
  }

  return (
    <>
      <AuthHeading title={copy.heading} subtitle={copy.subtitle} />
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        <AuthField
          id="email"
          label="Email"
          name="email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@yourcompany.co.uk"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
        <AuthField
          id="password"
          label="Password"
          name="password"
          type="password"
          autoComplete={mode === "sign-up" ? "new-password" : "current-password"}
          required
          minLength={6}
          placeholder={mode === "sign-up" ? "At least 6 characters" : "••••••••"}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          aside={
            mode === "sign-in" ? (
              <Link
                href="/reset-password"
                className="text-xs font-semibold text-link hover:text-link-hover"
              >
                Forgot your password?
              </Link>
            ) : undefined
          }
        />
        {error && <AuthError>{error}</AuthError>}
        <AuthSubmit pending={pending}>{pending ? copy.pending : copy.submit}</AuthSubmit>
      </form>
      <p className="text-center text-[13px] text-muted-foreground">
        {copy.switchPrompt}{" "}
        <Link href={copy.switchHref} className="font-semibold text-link hover:text-link-hover">
          {copy.switchLabel}
        </Link>
      </p>
    </>
  );
}
