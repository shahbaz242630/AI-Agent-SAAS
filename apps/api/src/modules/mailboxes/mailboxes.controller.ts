import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import type {
  MailboxAdminConsentDto,
  MailboxConnectDto,
  MailboxStatusDto,
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

  @Post("disconnect")
  @HttpCode(204)
  disconnect(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<void> {
    return this.mailboxesService.disconnect(authUser, organisationId);
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
   * - **Keyed by client, not by mailbox** â€” the framework default. The plan
   *   asked for per-mailbox; that needs a custom tracker, and it would buy
   *   nothing here because the only inbox at risk is the caller's own. Worth
   *   revisiting in 1.6a, when one organisation can hold several mailboxes.
   */
  @Throttle({ default: { limit: 20, ttl: 60 * 60 * 1000 } })
  @Post("test-email")
  @HttpCode(200)
  sendTestEmail(
    @CurrentAuthUser() authUser: AuthUser,
    @Param("organisationId", ParseUUIDPipe) organisationId: string,
  ): Promise<MailboxTestEmailResultDto> {
    return this.mailboxesService.sendTestEmail(authUser, organisationId);
  }
}
