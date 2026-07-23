import { createBrowserClient } from "@supabase/ssr";
import { getSupabaseEnv } from "./env";

/**
 * Supabase client for Client Components (runs in the browser). Sessions live
 * in HTTP-only cookies written by the server (BRD 9.7); the browser client
 * only reads them to call Supabase Auth.
 */
export function createClient() {
  const { url, anonKey } = getSupabaseEnv();
  return createBrowserClient(url, anonKey);
}
