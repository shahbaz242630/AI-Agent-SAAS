/**
 * Where Eva actually lives, as far as anything the SERVER builds is concerned.
 *
 * ⚠️ THIS EXISTS BECAUSE THE CONFIRMATION AND RESET LINKS LANDED ON
 * `https://localhost:8080`. Found by the founder clicking a real reset email on
 * production, 2026-08-11. `/auth/confirm` built its onward redirect from
 * `request.nextUrl.origin`, which behind Railway's proxy is the container's own
 * listening address — the scheme comes from `x-forwarded-proto` and the host
 * from the socket, giving a URL that is https, plausible, and points at a
 * machine that does not exist. The token was spent correctly and the customer
 * was thrown off a cliff on the last hop.
 *
 * ⚠️ AND THE OBVIOUS FIX IS THE DANGEROUS ONE. Reading `x-forwarded-host` (or
 * `Host`) would work today and would be a password-reset-poisoning hole
 * tomorrow: a request carrying a forged host makes OUR email carry a link to
 * SOMEBODY ELSE'S domain, and the customer — primed to click — hands over the
 * token. It is the textbook attack, and `x-forwarded-host` is the textbook
 * bypass once `Host` is validated (OWASP WSTG-INPV-17; PortSwigger, "HTTP Host
 * header attacks"). Their guidance is what this file does: when you need an
 * absolute URL, take the domain from CONFIGURATION and never from the request.
 *
 * Supabase's redirect allowlist is the independent second lock — a link can
 * only come back to an origin the project has been told to permit — and this
 * value must be one of the entries on it.
 */

/** No trailing slash, no path, no query: `https://host[:port]` and nothing more. */
function normalise(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  // A configured origin carrying a path would silently prefix every emailed
  // link; better to reject it than to send half-working links for a week.
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.hash !== "") return null;
  return parsed.origin;
}

/**
 * The configured origin, or `null` when it is missing or malformed.
 *
 * Separated from `publicOrigin()` so the boot check can report the problem
 * without throwing inside a request, and so a test can state the rule.
 */
export function configuredOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  const raw = env.WEB_PUBLIC_ORIGIN?.trim();
  if (!raw) return null;
  return normalise(raw);
}

export const MISSING_ORIGIN_MESSAGE =
  "WEB_PUBLIC_ORIGIN is not set to a valid origin (e.g. https://eva.example.com). " +
  "Every link Eva emails is built from it, and it must also appear in Supabase's " +
  "redirect allowlist. See .env.example.";

/**
 * ⚠️ THROWS RATHER THAN GUESSING. The 2026-08-11 defect was an ABSENT value
 * falling back to a plausible wrong one, exactly like #79 the day before, where
 * a missing redirect option fell back to the marketing page. A fallback here —
 * to the request's host, to a hard-coded domain, to anything — recreates the
 * same class of bug with better manners. If this is unset the deploy should
 * stop; `instrumentation.ts` checks it at boot so it stops there rather than in
 * front of a customer.
 */
export function publicOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const origin = configuredOrigin(env);
  if (!origin) throw new Error(MISSING_ORIGIN_MESSAGE);
  return origin;
}

/** An absolute URL on our own origin, for the one place that needs one: the
 *  `Location` of a redirect out of a route handler. */
export function publicUrl(
  path: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  return new URL(path, publicOrigin(env)).toString();
}
