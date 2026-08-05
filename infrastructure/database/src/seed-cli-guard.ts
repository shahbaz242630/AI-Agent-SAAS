/**
 * The local-only guard for the demo book.
 *
 * ⚠️ IN ITS OWN FILE ON PURPOSE. `seed-cli.ts` is a script with top-level
 * `await` — importing it RUNS it. A guard that cannot be imported cannot be
 * tested, and an untested guard is a comment.
 */

/**
 * Is this connection string pointing at a database on this machine?
 *
 * ⚠️ THIS IS A SAFETY GUARD, NOT A CONVENIENCE. The demo book is invented
 * companies with invented email addresses. Cloud Supabase holds a real
 * organisation with real invoices, and once slice 1.7 can send, a fake debtor
 * sitting in a real database is a real chasing email to a real address.
 * Fifteen fake invoices mixed in with real ones is also not something anyone
 * unpicks cleanly by hand afterwards.
 *
 * It fails CLOSED: anything it cannot parse, or does not positively recognise
 * as this machine, is treated as remote. A guard that waves through what it
 * does not recognise is not a guard.
 *
 * The comparison is against the parsed HOSTNAME, never a substring of the URL —
 * `localhost.evil.example` contains "localhost" and is not this machine.
 */
export function isLocalDatabase(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Bracketed IPv6 (`[::1]`) keeps its brackets in `URL.hostname`.
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  return bare === "localhost" || bare === "127.0.0.1" || bare === "::1";
}
