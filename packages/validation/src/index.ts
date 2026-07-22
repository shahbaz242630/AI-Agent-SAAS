import { z } from "zod";
import type { HealthResponse } from "@eva/types";

/**
 * Shared zod schemas (BRD Section 8). Schemas that validate cross-boundary
 * payloads live here so web, api and worker validate identically.
 */

/** Validates a GET /health payload from any platform service. */
export const healthResponseSchema: z.ZodType<HealthResponse> = z.object({
  status: z.literal("ok"),
  service: z.string().min(1),
  version: z.string().min(1),
  timestamp: z.string().refine((value) => !Number.isNaN(Date.parse(value)), {
    message: "timestamp must be a parseable ISO-8601 date",
  }),
});

/** POST /organisations payload (Slice 0.3). */
export const createOrganisationRequestSchema = z.object({
  name: z.string().trim().min(1).max(200),
});

export type CreateOrganisationRequest = z.infer<typeof createOrganisationRequestSchema>;

/** PATCH /organisations/:id/members/:userId payload (Slice 0.3). */
export const updateMemberRoleRequestSchema = z.object({
  roleKey: z.string().min(1),
});

export type UpdateMemberRoleRequest = z.infer<typeof updateMemberRoleRequestSchema>;
