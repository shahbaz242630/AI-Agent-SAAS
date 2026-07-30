import { Controller, Get, Param, ParseUUIDPipe } from "@nestjs/common";
import type { MailboxStatusDto } from "@eva/types";
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
}
