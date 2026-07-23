/**
 * Server-side helpers for calling the Eva API with the caller's Supabase
 * access token. The API validates the JWT against the project JWKS on every
 * request (global guard, Slice 0.3) — the web app only ever forwards the
 * user's token, never a service key.
 */

export class ApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
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

  if (response.status === 401) {
    throw new ApiError("Your session has expired. Please sign in again.", 401);
  }
  if (!response.ok) {
    throw new ApiError(
      `The Eva API returned an unexpected error (${response.status}). Please try again.`,
      response.status,
    );
  }
  return response;
}
