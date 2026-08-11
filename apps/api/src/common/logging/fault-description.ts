/**
 * Flattens anything that was thrown into a line an operator can act on.
 *
 * ⚠️ THIS EXISTS BECAUSE A 500 ONCE EXPLAINED NOTHING. On 2026-08-11 every
 * request to `/organisations` failed for the only real account on production —
 * the dashboard was dead for the founder — and the deploy log's entire account
 * of it was `request errored`. The cause (a unique-constraint collision on
 * `users.email`, from an auth account deleted and recreated) was reconstructed
 * an hour later by reading the database directly. The fault WAS captured, to
 * Sentry; the stream an engineer actually greps said nothing at all.
 *
 * ⚠️ THE ERROR IS FLATTENED HERE RATHER THAN HANDED STRAIGHT TO PINO. pino's
 * own error serializer emits `message` and `stack` verbatim, and a driver
 * failure's text can carry a connection string — the one thing the handoff says
 * must never be printed anywhere, on any day, for any reason. Redacting before
 * the value leaves this function means there is one place to test it and no way
 * for a later call site to forget.
 */

/** Long enough for a real driver message, short enough that a runaway string
 *  cannot become the log. */
const MAX_MESSAGE_LENGTH = 500;
const MAX_DETAIL_LENGTH = 300;
const MAX_STACK_LENGTH = 4_000;

/**
 * `scheme://user:secret@host` — the shape of every credential-bearing URL we
 * hold (Postgres, an SMTP relay, a queue). BOTH halves are required before this
 * matches, so an ordinary `https://graph.microsoft.com/v1.0/me` is left intact
 * and stays greppable.
 */
const CREDENTIALLED_URL = /\b([a-z][a-z0-9+.-]*):\/\/[^\s/@:]+:[^\s/@]+@/gi;

/** Replaces the credentials in any URL with a marker, leaving the host visible
 *  — "which server" is the diagnostic half, "as whom" is the secret half. */
export function redactCredentials(text: string): string {
  return text.replace(CREDENTIALLED_URL, "$1://[redacted]@");
}

export interface FaultDescription {
  /** `PrismaClientKnownRequestError`, `TypeError`, … */
  name: string;
  message: string;
  /** Prisma's `P2002`, Node's `ECONNREFUSED` — the field that names the failure
   *  rather than describing it. */
  code?: string;
  /**
   * Prisma's `meta`, which names WHICH constraint or column failed
   * (`{"target":["email"]}`).
   *
   * ⚠️ THIS IS THE FIELD THAT WOULD HAVE SAVED THE HOUR. "A unique index
   * rejected the row" and "the unique index on users.email rejected the row"
   * are an hour apart in diagnosis. Prisma puts column and constraint NAMES in
   * `meta`, never the row's values, so it carries no customer data — but it is
   * clamped and redacted with everything else rather than trusted to stay that
   * way.
   */
  detail?: string;
  stack?: string;
}

/**
 * ⚠️ NEVER THROWS. This runs inside the exception filter — the last thing
 * standing between a fault and the customer — so a getter that throws, a
 * circular object or a null-prototype value must all come back as a string
 * rather than replacing one fault with another that nothing catches.
 */
export function describeFault(thrown: unknown): FaultDescription {
  if (!(thrown instanceof Error)) {
    return {
      name: "NonError",
      message: clamp(redactCredentials(text(thrown)), MAX_MESSAGE_LENGTH),
    };
  }

  const code = propertyOf(thrown, "code");
  const detail = propertyOf(thrown, "meta");

  return {
    name: typeof thrown.name === "string" && thrown.name ? thrown.name : "Error",
    message: clamp(redactCredentials(text(thrown.message)), MAX_MESSAGE_LENGTH),
    ...(code === undefined
      ? {}
      : { code: clamp(redactCredentials(text(code)), MAX_DETAIL_LENGTH) }),
    ...(detail === undefined
      ? {}
      : { detail: clamp(redactCredentials(text(detail)), MAX_DETAIL_LENGTH) }),
    ...(typeof thrown.stack === "string"
      ? { stack: clamp(redactCredentials(thrown.stack), MAX_STACK_LENGTH) }
      : {}),
  };
}

/** A property read that survives a throwing getter or an exotic prototype. */
function propertyOf(error: Error, key: "code" | "meta"): unknown {
  try {
    const value = (error as unknown as Record<string, unknown>)[key];
    return value === undefined || value === null ? undefined : value;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    try {
      return String(value);
    } catch {
      return "[unprintable]";
    }
  }
}

/** Truncation is marked, because a message that merely stops looks like a
 *  message that was empty. */
function clamp(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}… [truncated]`;
}
