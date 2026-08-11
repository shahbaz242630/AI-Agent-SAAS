import { randomUUID } from "node:crypto";
import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
  Optional,
  type ArgumentsHost,
  type ExceptionFilter,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { answerForDatabaseFault } from "../errors/database-fault.js";
import { StructuredHttpException } from "../errors/structured-http.exception.js";
import { describeFault } from "../logging/fault-description.js";
import { stripCredentialQuery } from "../logging/log-redaction.js";
import { ERROR_REPORTER, type ErrorReporter } from "../monitoring/error-reporter.js";
import { FAULT_LOG, type FaultLog } from "../monitoring/fault-log.js";

/**
 * Sanitizes every error response leaving the API (BRD 14): stack traces and
 * internals never reach the client, 5xx faults are reported to the
 * ErrorReporter (Sentry in production), and — since 2026-08-11 — every fault
 * writes a line to the log naming its cause.
 *
 * The line is drawn at HttpException, not at the status code. An HttpException
 * is always constructed by application code, so its message is deliberate — a
 * BadGatewayException saying "Microsoft Graph could not send the test email" is
 * exactly what the customer needs to read. Everything else (Prisma failures,
 * TypeErrors, driver errors) carries connection strings, query text and stack
 * detail, and is what the generic message exists to contain.
 *
 * This used to key on `status < 500`, which also silenced the two 5xx messages
 * we write on purpose — the customer got "Internal server error" for a
 * situation we understood and had already explained in plain English.
 *
 * ⚠️ STANDING RULE, and the thing that makes the above safe: an HttpException's
 * message is now a PUBLIC string. Never construct one from a caught error —
 * `new BadGatewayException(err.message)` would hand a customer the very
 * connection strings and query text this filter exists to contain. Both 5xx
 * exceptions in the API today are hardcoded literals (checked 2026-08-01);
 * keep it that way, and summarise upstream failures in words we chose.
 *
 * ⚠️ A FAULT IS ANYTHING THAT IS NOT AN HttpException, AND IT IS ALWAYS LOGGED
 * AND ALWAYS REPORTED — whatever status we end up answering with. On
 * 2026-08-11 `/organisations` returned 500 to every request the founder made
 * for two hours and the log said only `request errored`; the cause had to be
 * dug out of the database afterwards. Answering well is half the job. Saying
 * what happened, where an engineer will see it, is the other half.
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    @Optional()
    @Inject(ERROR_REPORTER)
    private readonly errorReporter?: ErrorReporter,
    @Optional()
    @Inject(FAULT_LOG)
    private readonly faultLog?: FaultLog,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isApplicationError = exception instanceof HttpException;
    const described = describeFault(exception);
    // Not an HttpException means nobody meant this: a driver error, a Prisma
    // failure, a TypeError. Ours until proven otherwise — and the only kind
    // whose message must be withheld from the client.
    const fault = isApplicationError ? undefined : described;
    const known = fault ? answerForDatabaseFault(fault.code) : null;

    const status = isApplicationError
      ? exception.getStatus()
      : (known?.status ?? HttpStatus.INTERNAL_SERVER_ERROR);
    const message = isApplicationError
      ? exception.message
      : (known?.message ?? "Internal server error");

    const correlationId = correlationIdOf(request);
    // Not the raw URL: on the OAuth callback the query string carries a live
    // authorization code + state JWT (Slice 1.6, BRD 14).
    const path = stripCredentialQuery(request.url);

    /**
     * ⚠️ EVERY 5xx, NOT ONLY THE UNEXPECTED ONES. A 502 we threw on purpose
     * ("Microsoft Graph could not send the test email") is still our side
     * failing a customer, and an operator reading the log at the time should
     * not have to infer it from a status code with no line beside it. The
     * difference between the two is what the entry CONTAINS, not whether one
     * exists.
     */
    if (fault || status >= 500) {
      this.faultLog?.recordFault({
        correlationId,
        method: request.method,
        path,
        statusCode: status,
        /** `false` for the deliberate ones, so a log search can tell "Graph is
         *  down again" from "something is broken and nobody knew". */
        unexpected: fault !== undefined,
        /**
         * ⚠️ WHO IT HAPPENED TO — the field we did not have on 2026-08-11, and
         * the one that turns "something is throwing 500s" into "this account
         * cannot get past sign-in". The auth id, never the email: pino redacts
         * `email` everywhere (BRD 14) and an opaque id is enough to find the
         * row.
         */
        authUserId: authUserIdOf(request),
        fault: described,
      });
    }

    if (fault || status >= 500) {
      this.errorReporter?.captureException(exception, { correlationId, path });
    }

    // A StructuredHttpException's body is deliberate — a machine-readable code
    // the client branches on, not prose. Flattening it here would be the same
    // defect as F4 (slice 1.6), where the API's real answer was discarded and
    // the customer read "please try again" instead. Opt-in, so everything else
    // keeps the flattening that stops internals leaking. `statusCode` is
    // stamped last so a body can never disagree with the status actually sent.
    if (exception instanceof StructuredHttpException) {
      response
        .status(status)
        .json({ ...(exception.getResponse() as Record<string, unknown>), statusCode: status });
      return;
    }

    response.status(status).json({
      statusCode: status,
      message,
      /**
       * ⚠️ THE REFERENCE GOES IN THE BODY, NOT ONLY THE HEADER. It has always
       * been on the response as `x-correlation-id` and that has never once
       * helped: nobody screenshots a response header. In the body it reaches
       * the screen, and a customer saying "it said reference 4f2a…" is the
       * difference between finding their log line and asking them to reproduce
       * it. Only where we are the ones at fault — a deliberate 400 telling
       * somebody their invoice number is missing needs no case number.
       */
      ...(fault || status >= 500 ? { correlationId } : {}),
    });
  }
}

/**
 * The reference that ties the customer's screen to the log line.
 *
 * pino-http stamps `req.id` and echoes it as `x-correlation-id`, so in the real
 * app the first branch always wins and the fault line, the request line and the
 * response all quote the same string.
 *
 * ⚠️ IT MINTS ONE RATHER THAN RETURNING `undefined`, and that is not
 * belt-and-braces. A reference is only worth printing if it is ALWAYS there;
 * "quote me the reference" is useless advice if some faults have none, and the
 * fault log takes its id from this same call — so even in a context with no
 * logger wired, the body and the log entry still agree. An id that matches
 * nothing else would be worse than none, which is why `req.id` is preferred
 * over minting.
 */
function correlationIdOf(request: Request): string {
  const id = (request as { id?: unknown }).id;
  if (typeof id === "string" && id.length > 0) return id;
  const header = request.headers["x-correlation-id"];
  if (typeof header === "string" && header.length > 0) return header;
  return randomUUID();
}

/**
 * Read defensively rather than importing `AuthenticatedRequest`: this filter
 * catches everything, including requests that failed BEFORE the guard ran and
 * therefore have no `authUser` at all. A shape check answers honestly for both.
 */
function authUserIdOf(request: Request): string | undefined {
  const authUser = (request as { authUser?: { authUserId?: unknown } }).authUser;
  return typeof authUser?.authUserId === "string" ? authUser.authUserId : undefined;
}
