import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { correctSuppressionRequestSchema, type CorrectSuppressionRequest } from "@eva/validation";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import { OwnedBy } from "../../common/monitoring/owner.js";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { SuppressionService, type SuppressionRow } from "./suppression.service.js";

/**
 * The do-not-contact record (2026-08-21).
 *
 * ⚠️ NO DELETE, AND THERE NEVER WILL BE. Correcting an entry POSTs a new record
 * saying it was made in error; the entry underneath it stays in the log
 * forever. The runtime role holds no UPDATE or DELETE on the table either, so
 * this is not a decision a future route could quietly reverse.
 *
 * ⚠️ IT IS ORGANISATION-WIDE, WHICH IS WHY IT IS NOT UNDER A PRODUCT. A
 * do-not-contact recorded on an enquiry also stops invoice chasers to the same
 * address, so a correction reachable only from one lead would be a correction
 * nobody could find — and the entry it fixes might not have come from a lead at
 * all.
 */
@Controller("organisations/:organisationId/suppression")
@OwnedBy("platform")
export class SuppressionController {
  constructor(private readonly suppressionService: SuppressionService) {}

  @Get()
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<SuppressionRow[]> {
    return this.suppressionService.list(authUser, organisationId);
  }

  /** "This was recorded in error" — supersedes, never deletes. */
  @Post("corrections")
  correct(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Body(new ZodValidationPipe(correctSuppressionRequestSchema)) body: CorrectSuppressionRequest,
  ): Promise<{ corrected: true }> {
    return this.suppressionService.correct(authUser, organisationId, body);
  }
}
