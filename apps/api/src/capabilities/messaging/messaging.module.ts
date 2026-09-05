import { Module } from "@nestjs/common";
import { MetaInboundIntakeService } from "./meta/meta-inbound-intake.service.js";
import { MetaWebhookController } from "./meta/meta-webhook.controller.js";
import { MetaWebhookGuard } from "./meta/meta-webhook.guard.js";
import { META_FETCH, WhatsAppOutboundMessage, type FetchLike } from "./meta/whatsapp-outbound.js";
import { OUTBOUND_MESSAGE } from "./outbound-message.js";
import { WhatsAppNumbersService } from "./whatsapp-numbers.service.js";

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
 * Since 3.4a it also SENDS: `OUTBOUND_MESSAGE` is the port a product delivers
 * through, and `WhatsAppNumbersService` is how a product asks which number
 * it sends from — the same two exports, for the same reasons, as the mailbox
 * module's `OUTBOUND_MAIL` and `MailboxesService`.
 *
 * Messenger and Instagram arrive on the same app, the same signature and the
 * same route; they join this module, not a new one (founder ruling 65).
 */
@Module({
  controllers: [MetaWebhookController],
  providers: [
    MetaWebhookGuard,
    MetaInboundIntakeService,
    WhatsAppNumbersService,
    /**
     * ⚠️ THE REAL `fetch`, BOUND HERE SO A SPEC CAN REPLACE IT. The sender
     * takes it by token rather than reaching for the global, because a spec
     * that proves the error mapping must never reach Meta — and a stubbed
     * global is a stub every other test in the process inherits.
     */
    {
      provide: META_FETCH,
      useValue: ((input, init) => globalThis.fetch(input, init)) as FetchLike,
    },
    { provide: OUTBOUND_MESSAGE, useClass: WhatsAppOutboundMessage },
  ],
  exports: [MetaInboundIntakeService, WhatsAppNumbersService, OUTBOUND_MESSAGE],
})
export class MessagingModule {}
