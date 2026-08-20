import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Controller, Get, type INestApplication } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { Test } from "@nestjs/testing";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { LoggerModule, PinoLogger } from "nestjs-pino";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalExceptionFilter } from "../src/common/filters/global-exception.filter.js";
import { ERROR_REPORTER } from "../src/common/monitoring/error-reporter.js";
import { FAULT_LOG } from "../src/common/monitoring/fault-log.js";
import { OwnedBy } from "../src/common/monitoring/owner.js";
import { RequestOwnerGuard } from "../src/common/monitoring/request-owner.guard.js";

/**
 * Per-product observability (Slice 3.0c).
 *
 * ⚠️ THE CASE FOR THIS FILE IS 2026-08-19. A product vanished from a paying
 * customer's screen and linked them to a bare 404; 1,438 tests and two
 * architectural walls saw nothing, and the log could not have helped, because
 * no line in it said which product a request belonged to. With one product
 * that was survivable. With five it is the difference between "the API is
 * throwing 500s" and "invoice follow-up is throwing 500s for this account".
 *
 * Two halves, and NEITHER covers the other:
 *
 *  1. **The wall** — every controller declares an owner, and the declaration
 *     matches the folder it lives in. Catches the annotation that was never
 *     written, and the one copied from a neighbouring product.
 *  2. **The wiring** — a request actually emits it. An annotation nothing
 *     reads is a comment, and this codebase has already shipped promises that
 *     no code kept (`MODULE_DEPENDENCIES`, and the sidebar comment calling
 *     three states exhaustive when there were four).
 */

const SRC = path.resolve(__dirname, "../src");

/** Every non-spec source file under src, with its path relative to src. */
function sourceFiles(): { file: string; source: string }[] {
  const out: { file: string; source: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "node_modules" || entry === "dist" || entry === "generated") continue;
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".spec.ts")) continue;
      out.push({
        file: path.relative(SRC, full).split(path.sep).join("/"),
        source: readFileSync(full, "utf8"),
      });
    }
  };
  walk(SRC);
  return out;
}

/**
 * The owner a file's LOCATION entitles it to.
 *
 * ⚠️ THE FOLDER IS THE TRUTH AND THE ANNOTATION IS THE COPY. The decorator has
 * to be written by hand — a compiled class has no idea what path it came from —
 * so the test derives the right answer from the tree that `pnpm boundaries`
 * already enforces, and compares. That way the two walls agree by construction:
 * a file cannot be in the invoice product for import purposes and in the
 * platform for logging purposes.
 */
function expectedOwner(file: string): string | undefined {
  const [layer, name] = file.split("/");
  if (layer === "platform") return "platform";
  if (layer === "capabilities" && name) return `capability:${name}`;
  if (layer === "products" && name) return `product:${name}`;
  return undefined;
}

describe("Attribution: every controller says which product it is", () => {
  const files = sourceFiles();

  it("finds the controllers at all (a walk that matches nothing passes everything)", () => {
    const controllers = files.filter(({ source }) => /^@Controller\(/m.test(source));

    expect(controllers.length).toBeGreaterThanOrEqual(15);
  });

  it("every controller carries @OwnedBy, and it matches the folder it lives in", () => {
    const wrong: string[] = [];

    for (const { file, source } of files) {
      if (!/^@Controller\(/m.test(source)) continue;

      const expected = expectedOwner(file);
      if (!expected) {
        wrong.push(`${file}: a controller outside platform/, capabilities/ and products/`);
        continue;
      }

      const declared = source.match(/^@OwnedBy\("([^"]+)"\)/m)?.[1];
      if (declared === undefined) {
        wrong.push(`${file}: no @OwnedBy — its log lines would say "unattributed"`);
      } else if (declared !== expected) {
        wrong.push(`${file}: says ${declared}, lives in ${expected}`);
      }
    }

    expect(wrong, wrong.join("\n")).toEqual([]);
  });
});

/**
 * A stand-in product. Deliberately NOT the invoice product: the wiring must
 * work for whatever gets plugged in next, and a test that only passes for the
 * one product we happen to have built proves nothing about the fifth.
 */
@Controller("tagged")
@OwnedBy("product:test-product")
class TaggedController {
  constructor(private readonly logger: PinoLogger) {}

  @Get("ok")
  ok(): { ok: true } {
    return { ok: true };
  }

  /** A line written deep in a service, which knows nothing about any of this. */
  @Get("chatty")
  chatty(): { ok: true } {
    this.logger.info({ organisationId: "org-1" }, "reminder send failed for organisation");
    return { ok: true };
  }

  @Get("boom")
  boom(): never {
    throw new Error("kaboom");
  }
}

/** An organisation-scoped route, which is what almost every real one is. */
@Controller("tagged/:organisationId/things")
@OwnedBy("product:test-product")
class ScopedController {
  @Get()
  list(): { ok: true } {
    return { ok: true };
  }
}

/** What a controller that forgot the decorator does. The wall above stops one
 *  reaching production; this pins down what would happen if it did. */
@Controller("untagged")
class UntaggedController {
  @Get("boom")
  boom(): never {
    throw new Error("kaboom");
  }
}

describe("Attribution: the wiring, not the annotation", () => {
  let app: INestApplication;
  const captureException = vi.fn();
  const recordFault = vi.fn();
  let lines: Record<string, unknown>[] = [];

  /** The log line pino-http writes when a request finishes — the one carrying
   *  `responseTime` and `statusCode`, and therefore the per-product metric. */
  const completionLine = async (): Promise<Record<string, unknown>> =>
    vi.waitFor(() => {
      const line = lines.find((entry) => typeof entry.responseTime === "number");
      expect(line, "no request-completion line was written").toBeDefined();
      return line as Record<string, unknown>;
    });

  beforeAll(async () => {
    const stream = {
      write: (chunk: string) => {
        for (const raw of chunk.split("\n")) {
          if (raw.trim().length === 0) continue;
          lines.push(JSON.parse(raw) as Record<string, unknown>);
        }
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        LoggerModule.forRoot({
          // The array form is how nestjs-pino passes a destination through to
          // pino-http — (options, stream) — so the test reads what production
          // would actually have written.
          pinoHttp: [{ level: "info" }, stream],
          assignResponse: true,
        }),
      ],
      controllers: [TaggedController, ScopedController, UntaggedController],
      providers: [
        { provide: APP_GUARD, useClass: RequestOwnerGuard },
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
    lines = [];
  });

  afterAll(async () => {
    await app.close();
  });

  it("stamps the product on the request-completion line, beside status and duration", async () => {
    await request(app.getHttpServer()).get("/tagged/ok").expect(200);

    const line = await completionLine();
    expect(line.product).toBe("product:test-product");
    // The three fields together ARE the per-product metric: group by product,
    // count, and take the error rate and the latency off the same line.
    expect(line.responseTime).toBeTypeOf("number");
    expect((line.res as { statusCode?: number }).statusCode).toBe(200);
  });

  /**
   * ⚠️ NOT REDUNDANT WITH THE URL, AND PRODUCTION IS WHY. Verified against
   * Railway on 2026-08-20: its log filter matches whole attributes and its text
   * search does not reach inside them, so searching for an organisation id
   * returns NOTHING even though the id is sitting in `req.url` on every line.
   * "Everything we did for this customer" is the first question a complaint
   * asks; this field is the only thing that answers it.
   */
  it("stamps the organisation, so one customer's lines can be found at all", async () => {
    await request(app.getHttpServer())
      .get("/tagged/7a2ef080-7bdc-417c-94dc-efd651a7349f/things")
      .expect(200);

    const line = await completionLine();
    expect(line.organisationId).toBe("7a2ef080-7bdc-417c-94dc-efd651a7349f");
    expect(line.product).toBe("product:test-product");
  });

  it("leaves the field off entirely when a route has no organisation", async () => {
    await request(app.getHttpServer()).get("/tagged/ok").expect(200);

    const line = await completionLine();
    // Absent, not empty: an empty string would look like an organisation whose
    // id we failed to read.
    expect(line).not.toHaveProperty("organisationId");
  });

  it("reaches a line written deep in a service that knows nothing about products", async () => {
    await request(app.getHttpServer()).get("/tagged/chatty").expect(200);

    const line = await vi.waitFor(() => {
      const found = lines.find((entry) => entry.msg === "reminder send failed for organisation");
      expect(found, "the service's own line was never written").toBeDefined();
      return found as Record<string, unknown>;
    });
    expect(line.product).toBe("product:test-product");
  });

  it("puts the product in the fault entry", async () => {
    await request(app.getHttpServer()).get("/tagged/boom").expect(500);

    expect(recordFault).toHaveBeenCalledOnce();
    const entry = recordFault.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry.product).toBe("product:test-product");
  });

  /**
   * ⚠️ TAGS, NOT `extra` — the assertion that keeps Sentry usable. In `extra`
   * these are readable only once you have already found the event, which is no
   * help when the question is "what has invoice follow-up broken this week" or
   * when a customer quotes the reference off their own screen.
   */
  it("sends the product and the reference to Sentry as searchable tags", async () => {
    await request(app.getHttpServer()).get("/tagged/boom").expect(500);

    expect(captureException).toHaveBeenCalledOnce();
    const context = captureException.mock.calls[0]?.[1] as {
      tags?: Record<string, string>;
    };
    expect(context.tags?.product).toBe("product:test-product");
    expect(context.tags?.correlationId).toBeTypeOf("string");
  });

  it("the reference in the customer's error body is the one tagged on the event", async () => {
    const response = await request(app.getHttpServer()).get("/tagged/boom").expect(500);

    const context = captureException.mock.calls[0]?.[1] as { tags?: Record<string, string> };
    // The whole point of a reference: the string on the screen finds the event.
    expect(context.tags?.correlationId).toBe(response.body.correlationId);
  });

  it("says `unattributed` out loud rather than leaving the field off", async () => {
    await request(app.getHttpServer()).get("/untagged/boom").expect(500);

    const entry = recordFault.mock.calls[0]?.[0] as Record<string, unknown>;
    // A missing field reads as "nobody thought about this". A value can be
    // searched for, counted, and alerted on if it ever appears.
    expect(entry.product).toBe("unattributed");
  });
});
