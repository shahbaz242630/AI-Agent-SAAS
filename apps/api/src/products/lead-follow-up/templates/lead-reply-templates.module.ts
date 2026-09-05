import { Module } from "@nestjs/common";
import { MailboxesModule } from "../../../capabilities/mailbox/mailboxes.module.js";
import { MessagingModule } from "../../../capabilities/messaging/messaging.module.js";
import { UsersModule } from "../../../platform/users/users.module.js";
import { LeadReplyTemplatesController } from "./lead-reply-templates.controller.js";
import { LeadReplyTemplatesService } from "./lead-reply-templates.service.js";

/**
 * The lead product's first module of its own (slice 3.1c-1).
 *
 * `MailboxesModule` and `MessagingModule` arrived with ruling 89 (2026-09-05):
 * the screen says where each channel's replies leave from, and it asks the two
 * capabilities the same way the sender does — `resolveSendingMailbox` and
 * `resolveSendingNumber` — rather than reading their tables, which
 * `architecture.spec.ts` forbids a product to do.
 */
@Module({
  imports: [UsersModule, MailboxesModule, MessagingModule],
  controllers: [LeadReplyTemplatesController],
  providers: [LeadReplyTemplatesService],
  exports: [LeadReplyTemplatesService],
})
export class LeadReplyTemplatesModule {}
