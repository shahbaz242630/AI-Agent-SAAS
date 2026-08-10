import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AUTH_PANELS, AuthFrame } from "../auth-frame";
import { PasswordForm } from "../password-form";

/**
 * Where a recovery link lands, after `/auth/confirm` has turned its token into
 * a session.
 *
 * ⚠️ NO SESSION MEANS THE LINK DID NOT WORK, and the honest place to send
 * somebody is the screen that can issue another one — not sign-in, where they
 * would be asked for the password they came here because they do not have.
 */
export default async function NewPasswordPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const email = typeof data?.claims?.email === "string" ? data.claims.email : null;
  if (!email) redirect("/reset-password?error=link");

  return (
    <AuthFrame panel={AUTH_PANELS.resetPassword}>
      <PasswordForm mode="new" email={email} />
    </AuthFrame>
  );
}
