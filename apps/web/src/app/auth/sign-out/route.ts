import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "@/lib/supabase/env";
import { ACTIVITY_COOKIE } from "@/lib/supabase/proxy";

/**
 * Ends a session and lands somewhere that explains why.
 *
 * ⚠️ A ROUTE HANDLER BECAUSE NOTHING ELSE CAN DO THIS. Clearing a session means
 * writing cookies, and a Server Component is forbidden from writing them — so a
 * page that discovers the API has ended its session can only redirect, and the
 * one place it would naturally redirect to (`/sign-in`) bounces it straight back
 * while the Supabase cookie is still valid. See `lib/session.ts` for the loop
 * this breaks.
 *
 * ⚠️ THE COOKIES ARE WRITTEN ONTO THE RESPONSE EXPLICITLY, not through
 * `next/headers`. The redirect is constructed first and `setAll` writes onto it
 * directly, so the cleared cookies cannot be left behind on a response that was
 * replaced — the same pattern the proxy uses, for the same reason.
 *
 * ⚠️ SCOPE "local". A global sign-out ends this person's sessions on every
 * device they own; being idle in one browser is not a reason to throw them out
 * of the laptop they are working on.
 *
 * `reason` decides copy and nothing else, so a visitor typing it into the
 * address bar changes only which sentence they read on the way out.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { url: supabaseUrl, anonKey } = getSupabaseEnv();

  const redirectUrl = request.nextUrl.clone();
  redirectUrl.pathname = "/signed-out";
  redirectUrl.search = request.nextUrl.searchParams.get("reason") === "idle" ? "?reason=idle" : "";
  const response = NextResponse.redirect(redirectUrl);

  const supabase = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) => {
          response.cookies.set(name, value, options);
        });
      },
    },
  });

  await supabase.auth.signOut({ scope: "local" });
  response.cookies.delete(ACTIVITY_COOKIE);
  return response;
}
