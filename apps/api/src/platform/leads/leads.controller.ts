import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import type { Response } from "express";
import {
  createLeadRequestSchema,
  leadExportQuerySchema,
  leadListQuerySchema,
  leadTimelineQuerySchema,
  type CreateLeadRequest,
  type LeadExportQuery,
  type LeadListQuery,
  type LeadTimelineQuery,
} from "@eva/validation";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import { OwnedBy } from "../../common/monitoring/owner.js";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  LeadsService,
  type LeadBook,
  type LeadDetail,
  type LeadSummary,
  type TimelinePage,
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

  /** The book: a page, filtered and searched, with the counts its tabs need. */
  @Get()
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Query(new ZodValidationPipe(leadListQuerySchema)) query: LeadListQuery,
  ): Promise<LeadBook> {
    return this.leadsService.list(authUser, organisationId, query);
  }

  /**
   * The same book as a file (founder, 2026-09-05).
   *
   * ⚠️ DECLARED BEFORE `:leadId`. Nest matches routes in declaration order,
   * and "export.csv" would otherwise reach `getById`, whose UUID pipe would
   * answer 400 — a download that fails with "leadId must be a UUID".
   */
  @Get("export.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @Header("Cache-Control", "no-store")
  async exportCsv(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Query(new ZodValidationPipe(leadExportQuerySchema)) query: LeadExportQuery,
    @Res({ passthrough: true }) res: Response,
  ): Promise<string> {
    const { csv, filename } = await this.leadsService.exportCsv(authUser, organisationId, query);
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    return csv;
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
   * Everything exchanged with the person behind this enquiry, newest first,
   * a page at a time (slice 3.3c; paged since ruling 81) — the
   * `person_timeline` view, through the lead.
   */
  @Get(":leadId/timeline")
  timeline(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("leadId", ParseUUIDPipe) leadId: string,
    @Query(new ZodValidationPipe(leadTimelineQuerySchema)) query: LeadTimelineQuery,
  ): Promise<TimelinePage> {
    return this.leadsService.timeline(authUser, organisationId, leadId, query);
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
