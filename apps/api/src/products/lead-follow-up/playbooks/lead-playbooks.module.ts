import { Module } from "@nestjs/common";
import { MailboxesModule } from "../../../capabilities/mailbox/mailboxes.module.js";
import { MessagingModule } from "../../../capabilities/messaging/messaging.module.js";
import { UsersModule } from "../../../platform/users/users.module.js";
import { LeadPlaybooksController } from "./lead-playbooks.controller.js";
import { LeadPlaybooksService } from "./lead-playbooks.service.js";

/**
 * The cards on the Automations screen (slice 3.5a) — the successor of the
 * templates module of 3.1c-1.
 *
 * `MailboxesModule` and `MessagingModule` are here because the screen says
 * where each channel's replies leave from (ruling 89), and it asks the two
 * capabilities the same way the sender does — `resolveSendingMailbox` and
 * `resolveSendingNumber` — rather than reading their tables, which
 * `architecture.spec.ts` forbids a product to do.
 */
@Module({
  imports: [UsersModule, MailboxesModule, MessagingModule],
  controllers: [LeadPlaybooksController],
  providers: [LeadPlaybooksService],
  exports: [LeadPlaybooksService],
})
export class LeadPlaybooksModule {}
