import { Global, Module } from "@nestjs/common";
import { loadEnv } from "@eva/configuration";
import { apiEnvSchema } from "./env.js";

/** Injection token for the validated API environment (overridable in tests). */
export const API_ENV = "API_ENV";

@Global()
@Module({
  providers: [{ provide: API_ENV, useFactory: () => loadEnv(apiEnvSchema) }],
  exports: [API_ENV],
})
export class ApiConfigModule {}
