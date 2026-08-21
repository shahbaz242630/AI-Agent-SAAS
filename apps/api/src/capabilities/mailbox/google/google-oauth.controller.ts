import { Controller, Get, Query, Redirect } from "@nestjs/common";
import { microsoftCallbackQuerySchema, type MicrosoftCallbackQuery } from "@eva/validation";
import { ZodValidationPipe } from "../../../common/validation/zod-validation.pipe.js";
import { Public } from "../../../platform/authentication/public.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { MailboxesService } from "../mailboxes.service.js";
import { OwnedBy } from "../../../common/monitoring/owner.js";

/**
 * Google OAuth redirect target (Slice 3.1b step 3). `@Public` for the same
 * reason as Microsoft's: the browser arrives cross-site from Google with no
 * session, and the signed state JWT is the entire CSRF defence.
 *
 * ⚠️ ITS OWN ROUTE RATHER THAN A SHARED ONE, AND NOT BY ACCIDENT. A redirect
 * URI has to be registered with the provider, exactly, in advance — Google's is
 * configured in the Cloud console and Microsoft's in Entra. Sharing one path
 * would mean the route guessing which provider had just replied, from a query
 * string the provider controls. The path IS the answer, and it cannot be
 * spoofed into being the other one.
 *
 * It also means Microsoft's registered URI never moves, which the 3.0 handoff
 * is explicit about.
 */
@Controller("integrations/google")
@OwnedBy("capability:mailbox")
export class GoogleOAuthController {
  constructor(private readonly mailboxesService: MailboxesService) {}

  /**
   * ⚠️ THE MICROSOFT QUERY SCHEMA, REUSED DELIBERATELY. Both providers return
   * the same OAuth 2.0 fields — `code`, `state`, `error`, `error_description` —
   * because that is what the specification says, not because they agreed. The
   * two Microsoft-only extras (`admin_consent`, `tenant`) are simply absent
   * from Google's redirect and parse as undefined.
   *
   * A second identical schema would be a copy to keep in step for no gain. If
   * the two ever genuinely diverge, split it then; the name is the only thing
   * wrong with it today, and renaming it is a change to Microsoft's route.
   */
  @Get("callback")
  @Public()
  @Redirect(undefined, 302)
  async callback(
    @Query(new ZodValidationPipe(microsoftCallbackQuerySchema)) query: MicrosoftCallbackQuery,
  ): Promise<{ url: string }> {
    return { url: await this.mailboxesService.handleCallback(query, "google") };
  }
}
