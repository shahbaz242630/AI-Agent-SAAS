import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { OwnedBy } from "../../../common/monitoring/owner.js";
import { Public } from "../../../platform/authentication/public.decorator.js";
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import { InboundIntakeService } from "./inbound-intake.service.js";
import { ResendWebhookGuard } from "./resend-webhook.guard.js";
import type { InboundWebhookPayload } from "./received-mail.js";

/**
 * Where a forwarded enquiry actually arrives (Slice 3.1b, ruling 29).
 *
 * ⚠️ NOT ORGANISATION-SCOPED, AND IT CANNOT BE. Every other route in the system
 * names its organisation in the path and proves membership before doing
 * anything. A webhook cannot: the caller is a mail service that knows nothing
 * about our tenants. The organisation is DISCOVERED, from the address the mail
 * was delivered to, and `ResendWebhookGuard` is what makes that discovery
 * trustworthy.
 *
 * ⚠️ WHAT THE STATUS CODE MEANS TO RESEND IS PART OF THE DESIGN. A 2xx means
 * "settled, never send this again". Anything else means "we will try again".
 * So everything we have deliberately decided about — a duplicate, a message for
 * a product the customer no longer holds, mail to an address nobody owns — is a
 * 200, and only a genuine fault is allowed to be a 5xx. Getting that backwards
 * either loses enquiries or produces them twice.
 */
@Controller("integrations/resend")
@OwnedBy("capability:mailbox")
export class InboundWebhookController {
  constructor(private readonly intake: InboundIntakeService) {}

  /**
   * `POST /integrations/resend/inbound` — Resend's `email.received`.
   *
   * ⚠️ THE THROTTLE IS GENEROUS ON PURPOSE. The global limit is 100 a minute,
   * which a burst of forwarded mail can reach — and a throttled webhook is a
   * 429, which Resend reads as "try again", so the mail is not lost but every
   * retry lands on the same limit. The signature is the gate here; the throttle
   * is only a backstop against somebody hammering an unauthenticated route.
   */
  @Post("inbound")
  @Public()
  @UseGuards(ResendWebhookGuard)
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @HttpCode(200)
  async inbound(@Body() payload: InboundWebhookPayload): Promise<{ status: string }> {
    /**
     * ⚠️ NO ZOD PIPE HERE, DELIBERATELY. A validation pipe answers 400 on a
     * shape it does not recognise, and 400 tells Resend to stop trying — so a
     * payload field we have not seen before would silently discard real
     * enquiries. The service reads the fields it needs and decides for itself;
     * anything it cannot route is recorded as such rather than refused.
     */
    const outcome = await this.intake.receive(payload);
    return { status: outcome.status };
  }
}
