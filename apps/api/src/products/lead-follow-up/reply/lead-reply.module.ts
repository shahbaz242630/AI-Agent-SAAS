import { Module } from "@nestjs/common";
import { MailboxesModule } from "../../../capabilities/mailbox/mailboxes.module.js";
import { MessagingModule } from "../../../capabilities/messaging/messaging.module.js";
import { ReplyDecisionModule } from "../decision/reply-decision.module.js";
import { LeadReplyService } from "./lead-reply.service.js";
import { ReplyToNewLeadHandler } from "./reply-to-new-lead.handler.js";

/**
 * Answering an enquiry (slice 3.1c-3; on WhatsApp since 3.4a).
 *
 * ⚠️ THE `MailboxesModule` IMPORT IS THE ONE 3.1c-1's MODULE SAID WOULD ARRIVE
 * HERE. Its comment read: *"No `MailboxesModule` yet: this slice stores words,
 * it does not send them. That import arrives with 3.1c-3, alongside
 * `resolveSendingMailbox`."* This is that slice. `MessagingModule` arrived the
 * same way with 3.4a, alongside `resolveSendingNumber` and `OUTBOUND_MESSAGE`.
 *
 * ⚠️ A PRODUCT IMPORTING A CAPABILITY IS THE ARROW POINTING THE RIGHT WAY.
 * Products may use machinery they pay for; the capability must never import the
 * product. `pnpm boundaries` enforces the direction, and it is why the reply
 * lives here rather than inside either capability where the send code is.
 */
@Module({
  imports: [MailboxesModule, MessagingModule, ReplyDecisionModule],
  providers: [LeadReplyService, ReplyToNewLeadHandler],
  /**
   * ⚠️ THE HANDLER IS EXPORTED SO `app.module.ts` CAN HAND IT TO THE
   * MAILBOX CAPABILITY. That is the only reason it leaves this module, and
   * it is the whole of the product's connection to intake.
   */
  exports: [LeadReplyService, ReplyToNewLeadHandler],
})
export class LeadReplyModule {}
