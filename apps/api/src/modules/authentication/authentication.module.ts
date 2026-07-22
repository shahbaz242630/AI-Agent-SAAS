import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { JwksService } from "./jwks.service.js";
import { SupabaseAuthGuard } from "./supabase-auth.guard.js";

@Module({
  providers: [
    JwksService,
    // Registered via APP_GUARD so the guard applies application-wide;
    // @Public() opts individual endpoints out.
    { provide: APP_GUARD, useClass: SupabaseAuthGuard },
  ],
})
export class AuthenticationModule {}
