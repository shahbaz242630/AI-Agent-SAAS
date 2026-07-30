import { Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from "@nestjs/common";
import type { MailboxConnectDto, MailboxStatusDto, MailboxTestEmailResultDto } from "@eva/types";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { MailboxesService } from "./mailboxes.service.js";

/**
 * Mailbox connection management (Slice 1.6; plan §3). Cross-tenant access is
 * always 404, never 403 (BRD 15). The OAuth callback lives on
 * MicrosoftOAuthController (Task 6) — its path is not org-scoped.
 */
@Controller("organisations/:organisationId/mailbox")
export class MailboxesController {
  constructor(private readonly mailboxesService: MailboxesService) {}

  @Get()
  getMailboxStatus(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<MailboxStatusDto> {
    return this.mailboxesService.getMailboxStatus(authUser, organisationId);
  }

  // Mints a state JWT and returns a URL; it creates no resource, so 200 not
  // 201 (the repo's action-POST convention — imports/invoices controllers).
  @Post("connect")
  @HttpCode(200)
  connect(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<MailboxConnectDto> {
    return this.mailboxesService.connect(authUser, organisationId);
  }

  @Post("disconnect")
  @HttpCode(204)
  disconnect(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<void> {
    return this.mailboxesService.disconnect(authUser, organisationId);
  }

  @Post("test-email")
  @HttpCode(200)
  sendTestEmail(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<MailboxTestEmailResultDto> {
    return this.mailboxesService.sendTestEmail(authUser, organisationId);
  }
}
