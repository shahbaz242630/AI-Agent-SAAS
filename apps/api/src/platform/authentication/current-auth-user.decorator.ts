import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

/** Identity extracted from a verified Supabase access token. */
export interface AuthUser {
  /** Supabase auth user id (JWT `sub`) — maps to users.auth_user_id. */
  authUserId: string;
  email: string;
  /**
   * Which Supabase session this token belongs to (JWT `session_id`), naming a
   * row in Supabase's own `sessions` table. A token REFRESH keeps it; signing
   * in again opens a new session and so carries a new one. That difference is
   * what lets the idle rule tell a returning customer from a replayed session
   * (ruling 37) — see UsersService.
   *
   * ⚠️ NULL WHEN THE TOKEN DOES NOT CARRY ONE, AND THAT FAILS CLOSED. Supabase
   * lists `session_id` as a required claim, so this should not happen; if it
   * ever does, the idle check falls back to the older per-user behaviour rather
   * than treating an unknown session as a fresh sign-in.
   */
  sessionId: string | null;
}

export interface AuthenticatedRequest extends Request {
  authUser?: AuthUser;
}

/** Parameter decorator exposing the verified JWT identity of the caller. */
export const CurrentAuthUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthUser | undefined =>
    ctx.switchToHttp().getRequest<AuthenticatedRequest>().authUser,
);
