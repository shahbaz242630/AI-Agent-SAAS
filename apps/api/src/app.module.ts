import { Module } from "@nestjs/common";
import { LoggerModule } from "nestjs-pino";
import { MonitoringModule } from "./modules/monitoring/monitoring.module.js";

@Module({
  imports: [
    LoggerModule.forRoot({
      pinoHttp: {
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
