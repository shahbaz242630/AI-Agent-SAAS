export interface SupabaseEnv {
  url: string;
  anonKey: string;
}

/**
 * Reads the public Supabase configuration shared by the browser and server
 * clients. Both values are publishable by design (BRD 9.10) — the anon key
 * only ever identifies the project; the API enforces auth via the user's JWT.
 *
 * Validated lazily (inside the client factories) rather than at module load
 * so `next build` succeeds without env vars; misconfiguration fails fast with
 * a clear message on the first request that touches Supabase.
 */
export function getSupabaseEnv(): SupabaseEnv {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL is not set. Add it to your environment (see .env.example).",
    );
  }
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_ANON_KEY is not set. Add it to your environment (see .env.example).",
    );
  }
  return { url, anonKey };
}
