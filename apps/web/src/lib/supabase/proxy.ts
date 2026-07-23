import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabaseEnv } from "./env";

/** Journey pages require a signed-in user. */
const PROTECTED_PREFIX = "/app";
/** Auth pages are only for anonymous visitors. */
const AUTH_PAGE_PREFIXES = ["/sign-in", "/sign-up"];

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

  if (!user && pathname.startsWith(PROTECTED_PREFIX)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/sign-in";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  if (user && AUTH_PAGE_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/app";
    redirectUrl.search = "";
    return NextResponse.redirect(redirectUrl);
  }

  return supabaseResponse;
}
