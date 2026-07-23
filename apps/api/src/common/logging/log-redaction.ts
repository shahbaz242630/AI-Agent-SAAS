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
