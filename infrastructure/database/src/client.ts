import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.js";

export type EvaPrismaClient = PrismaClient;

/**
 * Prisma 7 uses driver adapters (no bundled query engine); every consumer
 * gets a client from this factory so the adapter wiring lives in one place.
 */
export function createPrismaClient(connectionString: string): EvaPrismaClient {
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}
