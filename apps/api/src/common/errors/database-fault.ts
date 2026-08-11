import { HttpStatus } from "@nestjs/common";

/**
 * The handful of database failures that are NOT a bug in our code, and the
 * honest answer for each.
 *
 * ⚠️ DELIBERATELY ONLY THE CONNECTIVITY CODES, AND THAT RESTRAINT IS THE POINT.
 * It is tempting to map every Prisma code here — a unique violation to 409, a
 * missing row to 404 — and it would be wrong. `P2002` says "a unique index
 * rejected this row"; whether that is the CALLER's fault or OURS depends
 * entirely on which index, and on 2026-08-11 it was ours: a stale `users.email`
 * row left behind by a deleted auth account. A blanket 409 would have told the
 * founder they had done something wrong while the defect sat in our data, and
 * would have dropped the fault below the 5xx line that gets it reported.
 *
 * Meaning belongs at the call site that knows it — see
 * `UsersService.resolveOrProvision`, which names its one collision explicitly.
 * Everything unclaimed stays a 500 we are told about. A 500 we hear about beats
 * a 409 that lies.
 *
 * ⚠️ THE MESSAGES ARE LITERALS AND MUST STAY LITERALS. The exception filter
 * publishes an HttpException's message to the client, so a message built from a
 * caught error would hand a customer the connection string that
 * `redactCredentials` exists to keep out of the logs.
 */

/**
 * P1001 can't reach the server · P1002 reached it, timed out ·
 * P1008 operation timed out · P1017 the server closed the connection.
 *
 * All four mean the same thing to a customer: the database is not answering
 * right now, nothing they typed is wrong, and trying again is the correct
 * response. 503 says exactly that, and says it to proxies and retry logic too.
 */
const DATABASE_UNAVAILABLE = new Set(["P1001", "P1002", "P1008", "P1017"]);

export interface DatabaseFaultAnswer {
  status: number;
  message: string;
}

/** The answer for a database fault we recognise, or `null` — which means 500,
 *  logged and reported, because we do not yet understand it. */
export function answerForDatabaseFault(code: string | undefined): DatabaseFaultAnswer | null {
  if (code === undefined || !DATABASE_UNAVAILABLE.has(code)) return null;
  return {
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message: "Eva can't reach its database just now. Nothing is lost — please try again shortly.",
  };
}

/**
 * Did this failure come from a unique index on `column`?
 *
 * ⚠️ THE CONSTRAINT IS THE ARBITER, NOT A LOOK-BEFORE-YOU-LEAP QUERY. Checking
 * "is this email taken?" before inserting is wrong twice over: two concurrent
 * first sign-ins would both see "no" and one would still fail, and under RLS
 * the checking query cannot even see the row — the caller's own identity is the
 * only one in scope. The database already knows; this reads its answer.
 *
 * Duck-typed rather than `instanceof PrismaClientKnownRequestError` so this
 * file stays free of Prisma's runtime, and so a getter that throws or a driver
 * that reports `target` as a bare string cannot turn a handled conflict into an
 * unhandled crash.
 */
export function isUniqueViolationOn(error: unknown, column: string): boolean {
  if (!(error instanceof Error)) return false;
  try {
    const { code, meta } = error as unknown as { code?: unknown; meta?: unknown };
    if (code !== "P2002") return false;
    const detail = (meta ?? {}) as Record<string, unknown>;

    const target = detail.target;
    if (Array.isArray(target)) return target.includes(column);
    // Some connectors report the index name (`users_email_key`) rather than the
    // column list, so the column name is looked for inside it.
    if (typeof target === "string") return target.includes(column);

    return driverConstraintText(detail).includes(column);
  } catch {
    return false;
  }
}

/**
 * ⚠️ PRISMA 7 + A DRIVER ADAPTER DOES NOT FILL IN `meta.target`. Its own
 * message reads "Unique constraint failed on the (not available)", and the only
 * place the constraint is actually named is the driver's original text —
 * `duplicate key value violates unique constraint "users_email_key"`.
 *
 * Found by a test on 2026-08-11: the first version of this file read `target`
 * alone, was perfectly reasonable, and matched nothing at all — the collision
 * would have gone on being a 500 with a nicer comment above it. If a Prisma
 * upgrade starts populating `target` again, the branch above takes over and
 * this stays as the fallback; both shapes are covered by
 * `test/fault-logging.spec.ts`.
 */
function driverConstraintText(meta: Record<string, unknown>): string {
  const adapter = meta.driverAdapterError;
  if (typeof adapter !== "object" || adapter === null) return "";
  const cause = (adapter as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return "";
  const message = (cause as { originalMessage?: unknown }).originalMessage;
  return typeof message === "string" ? message : "";
}
