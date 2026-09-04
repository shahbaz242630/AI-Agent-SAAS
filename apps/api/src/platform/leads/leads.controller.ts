import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import { createLeadRequestSchema, type CreateLeadRequest } from "@eva/validation";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import { OwnedBy } from "../../common/monitoring/owner.js";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  LeadsService,
  type LeadDetail,
  type LeadSummary,
  type TimelineItem,
} from "./leads.service.js";

/**
 * The lead book (Slice 3.1a).
 *
 * ⚠️ NO UPDATE AND NO DELETE, DELIBERATELY. A lead can be created and it can be
 * marked do-not-contact, and those are the only two things that can happen to
 * one until Eva can answer it. An edit endpoint with no screen behind it is a
 * way to change a compliance record that nothing tests.
 *
 * ⚠️ `POST` HAS NO SCREEN BEHIND IT EITHER, SINCE 2026-08-21, AND THAT IS ON
 * PURPOSE. The manual "Log an enquiry" form was removed with the three
 * call-shaped sources it offered — founder ruling: Lead Follow-up is
 * one mailbox in and a reply out, so an enquiry arrives by email or not at all.
 * The route stays because 3.1b's mailbox poller needs exactly this
 * lead-plus-evidence-plus-audit transaction, and because it is what proves that
 * transaction works before the poller exists. It now accepts `email_enquiry`
 * and nothing else, so it cannot be used to smuggle a phone lead back in.
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

  /**
   * Everything exchanged with the person behind this enquiry, oldest first
   * (slice 3.3c) — the `person_timeline` view, through the lead.
   */
  @Get(":leadId/timeline")
  timeline(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("leadId", ParseUUIDPipe) leadId: string,
  ): Promise<TimelineItem[]> {
    return this.leadsService.timeline(authUser, organisationId, leadId);
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
