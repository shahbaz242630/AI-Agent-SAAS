import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
// Value import is intentional: NestJS DI reads design:paramtypes metadata,
// which requires the class reference at runtime (not a type-only import).
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { PinoLogger } from "nestjs-pino";
import { OwnedBy } from "../../../common/monitoring/owner.js";
import { Public } from "../../../platform/authentication/public.decorator.js";
import { API_ENV } from "../../../config/config.module.js";
import type { ApiEnv } from "../../../config/env.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import {
  MetaInboundIntakeService,
  type ChannelIntakeOutcome,
} from "./meta-inbound-intake.service.js";
import { MetaWebhookGuard } from "./meta-webhook.guard.js";
import { verifySubscriptionHandshake } from "./meta-signature.js";

/**
 * Where a WhatsApp message actually arrives (slice 3.2c, ruling 62).
 *
 * ⚠️ NOT ORGANISATION-SCOPED, AND IT CANNOT BE — the same shape as the Resend
 * door. Meta knows nothing about our tenants; the organisation is DISCOVERED
 * from the number the message was sent to, and `MetaWebhookGuard` is what
 * makes that discovery trustworthy.
 *
 * One URL, two verbs, because that is how Meta's subscription works: it GETs
 * the URL once with a challenge to prove we own it, then POSTs every event to
 * the same URL. Messenger and Instagram will land on this same route on the
 * same app; only the `object` in the body differs.
 */
@Controller("integrations/meta")
@OwnedBy("capability:messaging")
export class MetaWebhookController {
  constructor(
    @Inject(API_ENV) private readonly env: ApiEnv,
    private readonly intake: MetaInboundIntakeService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(MetaWebhookController.name);
  }

  /**
   * `GET /integrations/meta/webhook` — the subscription handshake.
   *
   * ⚠️ META RE-SENDS THIS EVERY TIME THE CALLBACK URL OR VERIFY TOKEN IS EDITED,
   * not only at setup, and marks the endpoint unverified if it ever stops
   * answering — after which nothing is delivered and nothing on our side says
   * so. Keep it boring.
   *
   * ⚠️ THE CHALLENGE IS ECHOED VERBATIM AS THE BODY. Not JSON, not quoted:
   * Meta compares the response body byte for byte to the string it sent, so
   * `{"challenge":"…"}` fails verification while looking entirely reasonable.
   * Hence `text/plain` and a bare string.
   *
   * ⚠️ AND IT IS A REFLECTED VALUE ON A PUBLIC ROUTE. Two defences, because
   * CodeQL flagged exactly this line (`js/reflected-xss`): the challenge is
   * only echoed if `verifySubscriptionHandshake` found it to be a plain token
   * (Meta's is a random integer), and `nosniff` stops a browser second-guessing
   * the plain-text content type. A challenge carrying markup is refused, not
   * escaped — Meta never sends one, so there is nothing legitimate to lose.
   */
  @Get("webhook")
  @Public()
  @Header("Content-Type", "text/plain; charset=utf-8")
  @Header("X-Content-Type-Options", "nosniff")
  handshake(@Query() query: Record<string, string | string[] | undefined>): string {
    const result = verifySubscriptionHandshake(this.env.WHATSAPP_VERIFY_TOKEN, {
      mode: single(query["hub.mode"]),
      token: single(query["hub.verify_token"]),
      challenge: single(query["hub.challenge"]),
    });
    if (!result.ok) {
      // The reason, never the token: this route is public.
      this.logger.warn({ reason: result.reason }, "refused a Meta webhook verification handshake");
      throw new ForbiddenException("Webhook verification failed");
    }
    return result.challenge;
  }

  /**
   * `POST /integrations/meta/webhook` — every event Meta delivers.
   *
   * ⚠️ NO VALIDATION PIPE, DELIBERATELY. A 400 tells Meta to retry for seven
   * days, so a payload field we have not seen before would be redelivered
   * hundreds of times and stored never. The intake reads what it needs and
   * answers 200 to everything it has decided about.
   *
   * ⚠️ THE THROTTLE IS GENEROUS ON PURPOSE. Meta batches up to a thousand
   * events per POST and retries anything throttled; the signature is the
   * gate, the throttle is only a backstop.
   */
  @Post("webhook")
  @Public()
  @UseGuards(MetaWebhookGuard)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @HttpCode(200)
  async receive(@Body() payload: unknown): Promise<ChannelIntakeOutcome> {
    return this.intake.receive(payload);
  }
}

/** Express hands a repeated query key over as an array; Meta never repeats one. */
function single(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return typeof value[0] === "string" ? value[0] : null;
  return typeof value === "string" ? value : null;
}
