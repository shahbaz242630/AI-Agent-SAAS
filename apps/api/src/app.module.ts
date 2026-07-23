import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { LoggerModule } from "nestjs-pino";
import { ApiConfigModule } from "./config/config.module.js";
import { DatabaseModule } from "./common/database/database.module.js";
import { AuthenticationModule } from "./modules/authentication/authentication.module.js";
import { MonitoringModule } from "./modules/monitoring/monitoring.module.js";
import { OrganisationsModule } from "./modules/organisations/organisations.module.js";
import { UsersModule } from "./modules/users/users.module.js";
import { LOG_REDACT_PATHS } from "./common/logging/log-redaction.js";
import { GlobalExceptionFilter } from "./common/filters/global-exception.filter.js";
import { ERROR_REPORTER } from "./common/monitoring/error-reporter.js";
import { sentryErrorReporter } from "./common/monitoring/sentry.js";

@Module({
  imports: [
    ApiConfigModule,
    DatabaseModule,
    // Global rate limiting (BRD 13): 100 requests/minute per client, generous
    // enough for legit UI bursts; burst behaviour documented in rate-limit.spec.
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 100 }]),
    AuthenticationModule,
    UsersModule,
    OrganisationsModule,
    LoggerModule.forRoot({
      pinoHttp: {
        level: process.env.LOG_LEVEL ?? "info",
        // Correlation IDs: honour an inbound header, else generate (BRD 14).
        genReqId: (req, res) => {
          const header = req.headers["x-correlation-id"];
          const id = typeof header === "string" && header.length > 0 ? header : crypto.randomUUID();
          res.setHeader("x-correlation-id", id);
          return id;
        },
        // Never log credentials or personal contact details (BRD 14 — no tokens in logs).
        redact: LOG_REDACT_PATHS,
        ...(process.env.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
      },
    }),
    MonitoringModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: ERROR_REPORTER, useValue: sentryErrorReporter },
  ],
})
export class AppModule {}
