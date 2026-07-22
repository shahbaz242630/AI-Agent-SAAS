import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { createPrismaClient, type EvaPrismaClient } from "@eva/database";
import { API_ENV } from "../../config/config.module.js";
import type { ApiEnv } from "../../config/env.js";

/**
 * The single Prisma client for the API process. Connects as the eva_app
 * runtime role (NOBYPASSRLS), so every tenant query MUST go through the
 * @eva/database withTenant/withUser helpers — RLS fails closed otherwise.
 */
@Injectable()
export class PrismaService implements OnModuleDestroy {
  public readonly db: EvaPrismaClient;

  constructor(@Inject(API_ENV) env: ApiEnv) {
    this.db = createPrismaClient(env.APP_DATABASE_URL);
  }

  async onModuleDestroy(): Promise<void> {
    await this.db.$disconnect();
  }
}
