import { Module } from "@nestjs/common";
import { MetaInboundIntakeService } from "./meta/meta-inbound-intake.service.js";
import { MetaWebhookController } from "./meta/meta-webhook.controller.js";
import { MetaWebhookGuard } from "./meta/meta-webhook.guard.js";

/**
 * The messaging capability (slice 3.2c): the Meta channels, WhatsApp first.
 *
 * Machinery, never sold — the same standing as `MailboxesModule`. It receives
 * a delivery, writes it down and (since 3.3b) puts it on the spine and opens
 * the enquiry; what happens to that enquiry is a product's decision, handed
 * over through the platform's `NEW_LEAD_HANDLERS` port exactly as the mail
 * door hands its own. The port is `@Global()` at the composition root, so
 * nothing here imports it as a module.
 *
 * Messenger and Instagram arrive on the same app, the same signature and the
 * same route; they join this module, not a new one (founder ruling 65).
 */
@Module({
  controllers: [MetaWebhookController],
  providers: [MetaWebhookGuard, MetaInboundIntakeService],
  exports: [MetaInboundIntakeService],
})
export class MessagingModule {}
