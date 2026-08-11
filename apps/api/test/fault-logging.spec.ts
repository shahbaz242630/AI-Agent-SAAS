import { describe, expect, it } from "vitest";
import {
  answerForDatabaseFault,
  isUniqueViolationOn,
} from "../src/common/errors/database-fault.js";
import { describeFault, redactCredentials } from "../src/common/logging/fault-description.js";

/**
 * The two pure decisions behind the fault log (2026-08-11): what a thrown thing
 * becomes on its way to the log, and which database failures are not our bug.
 *
 * Both are unit-tested here rather than only through the filter because both
 * are the kind of rule that gets quietly widened later — a new `catch` that
 * forgets to redact, a new Prisma code added to the "not our fault" set on a
 * bad afternoon.
 */

describe("redactCredentials", () => {
  it("takes the password out of a datasource URL and leaves the host", () => {
    const redacted = redactCredentials(
      "Can't reach database server at postgresql://eva_app:sup3rs3cret@db.eu.example.com:5432/postgres",
    );

    expect(redacted).not.toContain("sup3rs3cret");
    expect(redacted).not.toContain("eva_app");
    expect(redacted).toContain("[redacted]");
    // "Which server" is the diagnostic half and stays.
    expect(redacted).toContain("db.eu.example.com:5432");
  });

  it("redacts every credentialled URL in one string, whatever the scheme", () => {
    const redacted = redactCredentials(
      "postgres://a:b@one.example.com and smtps://user:pw@mail.example.com failed",
    );

    expect(redacted).not.toContain(":b@");
    expect(redacted).not.toContain(":pw@");
    expect(redacted.match(/\[redacted\]/g)).toHaveLength(2);
  });

  /** ⚠️ A rule that redacted ordinary URLs would make every Graph failure
   *  unreadable, and someone would quietly delete it. */
  it("leaves an ordinary URL alone", () => {
    const url = "https://graph.microsoft.com/v1.0/me/sendMail";

    expect(redactCredentials(url)).toBe(url);
  });
});

describe("describeFault", () => {
  it("flattens a Prisma known error into cause, code and constraint", () => {
    const error = new Error("Unique constraint failed on the fields: (`email`)");
    error.name = "PrismaClientKnownRequestError";
    Object.assign(error, { code: "P2002", meta: { target: ["email"] } });

    const fault = describeFault(error);

    expect(fault.name).toBe("PrismaClientKnownRequestError");
    expect(fault.code).toBe("P2002");
    expect(fault.detail).toContain("email");
    expect(fault.stack).toBeTypeOf("string");
  });

  it("redacts the message AND the stack, because a driver prints the URL in both", () => {
    const error = new Error("connect to postgresql://eva:hunter2@db.example.com:5432 failed");
    error.stack = "Error: connect to postgresql://eva:hunter2@db.example.com:5432 failed\n  at x";

    const fault = describeFault(error);

    expect(JSON.stringify(fault)).not.toContain("hunter2");
    expect(fault.message).toContain("[redacted]");
    expect(fault.stack).toContain("[redacted]");
  });

  it("marks a clamped message rather than letting it merely stop", () => {
    const fault = describeFault(new Error("x".repeat(900)));

    expect(fault.message).toContain("[truncated]");
    expect(fault.message.length).toBeLessThan(600);
  });

  /**
   * ⚠️ NEVER THROWS. This runs inside the exception filter, the last thing
   * between a fault and the customer. An error thrown here would replace a
   * handled 500 with an unhandled one, and nothing would catch that.
   */
  it("survives a thrown value that is not an Error", () => {
    expect(describeFault("just a string").message).toBe("just a string");
    expect(describeFault(undefined).name).toBe("NonError");
    expect(describeFault({ nope: true }).message).toContain("nope");
  });

  it("survives a getter that throws and an object that cannot be stringified", () => {
    const error = new Error("boom");
    Object.defineProperty(error, "code", {
      get() {
        throw new Error("no");
      },
    });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    Object.assign(error, { meta: circular });

    const fault = describeFault(error);

    expect(fault.message).toBe("boom");
    expect(fault.code).toBeUndefined();
    expect(fault.detail).toBeTypeOf("string");
  });
});

describe("answerForDatabaseFault", () => {
  it.each(["P1001", "P1002", "P1008", "P1017"])("answers 503 for %s", (code) => {
    expect(answerForDatabaseFault(code)?.status).toBe(503);
  });

  /**
   * ⚠️ THE RESTRAINT TEST. Adding `P2002 → 409` here would be a one-line
   * "improvement" that reintroduces the 2026-08-11 defect: it says the caller
   * got it wrong, when the actual fault was a stale row of OURS, and it drops
   * the fault below the 5xx line that gets it reported. Whose fault a
   * constraint violation is depends on which constraint — which only the call
   * site knows.
   */
  it("claims nothing about a constraint violation, a missing row, or an unknown code", () => {
    expect(answerForDatabaseFault("P2002")).toBeNull();
    expect(answerForDatabaseFault("P2025")).toBeNull();
    expect(answerForDatabaseFault("ECONNREFUSED")).toBeNull();
    expect(answerForDatabaseFault(undefined)).toBeNull();
  });
});

/**
 * ⚠️ TWO SHAPES, AND THE SECOND ONE IS THE REAL ONE TODAY. The first version of
 * `isUniqueViolationOn` read `meta.target`, which every Prisma tutorial shows
 * and which our stack does not populate: Prisma 7 driving through a driver
 * adapter says "Unique constraint failed on the (not available)" and names the
 * index only inside the driver's own message. It matched nothing, and the
 * collision would have shipped as a 500 with a better comment above it. A test
 * against the real database caught it the same afternoon.
 *
 * Both shapes stay covered so that a Prisma upgrade cannot quietly break either
 * one.
 */
describe("isUniqueViolationOn", () => {
  const violation = (meta: unknown): Error => {
    const error = new Error("Unique constraint failed");
    error.name = "PrismaClientKnownRequestError";
    Object.assign(error, { code: "P2002", meta });
    return error;
  };

  it("reads the documented shape: meta.target as a column list", () => {
    expect(isUniqueViolationOn(violation({ target: ["email"] }), "email")).toBe(true);
    expect(isUniqueViolationOn(violation({ target: ["auth_user_id"] }), "email")).toBe(false);
  });

  it("reads the index name when the connector reports one", () => {
    expect(isUniqueViolationOn(violation({ target: "users_email_key" }), "email")).toBe(true);
  });

  /** The exact payload Prisma 7 + the driver adapter produced on 2026-08-11. */
  it("reads the driver's own message when Prisma leaves target unavailable", () => {
    const real = violation({
      modelName: "User",
      driverAdapterError: {
        name: "DriverAdapterError",
        cause: {
          originalCode: "23505",
          originalMessage: 'duplicate key value violates unique constraint "users_email_key"',
          kind: "UniqueConstraintViolation",
        },
      },
    });

    expect(isUniqueViolationOn(real, "email")).toBe(true);
    expect(isUniqueViolationOn(real, "auth_user_id")).toBe(false);
  });

  it("says no to anything that is not a unique violation", () => {
    const other = new Error("nope");
    Object.assign(other, { code: "P2025", meta: { target: ["email"] } });

    expect(isUniqueViolationOn(other, "email")).toBe(false);
    expect(isUniqueViolationOn(new Error("plain"), "email")).toBe(false);
    expect(isUniqueViolationOn("not an error", "email")).toBe(false);
    expect(isUniqueViolationOn(violation(undefined), "email")).toBe(false);
  });
});
