import { Inject, Injectable } from "@nestjs/common";
import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";
import { API_ENV } from "../../config/config.module.js";
import type { ApiEnv } from "../../config/env.js";

/**
 * Resolves the Supabase project's JWKS for access-token verification.
 * Isolated behind this injectable so tests can substitute a locally-generated
 * keypair (no network, no real Supabase tokens).
 */
@Injectable()
export class JwksService {
  private readonly jwks: JWTVerifyGetKey;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.jwks = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  }

  getKey(): JWTVerifyGetKey {
    return this.jwks;
  }
}
