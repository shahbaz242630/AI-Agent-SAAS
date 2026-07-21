import express from "express";
import { serve } from "inngest/express";
import { pino } from "pino";
import { loadEnv } from "@eva/configuration";
import { workerEnvSchema } from "./config/env.js";
import { inngest } from "./inngest/client.js";
import { exampleHeartbeat } from "./functions/example-heartbeat.js";

const env = loadEnv(workerEnvSchema);
const logger = pino({ level: env.LOG_LEVEL });

const app = express();
app.use(express.json());

// Inngest serve endpoint — the platform invokes durable functions through here.
app.use("/api/inngest", serve({ client: inngest, functions: [exampleHeartbeat] }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "eva-worker",
    timestamp: new Date().toISOString(),
  });
});

app.listen(env.WORKER_PORT, () => {
  logger.info({ port: env.WORKER_PORT }, "eva-worker listening");
});
