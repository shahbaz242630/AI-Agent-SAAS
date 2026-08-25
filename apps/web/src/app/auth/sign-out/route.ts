import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { publicUrl } from "@/lib/public-origin";
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

  /**
   * ⚠️ `publicUrl`, NOT `request.nextUrl.clone()`, AND THIS IS THE 2026-08-25
   * DEFECT. This route sent every idled customer to
   * `https://localhost:8080/signed-out?reason=idle` — https, plausible, and a
   * machine that does not exist. Measured on production the same day:
   *
   *     /auth/sign-out?reason=idle -> https://localhost:8080/signed-out?...
   *     /app  (middleware)         -> /sign-in
   *
   * ⚠️ THE DIFFERENCE BETWEEN THOSE TWO LINES IS THE WHOLE TRAP. Middleware
   * answers a cloned `nextUrl` with a RELATIVE `Location`, so no host is
   * involved; a ROUTE HANDLER resolves the same expression against the
   * container's own listening address and emits it absolute. `public-origin.ts`
   * was written for exactly this on 2026-08-11 and fixed `/auth/confirm`; this
   * handler arrived in #88 afterwards and reintroduced the pattern the helper
   * exists to prevent.
   *
   * The guard in `public-origin.spec.ts` exempted `nextUrl.clone()` on the
   * strength of the middleware measurement, which is why nothing went red.
   * That exemption is now scoped to middleware only.
   */
  const reason = request.nextUrl.searchParams.get("reason") === "idle" ? "?reason=idle" : "";
  const response = NextResponse.redirect(publicUrl(`/signed-out${reason}`));

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
