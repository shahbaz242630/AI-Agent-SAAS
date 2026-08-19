import { timingSafeEqual } from "node:crypto";
import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import type { Request } from "express";
import { API_ENV } from "../../config/config.module.js";
import type { ApiEnv } from "../../config/env.js";

/**
 * Shared-secret guard for internal service-to-service endpoints (Slice 1.5,
 * plan §7.8 — e.g. the Trigger.dev reconcile sweep calling
 * POST /internal/reminders/reconcile). The route is @Public() (no Supabase
 * JWT); this guard is the ONLY authentication. The comparison is
 * constant-time and never logs the secret (BRD 13/14).
 */
@Injectable()
export class InternalSecretGuard implements CanActivate {
  constructor(@Inject(API_ENV) private readonly env: ApiEnv) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers["x-internal-secret"];
    const provided = Array.isArray(header) ? header[0] : header;
    if (provided === undefined || !this.matches(provided)) {
      throw new UnauthorizedException("Missing or invalid internal secret");
    }
    return true;
  }

  /** Length-checked first (timingSafeEqual throws on length mismatch), then constant-time. */
  private matches(provided: string): boolean {
    const expected = Buffer.from(this.env.INTERNAL_API_SECRET, "utf8");
    const actual = Buffer.from(provided, "utf8");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}
