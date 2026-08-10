import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "./env";

/**
 * Pages that require a signed-in user.
 *
 * ⚠️ `/new-password` IS IN HERE AND IT IS NOT A MISTAKE. A recovery link is
 * only a link until `/auth/confirm` turns it into a real session, and from that
 * moment the person holding it IS signed in — Supabase says so. Leaving this
 * route open would mean anybody could load a "choose a new password" form.
 */
const PROTECTED_PREFIXES = ["/app", "/change-password", "/new-password"];

/**
 * Auth pages, which are only for anonymous visitors.
 *
 * ⚠️ `/auth/confirm` IS DELIBERATELY ABSENT FROM BOTH LISTS. It is the landing
 * point for every link Supabase emails, and it has to work for a visitor in
 * either state — signed out on a new device, or already signed in on the one
 * they asked from. A rule that redirected it either way would eat the token
 * before the route could spend it.
 *
 * ⚠️ `/reset-password` IS ANONYMOUS-ONLY BUT `/new-password` IS NOT, which is
 * exactly why the second one is not a path underneath the first. Nesting it
 * would have made the recovery session bounce off the screen it was minted for.
 */
const AUTH_PAGE_PREFIXES = ["/sign-in", "/sign-up", "/signed-out", "/reset-password"];

/** Does `pathname` sit at or below `prefix`, on a segment boundary? */
function matches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/**
 * Which of the three kinds of route this is — extracted so it can be TESTED.
 *
 * ⚠️ THE BREAKABLE DECISION IN THIS FILE, moved somewhere a test can reach it.
 * Getting it wrong does not look wrong: a route in the anonymous-only list by
 * mistake still renders perfectly for the signed-out visitor who is developing
 * it, and only fails for the person holding a real recovery session. The rule
 * is data and a boundary check; `updateSession` below just acts on the answer.
 */
export type RouteKind = "protected" | "anonymous-only" | "open";

export function routeKind(pathname: string): RouteKind {
  if (PROTECTED_PREFIXES.some((prefix) => matches(pathname, prefix))) return "protected";
  if (AUTH_PAGE_PREFIXES.some((prefix) => matches(pathname, prefix))) return "anonymous-only";
  return "open";
}

/**
 * Refreshes the Supabase session on every request (BRD 9.7 — short-lived
 * tokens with refresh rotation in HTTP-only cookies) and enforces the
 * sign-in boundary for the journey pages.
 *
 * Follows the current @supabase/ssr Next.js pattern: refreshed cookies are
 * written to both the request (so Server Components see the fresh token) and
 * the response (so the browser stores it).
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const { url, anonKey } = getSupabaseEnv();

  let supabaseResponse = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options);
        });
      },
    },
  });

  // Do not run code between createServerClient and getClaims() — per the
  // @supabase/ssr docs, getClaims validates the JWT and triggers the refresh.
  const { data } = await supabase.auth.getClaims();
  const user = data?.claims;
  const { pathname } = request.nextUrl;

  const kind = routeKind(pathname);

  if (!user && kind === "protected") {
    const redirectUrl = request.nextUrl.clone();
    // A dead recovery link is the one case where sign-in is the wrong door:
    // this person came here precisely because they cannot use it.
    const recovery = matches(pathname, "/new-password");
    redirectUrl.pathname = recovery ? "/reset-password" : "/sign-in";
    redirectUrl.search = recovery ? "?error=link" : "";
    return NextResponse.redirect(redirectUrl);
  }

  if (user && kind === "anonymous-only") {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/app";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}
