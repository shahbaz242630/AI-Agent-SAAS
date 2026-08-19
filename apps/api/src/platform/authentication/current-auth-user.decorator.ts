import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/** Identity extracted from a verified Supabase access token. */
export interface AuthUser {
  /** Supabase auth user id (JWT `sub`) — maps to users.auth_user_id. */
  authUserId: string;
  email: string;
}

export interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
}

/** Parameter decorator exposing the verified JWT identity of the caller. */
export const CurrentAuthUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().authUser,
);
