import { AUTH_PANELS, AuthError, AuthFrame } from "../auth-frame";
import { ResetForm } from "./reset-form";

/**
 * Anonymous-only: somebody who is signed in has no use for this, and the proxy
 * sends them to /app. The link that arrives by email lands on `/auth/confirm`,
 * which is deliberately NOT under this path — a prefix rule that bounced
 * signed-in visitors would bounce the recovery session too.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const failed = params.error === "link";

  return (
    <AuthFrame panel={AUTH_PANELS.resetPassword} back={{ href: "/sign-in", label: "Back" }}>
      {/* `/auth/confirm` sends people back here when a link has expired or has
          already been used. Saying so is the difference between "ask for
          another one" and "this product is broken". */}
      {failed && (
        <AuthError>
          That reset link has expired or has already been used. Ask for a new one below — links are
          good for one hour.
        </AuthError>
      )}
      <ResetForm />
    </AuthFrame>
  );
}
