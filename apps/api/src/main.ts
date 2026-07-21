import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "nestjs-pino";
import helmet from "helmet";
import { AppModule } from "./app.module.js";
import { loadEnv } from "@eva/configuration";
import { apiEnvSchema } from "./config/env.js";

async function bootstrap(): Promise<void> {
  const env = loadEnv(apiEnvSchema);

  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.useLogger(app.get(Logger));
  app.use(helmet());
  app.enableShutdownHooks();

  // CORS is locked to the web app origin; tightened further per environment in Slice 0.4.
  app.enableCors({ origin: env.WEB_ORIGIN, credentials: true });

  await app.listen(env.PORT);
}

void bootstrap();
