import type { EvaPrismaClient } from "./client.js";

export interface TenantContext {
  organisationId: string;
  userId: string;
}

/**
 * App-layer tenant isolation (BRD 9.4/15) — the first of the two enforced
 * layers. Runs `fn` inside a transaction with the tenant context declared to
 * Postgres via set_config(..., true) (= SET LOCAL: pool-safe, never leaks
 * across pooled connections). The RLS policies from migration
 * 20260722170433 then enforce the SAME boundary at the database layer, so a
 * service bug cannot leak another tenant's rows.
 *
 * Every tenant-owned query in the API goes through this helper.
 */
export async function withTenant<T>(
  prisma: EvaPrismaClient,
  context: TenantContext,
  fn: (tx: EvaPrismaClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_org', ${context.organisationId}, true)`;
    await tx.$executeRaw`SELECT set_config('app.current_user', ${context.userId}, true)`;
    return fn(tx as unknown as EvaPrismaClient);
  });
}

/**
 * First-login variant: declares only the Supabase AUTH user id, for the one
 * read that resolves auth_user_id -> users.id before any app-user context
 * exists. Backed by the SELECT-only `auth_user_resolution` policy (migration
 * 20260722173000); fails closed like every other context.
 */
export async function withAuthIdentity<T>(
  prisma: EvaPrismaClient,
  authUserId: string,
  fn: (tx: EvaPrismaClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_auth_user', ${authUserId}, true)`;
    return fn(tx as unknown as EvaPrismaClient);
  });
}

/**
 * Login-path variant: declares only the user, for resolving "which
 * organisations am I a member of" before a tenant is chosen.
 */
export async function withUser<T>(
  prisma: EvaPrismaClient,
  userId: string,
  fn: (tx: EvaPrismaClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_user', ${userId}, true)`;
    return fn(tx as unknown as EvaPrismaClient);
  });
}
