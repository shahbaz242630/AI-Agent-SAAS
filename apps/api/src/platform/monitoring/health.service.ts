import { Injectable } from "@nestjs/common";
import type { HealthResponse, ReadinessResponse } from "@eva/types";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PrismaService } from "../../common/database/prisma.service.js";

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  getHealth(): HealthResponse {
    return {
      status: "ok",
      service: "eva-api",
      version: process.env.npm_package_version ?? "0.0.0",
      timestamp: new Date().toISOString(),
    };
  }

  /** Readiness probe (BRD 14): reports dependency connectivity, never why it failed. */
  async getReadiness(): Promise<ReadinessResponse> {
    const database = await this.probeDatabase();
    return {
      status: database === "up" ? "ok" : "error",
      service: "eva-api",
      version: process.env.npm_package_version ?? "0.0.0",
      timestamp: new Date().toISOString(),
      checks: { database },
    };
  }

  private async probeDatabase(): Promise<"up" | "down"> {
    try {
      await this.prisma.db.$queryRaw`SELECT 1`;
      return "up";
    } catch {
      return "down";
    }
  }
}
