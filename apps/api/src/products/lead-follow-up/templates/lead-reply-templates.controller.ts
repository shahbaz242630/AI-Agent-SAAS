import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from "@nestjs/common";
import type { LeadReplyTemplateDto, LeadReplyTemplatesDto } from "@eva/types";
import {
  createLeadReplyTemplateSchema,
  updateLeadReplyTemplateSchema,
  type CreateLeadReplyTemplateInput,
  type UpdateLeadReplyTemplateInput,
} from "@eva/validation";
import { ZodValidationPipe } from "../../../common/validation/zod-validation.pipe.js";
import {
  CurrentAuthUser,
  type AuthUser,
} from "../../../platform/authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { LeadReplyTemplatesService } from "./lead-reply-templates.service.js";
import { OwnedBy } from "../../../common/monitoring/owner.js";

/**
 * The wordings Eva replies to enquiries with (slice 3.1c-1).
 * Cross-tenant access is always 404, never 403 (BRD 15).
 */
@Controller("organisations/:organisationId/lead-reply-templates")
@OwnedBy("product:lead-follow-up")
export class LeadReplyTemplatesController {
  constructor(private readonly templatesService: LeadReplyTemplatesService) {}

  @Get()
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<LeadReplyTemplatesDto> {
    return this.templatesService.list(authUser, organisationId);
  }

  @Post()
  create(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Body(new ZodValidationPipe(createLeadReplyTemplateSchema)) body: CreateLeadReplyTemplateInput,
  ): Promise<LeadReplyTemplateDto> {
    return this.templatesService.create(authUser, organisationId, body);
  }

  @Patch(":templateId")
  update(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("templateId", ParseUUIDPipe) templateId: string,
    @Body(new ZodValidationPipe(updateLeadReplyTemplateSchema)) body: UpdateLeadReplyTemplateInput,
  ): Promise<LeadReplyTemplateDto> {
    return this.templatesService.update(authUser, organisationId, templateId, body);
  }

  /** 204, and the row is soft-deleted — a template Eva has already sent from
   *  must stay readable to the reply record that points at it (3.1c-3). */
  @Delete(":templateId")
  @HttpCode(204)
  remove(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("templateId", ParseUUIDPipe) templateId: string,
  ): Promise<void> {
    return this.templatesService.remove(authUser, organisationId, templateId);
  }
}
