import { BadRequestException, Controller, Get, type INestApplication } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter.js";
import { ERROR_REPORTER } from "../src/common/monitoring/error-reporter.js";
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
}

describe("GlobalExceptionFilter", () => {
  let app: INestApplication;
  const captureException = vi.fn();

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [BoomController],
      providers: [
        { provide: APP_FILTER, useClass: GlobalExceptionFilter },
        { provide: ERROR_REPORTER, useValue: { captureException } },
      ],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("returns a sanitized 500 body with no internals for unexpected errors", async () => {
    const response = await request(app.getHttpServer()).get("/boom/error");

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ statusCode: 500, message: "Internal server error" });
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
