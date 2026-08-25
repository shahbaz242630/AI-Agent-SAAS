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
  options?: { timeout?: number },
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    /**
     * ⚠️ BOTH IN ONE STATEMENT, AND IT IS WORTH MORE THAN IT LOOKS. This used to
     * be two `$executeRaw` calls, i.e. two network round trips, on EVERY
     * tenant-scoped operation in the product — and this helper is the one every
     * such query passes through. Measured on production 2026-08-25: a request
     * touching no database answers in 3ms while one that does takes 140-330ms,
     * because the time goes on round trips (~10ms each), not on queries (0.024ms
     * for an indexed lookup). One `SELECT` sets both GUCs and the second trip
     * disappears.
     *
     * ⚠️ STILL `is_local = true` (the third argument), WHICH IS THE PART NOT TO
     * TOUCH. That makes it `SET LOCAL`: scoped to this transaction and discarded
     * at COMMIT, so a pooled connection can never carry one tenant's context
     * into the next request. Setting them outside a transaction, or with `false`,
     * would be a cross-tenant leak rather than an optimisation.
     */
    await tx.$executeRaw`SELECT set_config('app.current_org', ${context.organisationId}, true),
                                set_config('app.current_user', ${context.userId}, true)`;
    return fn(tx as unknown as EvaPrismaClient);
  }, options);
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
 * Inbound-mail variant: declares only the address a message was delivered to,
 * for the one read that resolves an address -> its organisation (Slice 3.1b).
 *
 * ⚠️ AN INBOUND WEBHOOK IS THE ONLY REQUEST WITH NO TENANT ATTACHED. Everything
 * else in the system arrives with a signed-in user or an organisation in the
 * path; a forwarded enquiry arrives carrying nothing but the address it was
 * sent to. Resolving THAT is what makes every subsequent query tenant-scoped,
 * so it is the same shape of problem as `withAuthIdentity` and gets the same
 * answer: a dedicated GUC, its own SELECT-only policy
 * (`inbound_address_routing`, migration 0029), failing closed when unset.
 *
 * ⚠️ THE CALLER MUST ALREADY KNOW THE ADDRESS. The policy matches one row by
 * exact address, so this cannot enumerate addresses, cannot walk from one
 * organisation to another, and returns nothing at all when the context is
 * missing. Do not widen it into a general "look up any address" helper.
 */
export async function withInboundAddress<T>(
  prisma: EvaPrismaClient,
  address: string,
  fn: (tx: EvaPrismaClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_inbound_address', ${address}, true)`;
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
