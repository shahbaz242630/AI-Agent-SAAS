import { HttpStatus } from "@nestjs/common";
import { SESSION_IDLE_TIMEOUT_CODE } from "@eva/types";
import { StructuredHttpException } from "../../common/errors/structured-http.exception.js";

/**
 * 401 Unauthorized — the account went untouched for longer than
 * `SESSION_IDLE_TIMEOUT_MS`, so the session was ended (founder's request,
 * 2026-08-12).
 *
 * ⚠️ STRUCTURED, AND IT HAS TO BE. `GlobalExceptionFilter` flattens every error
 * body to `{ statusCode, message }` unless it opts out through this base class,
 * and a plain 401 here is indistinguishable from an expired token — which the
 * web app handles by sending the customer to `/sign-in`. That is precisely the
 * wrong move for this one: the Supabase cookie is still valid, so the proxy
 * bounces them back to `/app`, which 401s again. A loop the customer cannot
 * escape and no error message explains.
 *
 * The first version of this WAS a plain `UnauthorizedException` carrying an
 * object body, which looked right and was silently flattened. The test that
 * asserts on `code` is what caught it.
 */
export class SessionIdleTimeoutException extends StructuredHttpException {
  constructor() {
    super(
      {
        statusCode: HttpStatus.UNAUTHORIZED,
        code: SESSION_IDLE_TIMEOUT_CODE,
        message:
          "You were signed out because the account was idle for two days. Please sign in again.",
      },
      HttpStatus.UNAUTHORIZED,
    );
  }
}
