import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { ApiConfigModule } from "./config/config.module.js";
import { DatabaseModule } from "./common/database/database.module.js";
import { AuthenticationModule } from "./modules/authentication/authentication.module.js";
import { MonitoringModule } from "./modules/monitoring/monitoring.module.js";
import { OrganisationsModule } from "./modules/organisations/organisations.module.js";
import { UsersModule } from "./modules/users/users.module.js";

@Module({
  imports: [
    ApiConfigModule,
    DatabaseModule,
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
        // Never log auth headers or cookies (BRD 14 — no tokens in logs).
        redact: ["req.headers.authorization", "req.headers.cookie"],
        ...(process.env.NODE_ENV === "development" ? { transport: { target: "pino-pretty" } } : {}),
      },
    }),
    MonitoringModule,
  ],
})
export class AppModule {}
