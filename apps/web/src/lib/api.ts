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

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
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
  } catch {
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
    throw new ApiError(
      detail?.message ??
        `The Eva API returned an unexpected error (${response.status}). Please try again.`,
      response.status,
      detail?.code,
    );
  }
  return response;
}
