import {
  BadGatewayException,
  BadRequestException,
  Controller,
  Get,
  Req,
  type INestApplication,
} from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import type { Request } from "express";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter.js";
import { ERROR_REPORTER } from "../src/common/monitoring/error-reporter.js";
import { FAULT_LOG } from "../src/common/monitoring/fault-log.js";
import { createTestApp } from "./support.js";

/**
 * Global exception filter (BRD 14, Slice 0.4): clients get a sanitized error
 * body — never a stack trace, never internals — while 5xx faults are reported
 * to the error reporter (Sentry) for the operators.
 */

@Controller("boom")
class BoomController {
  @Get("error")
  throwError(): never {
    throw new Error("database password: hunter2");
  }

  @Get("bad")
  throwBadRequest(): never {
    throw new BadRequestException("name is required");
  }

  @Get("upstream")
  throwBadGateway(): never {
    throw new BadGatewayException("Microsoft Graph could not send the test email");
  }

  @Get("prisma-ish")
  throwNonHttpAtRuntime(): never {
    // Stands in for a Prisma/driver failure: NOT an HttpException, so it is
    // the class of error whose text may carry connection strings and internals.
    const error = new Error("connect ECONNREFUSED 10.0.0.5:5432 user=eva_app");
    error.name = "PrismaClientInitializationError";
    throw error;
  }

  /** The exact shape of the fault that killed the dashboard on 2026-08-11. */
  @Get("collision")
  throwUniqueViolation(@Req() request: Request): never {
    // The guard would have run before the service did, so the request carries
    // the account this happened to.
    //
    // ⚠️ A DELIBERATELY FAKE ID. The first draft used the real auth id from the
    // 2026-08-11 outage; gitleaks flagged it, and it was right to — this repo
    // is public, and pasting a live identifier into a fixture because it is
    // "only an id" is how identifiers end up somewhere they were never meant
    // to be. Low-entropy on purpose, matching the demo fixtures.
    (request as { authUser?: unknown }).authUser = {
      authUserId: "00000000-0000-4000-8000-0000000000a1",
      email: "someone@example.com",
    };
    const error = new Error("Unique constraint failed on the fields: (`email`)");
    error.name = "PrismaClientKnownRequestError";
    Object.assign(error, { code: "P2002", meta: { target: ["email"] } });
    throw error;
  }

  @Get("db-down")
  throwDatabaseUnreachable(): never {
    const error = new Error(
      "Can't reach database server at db.example.com:5432 " +
        "(postgresql://eva_app:sup3rs3cret@db.example.com:5432/postgres)",
    );
    error.name = "PrismaClientInitializationError";
    Object.assign(error, { code: "P1001" });
    throw error;
  }
}

describe("GlobalExceptionFilter", () => {
  let app: INestApplication;
  const captureException = vi.fn();
  const recordFault = vi.fn();

  /** The single entry written for the request just made. */
  const loggedFault = (): Record<string, unknown> => {
    expect(recordFault).toHaveBeenCalledOnce();
    return recordFault.mock.calls[0]?.[0] as Record<string, unknown>;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BoomController],
      providers: [
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
        { provide: ERROR_REPORTER, useValue: { captureException } },
        { provide: FAULT_LOG, useValue: { recordFault } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  beforeEach(() => {
    recordFault.mockClear();
    captureException.mockClear();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns a sanitized 500 body with no internals for unexpected errors", async () => {
    const response = await request(app.getHttpServer()).get("/boom/error");

    expect(response.status).toBe(500);
    expect(response.body.statusCode).toBe(500);
    expect(response.body.message).toBe("Internal server error");
    // The reference is the only thing added to a fault body, and it is ours.
    expect(Object.keys(response.body).sort()).toEqual(["correlationId", "message", "statusCode"]);
    expect(JSON.stringify(response.body)).not.toContain("hunter2");
    expect(JSON.stringify(response.body)).not.toContain("stack");
  });

  it("reports unexpected errors to the error reporter", async () => {
    captureException.mockClear();

    await request(app.getHttpServer()).get("/boom/error");

    expect(captureException).toHaveBeenCalledOnce();
    expect(captureException.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("passes through client-error (4xx) status and message unchanged", async () => {
    captureException.mockClear();

    const response = await request(app.getHttpServer()).get("/boom/bad");

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ statusCode: 400, message: "name is required" });
    expect(captureException).not.toHaveBeenCalled();
  });

  /**
   * The old rule blanked the message on EVERY 5xx, which also blanked the ones
   * we write on purpose: "Microsoft Graph could not send the test email" could
   * never reach a customer, and neither could imports' "no rows were applied".
   * The user saw a bare "Internal server error" for a situation we understood
   * perfectly well and had already explained.
   *
   * An HttpException is always constructed by application code, so its message
   * is deliberate. The property that actually matters — internals and stack
   * text never reach the client — lives with everything that is NOT an
   * HttpException, and that is unchanged.
   */
  it("keeps the message of a 5xx we threw deliberately", async () => {
    const response = await request(app.getHttpServer()).get("/boom/upstream");

    expect(response.status).toBe(502);
    expect(response.body.message).toBe("Microsoft Graph could not send the test email");
  });

  it("still reports a deliberate 5xx to the error reporter", async () => {
    captureException.mockClear();

    await request(app.getHttpServer()).get("/boom/upstream");

    // Surfacing the message must not quietly stop it being an incident.
    expect(captureException).toHaveBeenCalledOnce();
  });

  it("still blanks a non-HttpException 5xx, where the internals actually live", async () => {
    const response = await request(app.getHttpServer()).get("/boom/prisma-ish");

    expect(response.status).toBe(500);
    expect(response.body.statusCode).toBe(500);
    expect(response.body.message).toBe("Internal server error");
    expect(JSON.stringify(response.body)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(response.body)).not.toContain("eva_app");
  });

  /**
   * ⚠️ THE 2026-08-11 TESTS. Every request to `/organisations` failed for the
   * only real account on production, for two hours, and the entire written
   * record was pino-http's `request errored` — no code, no constraint, no
   * account. The cause was reconstructed afterwards by querying the database by
   * hand. These state the fields that would have made that a one-minute
   * diagnosis, and each one fails if its field is dropped.
   */
  describe("the log line an operator reads", () => {
    it("names the cause: the error, its code, and WHICH constraint failed", async () => {
      await request(app.getHttpServer()).get("/boom/collision");

      const fault = loggedFault().fault as Record<string, unknown>;
      expect(fault.name).toBe("PrismaClientKnownRequestError");
      expect(fault.code).toBe("P2002");
      // "a unique index rejected the row" and "the one on email did" are an
      // hour apart.
      expect(fault.detail).toContain("email");
      expect(fault.message).toContain("Unique constraint failed");
      expect(fault.stack).toContain("throwUniqueViolation");
    });

    it("names the account it happened to, and the route", async () => {
      await request(app.getHttpServer()).get("/boom/collision");

      const entry = loggedFault();
      expect(entry.authUserId).toBe("00000000-0000-4000-8000-0000000000a1");
      expect(entry.path).toBe("/boom/collision");
      expect(entry.method).toBe("GET");
      expect(entry.statusCode).toBe(500);
      expect(entry.unexpected).toBe(true);
    });

    it("ties the line to the reference the customer can read off the screen", async () => {
      const response = await request(app.getHttpServer())
        .get("/boom/collision")
        .set("x-correlation-id", "ref-from-the-edge");

      expect(response.body.correlationId).toBe("ref-from-the-edge");
      expect(loggedFault().correlationId).toBe("ref-from-the-edge");
    });

    /**
     * ⚠️ THE FAULT LOG IS A SINK LIKE ANY OTHER (BRD 14). A Prisma
     * initialization error prints the whole datasource URL, password included,
     * and the handoff's rule is that a connection string is never printed
     * anywhere. The host stays — "which server" is the diagnostic half.
     */
    it("never writes a password into the log, even when the driver hands us one", async () => {
      await request(app.getHttpServer()).get("/boom/db-down");

      const written = JSON.stringify(loggedFault());
      expect(written).not.toContain("sup3rs3cret");
      expect(written).toContain("[redacted]");
      expect(written).toContain("db.example.com");
    });

    it("writes nothing for a deliberate 4xx — a missing invoice number is not an incident", async () => {
      await request(app.getHttpServer()).get("/boom/bad");

      expect(recordFault).not.toHaveBeenCalled();
    });

    /**
     * A 502 we threw on purpose is still our side failing a customer. It is
     * logged like any other 5xx, and marked `unexpected: false` so a search can
     * tell "Graph is down again" from "something broke that nobody knew about".
     */
    it("writes a line for a deliberate 5xx, marked as expected", async () => {
      await request(app.getHttpServer()).get("/boom/upstream");

      const entry = loggedFault();
      expect(entry.statusCode).toBe(502);
      expect(entry.unexpected).toBe(false);
    });
  });

  describe("the answer a database fault earns", () => {
    it("turns an unreachable database into 503 and our own words", async () => {
      const response = await request(app.getHttpServer()).get("/boom/db-down");

      expect(response.status).toBe(503);
      expect(response.body.message).toBe(
        "Eva can't reach its database just now. Nothing is lost — please try again shortly.",
      );
      // ⚠️ The reference the customer can quote is the SAME string as the one
      // on the log line — a reference that matches nothing would be worse than
      // no reference at all. Never optional: this ran with no logger wired.
      expect(response.body.correlationId).toBeTypeOf("string");
      expect(response.body.correlationId).toBe(loggedFault().correlationId);
      // The customer gets the reference, never the datasource URL.
      expect(JSON.stringify(response.body)).not.toContain("sup3rs3cret");
      expect(JSON.stringify(response.body)).not.toContain("db.example.com");
    });

    it("still reports and still logs the 503 — a friendlier status is not a quieter one", async () => {
      await request(app.getHttpServer()).get("/boom/db-down");

      expect(captureException).toHaveBeenCalledOnce();
      expect(loggedFault().statusCode).toBe(503);
    });

    /**
     * ⚠️ THE RESTRAINT TEST — DO NOT "IMPROVE" THIS INTO A 409. A unique
     * violation does not say whose fault it is. On 2026-08-11 it was OURS (a
     * stale `users.email` row), and answering 409 would have told the founder
     * they had done something wrong while dropping the fault below the 5xx line
     * that gets it reported. Meaning belongs at the call site that knows it.
     */
    it("leaves a unique-constraint violation as a reported 500", async () => {
      const response = await request(app.getHttpServer()).get("/boom/collision");

      expect(response.status).toBe(500);
      expect(response.body.message).toBe("Internal server error");
      expect(captureException).toHaveBeenCalledOnce();
    });
  });
});

describe("GlobalExceptionFilter — wired into the real app", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it("sanitizes the framework 404 for unknown routes", async () => {
    const response = await request(app.getHttpServer()).get("/definitely-not-a-route");

    expect(response.status).toBe(404);
    expect(response.body.statusCode).toBe(404);
    expect(JSON.stringify(response.body)).not.toContain("stack");
  });
});
