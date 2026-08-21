import "reflect-metadata";
// Must precede all Nest imports: Sentry initialises before module evaluation.
import "./instrument.js";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { loadEnv } from "@eva/configuration";
import { apiEnvSchema } from "./config/env.js";

async function bootstrap(): Promise<void> {
  const env = loadEnv(apiEnvSchema);

  /**
   * ⚠️ `rawBody` IS LOAD-BEARING, NOT A PERFORMANCE OPTION. Slice 3.1b's inbound
   * webhook is authenticated by an HMAC over the EXACT bytes Resend sent, and
   * `JSON.stringify` of the parsed body is a different string (key order,
   * unicode escaping, whitespace). Without this, every genuine webhook is
   * rejected as forged, and the only symptom is enquiries silently not
   * arriving. `createTestApp` sets it too, so the tests cannot pass while
   * production fails.
   */
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableShutdownHooks();

  // CORS is locked to the web app origin; tightened further per environment in Slice 0.4.
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });

  await app.listen(env.PORT);
}

void bootstrap();
