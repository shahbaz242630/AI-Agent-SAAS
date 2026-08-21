import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import type { RawBodyRequest } from "@nestjs/common";
import type { Request } from "express";
import { API_ENV } from "../../../config/config.module.js";
import type { ApiEnv } from "../../../config/env.js";
import { verifyResendSignature } from "./resend-webhook-signature.js";

/**
 * The only authentication on the inbound webhook (Slice 3.1b).
 *
 * ⚠️ THIS ROUTE IS `@Public()` AND REACHABLE BY ANYONE WHO LEARNS THE URL. There
 * is no JWT: it is called by Resend, which has never signed in and has no
 * session. Everything downstream — creating a lead in a named organisation,
 * and eventually replying to it from that customer's own mailbox — happens on
 * the strength of what this guard decides.
 *
 * ⚠️ AN UNCONFIGURED SECRET REFUSES EVERYTHING. The tempting shape is "no
 * secret set, so skip verification", and it is catastrophic: it opens the door
 * precisely on the environment where somebody forgot to configure it, and
 * nothing fails to say so. Fail closed, like every other context in this system.
 */
@Injectable()
export class ResendWebhookGuard implements CanActivate {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ResendWebhookGuard.name);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RawBodyRequest<Request>>();

    const secret = this.env.RESEND_WEBHOOK_SECRET;
    if (!secret) {
      this.logger.error(
        "an inbound webhook arrived but RESEND_WEBHOOK_SECRET is not set — refusing it",
      );
      throw new UnauthorizedException("Inbound webhooks are not configured");
    }

    /**
     * ⚠️ THE RAW BYTES, NOT THE PARSED BODY. Nest is booted with
     * `rawBody: true` for this line alone. `JSON.stringify` of the parsed
     * payload is a DIFFERENT string from the one Resend signed — key order and
     * unicode escaping both differ — so verifying against it rejects every
     * genuine webhook while looking entirely correct.
     */
    const rawBody = request.rawBody;
    if (!rawBody) {
      this.logger.error("inbound webhook had no raw body — is `rawBody: true` still set?");
      throw new UnauthorizedException("Inbound webhook could not be verified");
    }

    const result = verifyResendSignature(
      secret,
      {
        id: header(request, "svix-id"),
        timestamp: header(request, "svix-timestamp"),
        signature: header(request, "svix-signature"),
      },
      rawBody,
    );

    if (!result.ok) {
      // The reason, never the signature or the body: this line is read widely
      // and the request it describes is unauthenticated and possibly hostile.
      this.logger.warn({ reason: result.reason }, "rejected an unverified inbound webhook");
      throw new UnauthorizedException("Inbound webhook signature is not valid");
    }
    return true;
  }
}

function header(request: Request, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}
