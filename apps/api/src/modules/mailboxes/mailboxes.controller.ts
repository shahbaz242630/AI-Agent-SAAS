import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type {
  MailboxAdminConsentDto,
  MailboxConnectDto,
  MailboxListDto,
  MailboxTestEmailResultDto,
} from "@eva/types";
import { mailboxConnectSchema, type MailboxConnectInput } from "@eva/validation";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import { CurrentAuthUser, type AuthUser } from "../authentication/current-auth-user.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { MailboxesService } from "./mailboxes.service.js";

/**
 * Mailbox connection management (Slice 1.6; plan §3). Cross-tenant access is
 * always 404, never 403 (BRD 15). The OAuth callback lives on
 * MicrosoftOAuthController (Task 6) — its path is not org-scoped.
 *
 * Slice 1.6a made these routes mailbox-ADDRESSED: an organisation may hold as
 * many mailboxes as it has seats, so "the" mailbox no longer identifies
 * anything. A clean break rather than a compatibility shim — nothing outside
 * our own web app consumes these.
 */
@Controller("organisations/:organisationId/mailboxes")
export class MailboxesController {
  constructor(private readonly mailboxesService: MailboxesService) {}

  @Get()
  listMailboxes(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<MailboxListDto> {
    return this.mailboxesService.listMailboxes(authUser, organisationId);
  }

  // Mints a state JWT and returns a URL; it creates no resource, so 200 not
  // 201 (the repo's action-POST convention — imports/invoices controllers).
  @Post("connect")
  @HttpCode(200)
  connect(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Body(new ZodValidationPipe(mailboxConnectSchema)) body: MailboxConnectInput,
  ): Promise<MailboxConnectDto> {
    return this.mailboxesService.connect(authUser, organisationId, body);
  }

  /** The administrator half of a declined connection (defect F1). Read-only —
   *  it mints an approval link, it does not change anything. */
  @Get("admin-consent")
  getAdminConsent(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Query("email") email?: string,
  ): Promise<MailboxAdminConsentDto> {
    return this.mailboxesService.getAdminConsent(authUser, organisationId, email);
  }

  @Post(":mailboxId/disconnect")
  @HttpCode(204)
  disconnect(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("mailboxId", ParseUUIDPipe) mailboxId: string,
  ): Promise<void> {
    return this.mailboxesService.disconnect(authUser, organisationId, mailboxId);
  }

  /** Which mailbox slice 1.7 sends from. */
  @Put(":mailboxId/primary")
  setPrimary(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("mailboxId", ParseUUIDPipe) mailboxId: string,
  ): Promise<MailboxListDto> {
    return this.mailboxesService.setPrimary(authUser, organisationId, mailboxId);
  }

  /**
   * Tighter than the global 100/min because this one reaches out to Microsoft
   * and puts mail in a real mailbox.
   *
   * Tidiness rather than a security control: the send is strictly
   * self-addressed (ruling 7), so a flood can only fill the sender's own inbox
   * and cannot be aimed at anybody else. Two consequences of that, both
   * deliberate:
   *
   * - **Twenty, not "a handful".** The person pressing this repeatedly is
   *   almost always someone whose mailbox is misbehaving, which is exactly when
   *   locking them out is least helpful. It needs to stop a runaway loop, not
   *   ration legitimate diagnosis.
   * - **Keyed by client, not by mailbox** â€” the framework default. Revisited
   *   in 1.6a now that an organisation can hold several mailboxes, and left
   *   as it is on purpose: every send is still strictly self-addressed, so the
   *   only inbox a flood can reach is the caller's own whichever mailbox it
   *   goes through. Per-mailbox keying would need a custom tracker to buy
   *   nothing.
   */
  @Throttle({ default: { limit: 20, ttl: 60 * 60 * 1000 } })
  @Post(":mailboxId/test-email")
  @HttpCode(200)
  sendTestEmail(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
    @Param("mailboxId", ParseUUIDPipe) mailboxId: string,
  ): Promise<MailboxTestEmailResultDto> {
    return this.mailboxesService.sendTestEmail(authUser, organisationId, mailboxId);
  }
}
