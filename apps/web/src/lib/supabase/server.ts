import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { getSupabaseEnv } from "./env";

/**
 * Supabase client for Server Components, Server Actions and Route Handlers.
 * Follows the current @supabase/ssr Next.js pattern (cookie getAll/setAll).
 *
 * Server Components cannot write cookies, so `setAll` failures there are
 * ignored — the proxy (src/proxy.ts) refreshes the session on every request
 * and is the only place cookies rotate outside Server Actions.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const { url, anonKey } = getSupabaseEnv();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // Called from a Server Component render — cookie writes are only
          // allowed in Server Actions/Route Handlers. Safe to ignore because
          // the proxy keeps the session fresh.
        }
      },
    },
  });
}
