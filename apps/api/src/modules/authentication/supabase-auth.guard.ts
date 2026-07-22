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
import { Reflector } from "@nestjs/core";
import { jwtVerify } from "jose";
import { API_ENV } from "../../config/config.module.js";
import type { ApiEnv } from "../../config/env.js";
import { IS_PUBLIC_KEY } from "./public.decorator.js";
import type { AuthenticatedRequest } from "./current-auth-user.decorator.js";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { JwksService } from "./jwks.service.js";

/**
 * Global guard (BRD 9.3): every non-@Public endpoint requires a valid
 * Supabase access token. Signature is verified against the project JWKS;
 * audience must be "authenticated" and the issuer the project's auth server.
 */
@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwks: JwksService,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.bearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException("Missing bearer token");

    try {
      const { payload } = await jwtVerify(token, this.jwks.getKey(), {
        audience: "authenticated",
        issuer: `${this.env.SUPABASE_URL}/auth/v1`,
      });
      if (!payload.sub || typeof payload.email !== "string" || payload.email.length === 0) {
        throw new UnauthorizedException("Token is missing required claims");
      }
      request.authUser = { authUserId: payload.sub, email: payload.email };
      return true;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new UnauthorizedException("Invalid or expired token");
    }
  }

  private bearerToken(header: string | undefined): string | undefined {
    if (!header) return undefined;
    const [scheme, token, ...rest] = header.split(" ");
    if (rest.length > 0 || scheme !== "Bearer" || !token) return undefined;
    return token;
  }
}
