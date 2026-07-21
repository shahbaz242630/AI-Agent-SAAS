import { Injectable } from "@nestjs/common";
import type { HealthResponse } from "@eva/types";

@Injectable()
export class HealthService {
  getHealth(): HealthResponse {
    return {
      status: "ok",
      service: "eva-api",
      version: process.env.npm_package_version ?? "0.0.0",
      timestamp: new Date().toISOString(),
    };
  }
}
