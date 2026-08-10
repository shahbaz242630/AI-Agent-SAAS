import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { AUTH_PANELS, AuthFrame } from "../auth-frame";
import { PasswordForm } from "../password-form";

/**
 * Signed-in password change. The proxy guards the route; this reads the address
 * the form needs to re-authenticate with, and refuses rather than guesses if it
 * cannot get one.
 */
export default async function ChangePasswordPage() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const email = typeof data?.claims.email === "string" ? data.claims.email : null;
  if (!email) redirect("/sign-in");

  return (
    <AuthFrame panel={AUTH_PANELS.changePassword} back={{ href: "/app", label: "Back" }}>
      <PasswordForm mode="change" email={email} />
    </AuthFrame>
  );
}
