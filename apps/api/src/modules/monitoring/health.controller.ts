import { Controller, Get } from "@nestjs/common";
import type { HealthResponse } from "@eva/types";
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
}
