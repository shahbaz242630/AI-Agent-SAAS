import { Controller, Get, Query, Redirect } from "@nestjs/common";
import { microsoftCallbackQuerySchema, type MicrosoftCallbackQuery } from "@eva/validation";
import { ZodValidationPipe } from "../../common/validation/zod-validation.pipe.js";
import { Public } from "../authentication/public.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { MailboxesService } from "./mailboxes.service.js";

/**
 * Microsoft OAuth redirect target (Slice 1.6, ruling 4). @Public: the
 * browser arrives cross-site from Microsoft with no session — the signed
 * 10-minute state JWT is the entire CSRF defence. Always 302s back to the
 * web settings page; codes are never logged here, and pino skips this route
 * entirely (app.module autoLogging.ignore).
 */
@Controller("integrations/microsoft")
export class MicrosoftOAuthController {
  constructor(private readonly mailboxesService: MailboxesService) {}

  @Get("callback")
  @Public()
  @Redirect(undefined, 302)
  async callback(
    @Query(new ZodValidationPipe(microsoftCallbackQuerySchema)) query: MicrosoftCallbackQuery,
  ): Promise<{ url: string }> {
    return { url: await this.mailboxesService.handleCallback(query) };
  }
}
