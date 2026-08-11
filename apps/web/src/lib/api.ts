/**
 * Server-side helpers for calling the Eva API with the caller's Supabase
 * access token. The API validates the JWT against the project JWKS on every
 * request (global guard, Slice 0.3) — the web app only ever forwards the
 * user's token, never a service key.
 */

export class ApiError extends Error {
  readonly status?: number;
  /** Machine-readable code from the API body, when it sends one (e.g.
   *  `module_not_entitled` on a 402), so callers can branch on the situation
   *  rather than pattern-matching English. */
  readonly code?: string;
  /**
   * The API's reference for this exact failure — the same string on its fault
   * log line (`x-correlation-id`, and in the body of every 5xx since
   * 2026-08-11).
   *
   * ⚠️ CARRIED SO A SCREEN CAN PRINT IT. On 2026-08-11 the founder's dashboard
   * answered "unexpected error (500)" for two hours and there was no way to get
   * from that sentence to the request that caused it; the cause was eventually
   * found by reading the database. A reference on the screen turns a screenshot
   * into a log query.
   */
  readonly correlationId?: string;

  constructor(message: string, status?: number, code?: string, correlationId?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.correlationId = correlationId;
  }
}

/** Longer than any message we write; short enough that a runaway body cannot
 *  become the page. */
const MAX_API_MESSAGE_LENGTH = 300;

/**
 * The API's message, when there is one worth showing.
 *
 * Only for 4xx, and that boundary is the API's own contract rather than a guess:
 * `GlobalExceptionFilter` passes client-error messages through as "safe by
 * construction" and rewrites everything >= 500 to a bare "Internal server
 * error". So 4xx bodies are deliberate, user-facing copy; 5xx bodies are worth
 * nothing to a customer and are exactly where internals would leak.
 */
async function readApiError(
  response: Response,
): Promise<{ message?: string; code?: string } | null> {
  if (response.status >= 500) return null;
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    // Empty body, HTML from a proxy, truncated JSON — all fall back to our copy.
    return null;
  }
  if (typeof body !== "object" || body === null) return null;
  const { message, code } = body as { message?: unknown; code?: unknown };
  // Nest sends a string; its validation pipe sends an array of strings.
  const text = Array.isArray(message)
    ? message.filter((part): part is string => typeof part === "string").join(", ")
    : typeof message === "string"
      ? message
      : "";
  return {
    ...(text.trim() ? { message: text.trim().slice(0, MAX_API_MESSAGE_LENGTH) } : {}),
    ...(typeof code === "string" && code ? { code } : {}),
  };
}

export function getApiBaseUrl(): string {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL;
  if (!baseUrl) {
    throw new Error(
      "NEXT_PUBLIC_API_URL is not set. Add it to your environment (see .env.example).",
    );
  }
  return baseUrl;
}

/**
 * Authenticated fetch against the Eva API. Throws an ApiError with a friendly
 * English message for unreachable hosts and non-2xx responses; callers map
 * status 401 to a sign-in redirect.
 */
export async function apiFetch(
  path: string,
  accessToken: string,
  init?: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${getApiBaseUrl()}${path}`, {
      ...init,
      headers: { ...init?.headers, Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
  } catch (error) {
    // ⚠️ THIS BRANCH USED TO DISCARD THE CAUSE ENTIRELY. "We couldn't reach the
    // Eva API" is the right thing to SHOW and a terrible thing to be left with:
    // DNS failure, TLS failure, the API asleep and a cold start timing out all
    // read identically from the outside. The customer keeps the friendly line;
    // the log keeps the reason.
    console.error(
      `[eva] api unreachable ${JSON.stringify({
        path,
        reason: error instanceof Error ? error.message : String(error),
      })}`,
    );
    throw new ApiError("We couldn't reach the Eva API. Please try again in a moment.");
  }

  // 401 keeps our own copy: the API says "Unauthorized", which tells the user
  // nothing about what to do, and "sign in again" is always the right advice.
  if (response.status === 401) {
    throw new ApiError("Your session has expired. Please sign in again.", 401);
  }
  if (!response.ok) {
    // Defect F4: this used to build a message from the status code alone and
    // discard the body, so "Microsoft authorisation expired — reconnect the
    // mailbox" reached the user as "unexpected error (400). Please try again."
    // — the wrong advice, and louder than the correct advice beside it.
    const detail = await readApiError(response);
    const correlationId = response.headers.get("x-correlation-id") ?? undefined;

    /**
     * ⚠️ THE WEB SERVER SAYS SO TOO, and this is the second half of the
     * 2026-08-11 lesson. The API logged nothing; the web app, which knew
     * perfectly well that `/organisations` had just answered 500, also logged
     * nothing and rendered "Something went wrong". Two services watched the
     * same failure in silence. One line here means Railway's web logs name the
     * call and the reference, even on a day when the API's own logs are the
     * thing that is broken.
     *
     * 5xx only: a 401 on an expired session and a 402 on an unheld module are
     * both routine, and a log that fills with them is a log nobody reads.
     */
    if (response.status >= 500) {
      console.error(
        `[eva] api call failed ${JSON.stringify({
          path,
          status: response.status,
          correlationId: correlationId ?? null,
        })}`,
      );
    }

    throw new ApiError(
      detail?.message ??
        `The Eva API returned an unexpected error (${response.status}). Please try again.`,
      response.status,
      detail?.code,
      correlationId,
    );
  }
  return response;
}
