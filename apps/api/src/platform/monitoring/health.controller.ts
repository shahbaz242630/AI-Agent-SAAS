import { Controller, Get, HttpStatus, Res } from "@nestjs/common";
import type { Response } from "express";
import type { HealthResponse, ReadinessResponse } from "@eva/types";
import { Public } from "../authentication/public.decorator.js";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { HealthService } from "./health.service.js";

@Public()
@Controller("health")
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  getHealth(): HealthResponse {
    return this.healthService.getHealth();
  }

  /** Readiness (BRD 14): 200 when dependencies are reachable, 503 otherwise. */
  @Get("ready")
  async getReadiness(@Res({ passthrough: true }) res: Response): Promise<ReadinessResponse> {
    const readiness = await this.healthService.getReadiness();
    res.status(readiness.status === "ok" ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return readiness;
  }
}
