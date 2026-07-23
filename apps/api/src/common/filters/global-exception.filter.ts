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
import { ERROR_REPORTER, type ErrorReporter } from "../monitoring/error-reporter.js";

/**
 * Sanitizes every error response leaving the API (BRD 14): 4xx keep their
 * status and message (safe by construction), anything else becomes a generic
 * 500 — stack traces and internals never reach the client. 5xx faults are
 * reported to the ErrorReporter (Sentry in production).
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

    const isClientError = exception instanceof HttpException && exception.getStatus() < 500;
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const message = isClientError ? exception.message : "Internal server error";

    if (status >= 500) {
      this.errorReporter?.captureException(exception, {
        correlationId: request.headers["x-correlation-id"],
        path: request.url,
      });
    }

    response.status(status).json({ statusCode: status, message });
  }
}
