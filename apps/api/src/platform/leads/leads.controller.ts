import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { createLeadRequestSchema, type CreateLeadRequest } from "@eva/validation";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import { OwnedBy } from "../../common/monitoring/owner.js";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { LeadsService, type LeadDetail, type LeadSummary } from "./leads.service.js";

/**
 * The lead book (Slice 3.1a).
 *
 * ⚠️ NO UPDATE AND NO DELETE, DELIBERATELY. 3.1a can log an enquiry and record
 * a do-not-contact request, and those are the only two things that can happen
 * to a lead until Eva can answer one. An edit endpoint with no screen behind it
 * is a way to change a compliance record that nothing tests.
 */
@Controller("organisations/:organisationId/leads")
@OwnedBy("platform")
export class LeadsController {
  constructor(private readonly leadsService: LeadsService) {}

  @Get()
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<LeadSummary[]> {
    return this.leadsService.list(authUser, organisationId);
  }

  @Post()
  create(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Body(new ZodValidationPipe(createLeadRequestSchema)) body: CreateLeadRequest,
  ): Promise<LeadDetail> {
    return this.leadsService.create(authUser, organisationId, body);
  }

  @Get(":leadId")
  getById(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("leadId", ParseUUIDPipe) leadId: string,
  ): Promise<LeadDetail> {
    return this.leadsService.getById(authUser, organisationId, leadId);
  }

  /** BRD 4.3: actioned immediately and permanently, across every channel. */
  @Post(":leadId/do-not-contact")
  doNotContact(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("leadId", ParseUUIDPipe) leadId: string,
  ): Promise<LeadSummary> {
    return this.leadsService.doNotContact(authUser, organisationId, leadId);
  }
}
