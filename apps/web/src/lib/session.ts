import { SESSION_IDLE_TIMEOUT_CODE } from "@eva/types";

/**
 * Where a signed-in visitor goes when the API refuses their session, and the
 * two answers are NOT interchangeable.
 *
 * ⚠️ `/sign-in` IS THE RIGHT DOOR FOR AN EXPIRED TOKEN AND A TRAP FOR AN IDLE
 * ONE. An expired token means Supabase has already stopped vouching for this
 * person, so the sign-in page renders and they sign in again. A session ended
 * for idleness is different in exactly the way that matters: Supabase still
 * considers the cookie perfectly valid, so the proxy sees a signed-in visitor on
 * an anonymous-only page and sends them to `/app` — which asks the API, is
 * refused again, and redirects to `/sign-in` again. A loop with no error message
 * and no way out but clearing cookies by hand.
 *
 * So an idle session is sent somewhere that can actually END it. The route
 * handler is the only place in the web app that can both clear the cookies and
 * redirect; a Server Component cannot write cookies at all.
 *
 * ⚠️ THE NARROW CASE THIS EXISTS FOR: the browser's own stamp is fresh while the
 * server's has gone stale. It takes the API being unreachable for two days while
 * somebody keeps a tab open — rare, and a loop nobody can escape is not a thing
 * to leave lying around because it is rare.
 */
export const IDLE_SIGN_OUT_PATH = "/auth/sign-out?reason=idle";

export function sessionFailureDestination(code: string | undefined): string {
  return code === SESSION_IDLE_TIMEOUT_CODE ? IDLE_SIGN_OUT_PATH : "/sign-in";
}
