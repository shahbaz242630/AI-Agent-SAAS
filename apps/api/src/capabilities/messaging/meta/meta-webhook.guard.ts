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
import { META_SIGNATURE_HEADER, verifyMetaSignature } from "./meta-signature.js";

/**
 * The only authentication on the Meta webhook (slice 3.2c).
 *
 * The same position `ResendWebhookGuard` holds for email, and the same three
 * rules, because the reasons have not changed:
 *
 * ⚠️ THE ROUTE IS `@Public()` AND REACHABLE BY ANYONE WHO LEARNS THE URL. Meta
 * has never signed in. Everything downstream — a delivery filed in a named
 * organisation, and from 3.4 a reply sent as that customer — rests on this.
 *
 * ⚠️ AN UNCONFIGURED SECRET REFUSES EVERYTHING. "No secret, so skip the check"
 * opens the door on exactly the environment where somebody forgot to set it.
 *
 * ⚠️ THE RAW BYTES, NOT THE PARSED BODY. Meta signs an escaped-unicode
 * rendering of the payload; a re-serialised body differs on any non-ASCII
 * message — an accented surname, an emoji, any Arabic. Hashing the bytes as
 * they arrived sidesteps it, which is why `verifyMetaSignature` takes a Buffer
 * and nothing else.
 */
@Injectable()
export class MetaWebhookGuard implements CanActivate {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MetaWebhookGuard.name);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RawBodyRequest<Request>>();

    const secret = this.env.META_APP_SECRET;
    if (!secret) {
      this.logger.error("a Meta webhook arrived but META_APP_SECRET is not set — refusing it");
      throw new UnauthorizedException("Meta webhooks are not configured");
    }

    const rawBody = request.rawBody;
    if (!rawBody) {
      this.logger.error("Meta webhook had no raw body — is `rawBody: true` still set?");
      throw new UnauthorizedException("Meta webhook could not be verified");
    }

    const result = verifyMetaSignature(secret, header(request, META_SIGNATURE_HEADER), rawBody);
    if (!result.ok) {
      // The reason, never the signature or the body: the request is
      // unauthenticated and possibly hostile, and this line is read widely.
      this.logger.warn({ reason: result.reason }, "rejected an unverified Meta webhook");
      throw new UnauthorizedException("Meta webhook signature is not valid");
    }
    return true;
  }
}

function header(request: Request, name: string): string | null {
  const value = request.headers[name];
  const single = Array.isArray(value) ? value[0] : value;
  return typeof single === "string" ? single : null;
}
