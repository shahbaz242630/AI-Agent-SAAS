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
import { stripCredentialQuery } from "../logging/log-redaction.js";
import { ERROR_REPORTER, type ErrorReporter } from "../monitoring/error-reporter.js";

/**
 * Sanitizes every error response leaving the API (BRD 14): stack traces and
 * internals never reach the client, and 5xx faults are reported to the
 * ErrorReporter (Sentry in production).
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
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    @Optional()
    @Inject(ERROR_REPORTER)
    private readonly errorReporter?: ErrorReporter,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const isApplicationError = exception instanceof HttpException;
    const status = isApplicationError ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = isApplicationError ? exception.message : "Internal server error";

    if (status >= 500) {
      this.errorReporter?.captureException(exception, {
        correlationId: request.headers["x-correlation-id"],
        // Not the raw URL: on the OAuth callback the query string carries a
        // live authorization code + state JWT (Slice 1.6, BRD 14).
        path: stripCredentialQuery(request.url),
      });
    }

    response.status(status).json({ statusCode: status, message });
  }
}
