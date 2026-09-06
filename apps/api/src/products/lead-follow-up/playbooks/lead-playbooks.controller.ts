import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Put,
} from "@nestjs/common";
import type {
  LeadPlaybookBuiltKey,
  LeadPlaybookDto,
  LeadPlaybooksDto,
  LeadPlaybookWordingDto,
  ReplyChannel,
} from "@eva/types";
import {
  leadPlaybookKeyParamSchema,
  replyChannelParamSchema,
  saveLeadPlaybookWordingSchema,
  updateLeadPlaybookSchema,
  type SaveLeadPlaybookWordingInput,
  type UpdateLeadPlaybookInput,
} from "@eva/validation";
import { ZodValidationPipe } from "../../../common/validation/zod-validation.pipe.js";
import {
  CurrentAuthUser,
  type AuthUser,
} from "../../../platform/authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { LeadPlaybooksService } from "./lead-playbooks.service.js";
import { OwnedBy } from "../../../common/monitoring/owner.js";

/**
 * The cards on the Automations screen (slice 3.5a).
 * Cross-tenant access is always 404, never 403 (BRD 15).
 *
 * ⚠️ THE CARD AND THE CHANNEL ARE VALIDATED IN THE PATH. A key the database
 * admits but nothing runs, or a channel Eva cannot reply on, is a 400 here
 * rather than a row that a screen cannot render.
 */
@Controller("organisations/:organisationId/lead-playbooks")
@OwnedBy("product:lead-follow-up")
export class LeadPlaybooksController {
  constructor(private readonly playbooks: LeadPlaybooksService) {}

  @Get()
  list(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<LeadPlaybooksDto> {
    return this.playbooks.list(authUser, organisationId);
  }

  @Patch(":key")
  setEnabled(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("key", new ZodValidationPipe(leadPlaybookKeyParamSchema)) key: LeadPlaybookBuiltKey,
    @Body(new ZodValidationPipe(updateLeadPlaybookSchema)) body: UpdateLeadPlaybookInput,
  ): Promise<LeadPlaybookDto> {
    return this.playbooks.setEnabled(authUser, organisationId, key, body);
  }

  @Put(":key/wordings/:channel")
  saveWording(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("key", new ZodValidationPipe(leadPlaybookKeyParamSchema)) key: LeadPlaybookBuiltKey,
    @Param("channel", new ZodValidationPipe(replyChannelParamSchema)) channel: ReplyChannel,
    @Body(new ZodValidationPipe(saveLeadPlaybookWordingSchema)) body: SaveLeadPlaybookWordingInput,
  ): Promise<LeadPlaybookWordingDto> {
    return this.playbooks.saveWording(authUser, organisationId, key, channel, body);
  }

  /** 204, and the row is soft-deleted — a wording Eva has already sent from
   *  must stay readable to the reply record that points at it (3.1c-3). */
  @Delete(":key/wordings/:channel")
  @HttpCode(204)
  clearWording(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("key", new ZodValidationPipe(leadPlaybookKeyParamSchema)) key: LeadPlaybookBuiltKey,
    @Param("channel", new ZodValidationPipe(replyChannelParamSchema)) channel: ReplyChannel,
  ): Promise<void> {
    return this.playbooks.clearWording(authUser, organisationId, key, channel);
  }
}
