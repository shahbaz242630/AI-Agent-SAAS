import { stdSerializers } from "pino";

/**
 * Pino redaction config (BRD 14 — no tokens, credentials or personal contact
 * details in logs). fast-redact paths support single-level `*` wildcards, so
 * each sensitive key is listed at every nesting depth the API logs at
 * (top-level through three levels: e.g. `req.headers.authorization`,
 * `req.body.email`).
 */

const SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "email",
  "phone",
  "phoneNumber",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "secret",
  "apiKey",
] as const;

export const LOG_REDACT_PATHS: string[] = SENSITIVE_KEYS.flatMap((key) => [
  key,
  `*.${key}`,
  `*.*.${key}`,
  `*.*.*.${key}`,
]);

/**
 * Routes whose QUERY STRING carries credentials. The Microsoft OAuth callback
 * receives `code` (single-use authorization code) + `state` (signed JWT) as
 * query parameters — BRD 14 keeps both out of the logs.
 *
 * `redact` alone cannot do this: fast-redact matches object keys, and the code
 * also lives inside the `req.url` STRING. And `autoLogging.ignore` is not
 * enough either — it only drops the automatic request-completion line, while
 * nestjs-pino attaches the serialized `req` to EVERY log line emitted during
 * that request (so any info/warn/error the handler writes would carry it).
 * Sanitizing at serialization time covers all of them.
 */
const CREDENTIAL_QUERY_PATHS = new Set(["/integrations/microsoft/callback"]);

/**
 * pino `serializers.req` — the standard shape, with the query string dropped
 * on credential-bearing routes. The path is kept so the route is still
 * greppable in Railway logs.
 */
export function serializeRequest(
  request: Parameters<typeof stdSerializers.req>[0],
): Record<string, unknown> {
  // Record<…> rather than the inferred type: pino's SerializedRequest cannot
  // be named without reaching into pino-std-serializers' internals (TS2742).
  const serialized = stdSerializers.req(request) as unknown as Record<string, unknown>;
  const url = typeof serialized.url === "string" ? serialized.url : "";
  const path = url.split("?")[0] ?? "";
  if (!CREDENTIAL_QUERY_PATHS.has(path)) return serialized;
  return { ...serialized, url: path, query: "[Redacted]" };
}
