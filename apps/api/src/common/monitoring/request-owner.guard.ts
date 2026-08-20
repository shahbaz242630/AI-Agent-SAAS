import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { Reflector } from "@nestjs/core";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { OWNER_METADATA, UNATTRIBUTED, type OwnedRequest, type OwnerTag } from "./owner.js";

/**
 * Stamps every request with the product it belongs to, so that every line it
 * emits — including the completion line carrying its status and duration —
 * says which product an operator is looking at.
 *
 * ⚠️ A GUARD RATHER THAN AN INTERCEPTOR, AND THAT IS THE WHOLE POINT. An
 * interceptor runs AFTER the guards, so a request rejected by authentication or
 * by the rate limiter would emit its 401 or 429 with no product on it — and
 * "customers cannot sign in to the invoice product" is exactly the complaint
 * this exists to answer. Registered first in `app.module.ts`, it runs before
 * the auth guard and tags the failures too.
 *
 * ⚠️ IT NEVER DENIES ANYTHING. It returns true unconditionally; a fault in
 * observability must not become a fault in the product. The one thing it can
 * do wrong is label a line, and the label is checked by a test rather than by
 * a runtime throw — a missing decorator answering 500 on a working endpoint
 * would be the cure killing the patient.
 */
@Injectable()
export class RequestOwnerGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly logger: PinoLogger,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== "http") return true;

    const owner =
      this.reflector.getAllAndOverride<OwnerTag | undefined>(OWNER_METADATA, [
        context.getHandler(),
        context.getClass(),
      ]) ?? UNATTRIBUTED;

    const request = context
      .switchToHttp()
      .getRequest<OwnedRequest & { params?: Record<string, string> }>();
    // Read back by the exception filter, which has no ExecutionContext of its
    // own to ask and must answer for faults thrown anywhere in the request.
    request.evaOwner = owner;

    /**
     * ⚠️ WHO IT HAPPENED TO, AS A FIELD RATHER THAN BURIED IN THE URL — and
     * this is NOT redundancy. Verified against production on 2026-08-20:
     * Railway's log filter matches whole ATTRIBUTES and its text search does
     * not reach inside them, so `--filter "<organisation id>"` returns nothing
     * even though the id is sitting in `req.url` on every line. "Show me
     * everything we did for this customer" is the first question a complaint
     * asks, and without this field it has no answer.
     *
     * It is the organisation the request was FOR, taken from the route before
     * anything has checked whether the caller may have it — a 403 in the same
     * line is what says they may not. Route params are populated by the router
     * before guards run; absent on routes that are not organisation-scoped, and
     * left off rather than logged as empty.
     */
    const organisationId = request.params?.organisationId;

    /**
     * ⚠️ `assign` REACHES EVERY LINE THIS REQUEST WILL EMIT, past and future.
     * It replaces the request-scoped logger with a child carrying the field, so
     * a service logging `reminder send failed for organisation` three layers
     * down is labelled without knowing this exists — and with
     * `assignResponse: true` (app.module.ts) so is pino-http's own completion
     * line, which is the one that carries `responseTime` and `statusCode`.
     * That line, tagged, IS the per-product metric: rate, errors and latency
     * become a log query rather than a metrics server nobody scrapes.
     *
     * It throws outside a request scope. That is left to throw: the logger
     * middleware runs on every route before any guard, so being out of scope
     * here would mean the logging module was not wired at all, and a silent
     * catch would hide it for exactly as long as it took to matter.
     */
    this.logger.assign({
      product: owner,
      ...(organisationId ? { organisationId } : {}),
    });
    return true;
  }
}
