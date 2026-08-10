import { type EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

/**
 * Where every link Supabase emails comes back to.
 *
 * ⚠️ THIS ROUTE IS THE WHOLE REASON "RESET PASSWORD" IS NOT JUST A SCREEN.
 * Without it the email's link has nowhere to land, and the customer who clicked
 * it is stranded holding a token no page will accept.
 *
 * ⚠️ IT HANDLES BOTH SHAPES ON PURPOSE, AND THAT IS NOT BELT-AND-BRACES.
 * Supabase's default recovery template sends `{{ .ConfirmationURL }}`, which
 * goes via Supabase's own verify endpoint and comes back with `?code=` — a PKCE
 * exchange that only works in **the same browser that asked for the reset**,
 * because the verifier lives in that browser's cookie. Someone who requests a
 * reset on their laptop and opens the email on their phone gets nothing. The
 * cross-device fix is a template change in the dashboard to
 * `?token_hash={{ .TokenHash }}&type=recovery`, which `verifyOtp` accepts from
 * anywhere. Supporting both means the flow works today on the default template
 * AND keeps working the moment the template is improved — with no code change
 * and no window where it is broken.
 *
 * A failure never explains itself in detail. "Expired or already used" covers
 * every real case, and the alternatives all amount to telling a stranger
 * something about a token they are holding.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;

  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const code = searchParams.get("code");

  /**
   * ⚠️ `next` IS A URL FROM AN EMAIL AND IS TREATED AS HOSTILE. Anything but a
   * single-slash-relative path is discarded: `//evil.example` is a
   * protocol-relative URL that browsers follow off-site, so an open redirect
   * would be one careless `startsWith("/")` away — on the one link a customer
   * is primed to click without looking.
   */
  const requested = searchParams.get("next") ?? "/app";
  const next = /^\/(?!\/)/.test(requested) ? requested : "/app";

  const supabase = await createClient();

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(next, origin));
  } else if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }

  // Recovery failures go back to the screen that can issue another link;
  // anything else (a confirmation link, say) belongs at sign-in.
  const failure =
    type === "recovery" || next === "/new-password"
      ? "/reset-password?error=link"
      : "/sign-in?error=link";
  return NextResponse.redirect(new URL(failure, origin));
}
