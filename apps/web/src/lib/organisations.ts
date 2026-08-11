import { redirect } from "next/navigation";
import { ApiError, apiFetch } from "./api";

/**
 * The caller's organisations — the first thing eleven of the twelve signed-in
 * screens ask for, and until 2026-08-11 the one call none of them guarded.
 *
 * ⚠️ FOUND BY BROWSING, NOT BY READING. The founder opened the invoices screen
 * while their local record was in the state that broke production this
 * morning. The API answered 409 — correctly, with an explanation written for a
 * human — and the screen turned it into a raw Next.js crash page. The message
 * we had carefully worded never appeared anywhere.
 *
 * ⚠️ A 401 IS THE COMMON CASE AND IS NOT AN ERROR. A session expires, a token
 * is revoked — the answer is "sign in again", not a stack trace. The dashboard
 * always knew that and redirected; the other eleven screens threw. That gap got
 * WIDER on the day it was found: password changes now revoke other sessions on
 * purpose (the "unexpired session" fix), so a customer who changes their
 * password on their phone and returns to a laptop tab is exactly the person who
 * would have met a crash page.
 *
 * Everything else is rethrown, deliberately, for `app/app/error.tsx` — one
 * screen that explains the failure and shows the reference, rather than eleven
 * copies of a try/catch that will drift apart.
 */
export async function fetchOrganisations<T>(accessToken: string): Promise<T[]> {
  try {
    return (await (await apiFetch("/organisations", accessToken)).json()) as T[];
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect("/sign-in");
    throw error;
  }
}
